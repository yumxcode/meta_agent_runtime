import { collectRefs, evaluate, parse, type Ast, type Value } from '../../expr/Expr.js'
import type { CapabilityRegistry, FunctionProvider } from '../registry/CapabilityRegistry.js'
import type { JsonValue, ValueExpression } from '../spec/GraphTypes.js'
import { cloneJson, readPath } from './GraphJson.js'

export interface GraphEvaluationContext {
  state: Readonly<Record<string, JsonValue>>
  input?: Readonly<Record<string, JsonValue>>
  output?: JsonValue
  clock?: Readonly<Record<string, JsonValue>>
}

export interface CompiledCondition {
  source: string
  normalized: string
  ast: Ast
  refs: string[]
}

export function compileCondition(source: string): CompiledCondition {
  // Strip the sigil for parsing every identifier root. GraphValidate then
  // reports unsupported roots explicitly instead of leaking a lexer error.
  const normalized = source.replace(/\$([A-Za-z][A-Za-z0-9_]*)(?=\.|\b)/g, '$1')
  const ast = parse(normalized)
  return { source, normalized, ast, refs: collectRefs(ast) }
}

export function evaluateCondition(compiled: CompiledCondition, context: GraphEvaluationContext): boolean {
  const flat: Record<string, Value> = {}
  flattenPrimitives('state', context.state, flat)
  if (context.input) flattenPrimitives('input', context.input, flat)
  if (context.output !== undefined) flattenPrimitives('output', context.output, flat)
  if (context.clock) flattenPrimitives('clock', context.clock, flat)
  // Optional output fields are legitimate routing inputs. A missing field means
  // this edge does not match; type/operator errors remain invariant failures.
  if (compiled.refs.some(ref => !Object.prototype.hasOwnProperty.call(flat, ref))) return false
  const result = evaluate(compiled.ast, flat)
  if (typeof result !== 'boolean') throw new Error(`condition '${compiled.source}' returned ${typeof result}, expected boolean`)
  return result
}

export async function evaluateValueExpression(
  expression: ValueExpression,
  context: GraphEvaluationContext,
  functions: CapabilityRegistry<FunctionProvider>,
  depth = 0,
): Promise<JsonValue> {
  if (depth > 20) throw new Error('value expression nesting exceeds 20')
  if ('literal' in expression) return cloneJson(expression.literal)
  if ('ref' in expression) return resolveReference(expression.ref, context)
  const args: JsonValue[] = []
  for (const arg of expression.args ?? []) args.push(await evaluateValueExpression(arg, context, functions, depth + 1))
  const output = await functions.get(expression.call).execute(args)
  return cloneJson(output)
}

export async function evaluateBindings(
  bindings: Readonly<Record<string, ValueExpression>> | undefined,
  context: GraphEvaluationContext,
  functions: CapabilityRegistry<FunctionProvider>,
): Promise<Record<string, JsonValue>> {
  const result: Record<string, JsonValue> = {}
  for (const [name, expression] of Object.entries(bindings ?? {})) {
    result[name] = await evaluateValueExpression(expression, context, functions)
  }
  return result
}

export function resolveReference(reference: string, context: GraphEvaluationContext): JsonValue {
  if (!reference.startsWith('$')) throw new Error(`reference '${reference}' must start with $`)
  const dot = reference.indexOf('.')
  const rootName = reference.slice(1, dot === -1 ? undefined : dot)
  const path = dot === -1 ? '' : reference.slice(dot + 1)
  const roots = context as unknown as Record<string, unknown>
  if (!(rootName in roots) || roots[rootName] === undefined) throw new Error(`reference root '$${rootName}' is unavailable`)
  return path ? readPath(roots[rootName], path) : cloneJson(roots[rootName] as JsonValue)
}

function flattenPrimitives(prefix: string, value: unknown, output: Record<string, Value>): void {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    output[prefix] = value
    return
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  for (const [key, child] of Object.entries(value)) {
    // Dot-bearing object keys are ambiguous with nested paths. They remain
    // available to ValueExpression whole-object refs, but never enter `when`.
    if (key.includes('.')) continue
    flattenPrimitives(`${prefix}.${key}`, child, output)
  }
}
