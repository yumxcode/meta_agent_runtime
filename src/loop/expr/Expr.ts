/**
 * Expr — the restricted expression DSL for charter rules (loop v2, spec §3.2 / D3).
 *
 * Charter meters/tripwires are DATA, not code: strings like
 * `"stale_count >= 2 && metric_delta < 0"` are parsed ONCE at instantiation
 * into a JSON AST (stored in the frozen charter snapshot) and evaluated by
 * this interpreter at fixed kernel steps (MODE/METER/ROUTE). There is no
 * codegen and no eval — the evaluator is a pure function over a closed value
 * domain, so a charter can be statically validated, diffed, and replayed.
 *
 * Whitelist (everything else is a parse error):
 *   literals      number, 'string', "string", true, false
 *   identifiers   dotted paths: stale_count, budget.lifetime.exhausted
 *   operators     ! - (unary)   * /   + -   < <= > >=   == !=   &&   ||
 *   grouping      ( )
 * Explicitly rejected: function calls, indexing, assignment, regex, `?:`.
 *
 * Evaluation is STRICT about types (no truthiness coercion): logical ops need
 * booleans, arithmetic/relational need numbers, equality needs same-type
 * operands. A type mismatch at runtime throws ExprError — the kernel treats
 * that as an invariant violation, never as `false`.
 */

export type Value = number | boolean | string

export type BinaryOp =
  | '||' | '&&'
  | '==' | '!='
  | '<' | '<=' | '>' | '>='
  | '+' | '-' | '*' | '/'

export type Ast =
  | { kind: 'lit'; value: Value }
  | { kind: 'ref'; name: string }
  | { kind: 'unary'; op: '!' | '-'; operand: Ast }
  | { kind: 'binary'; op: BinaryOp; left: Ast; right: Ast }

export class ExprError extends Error {
  constructor(message: string, readonly src?: string) {
    super(src ? `${message} (in: ${src})` : message)
    this.name = 'ExprError'
  }
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'eof' }

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/
const NUM_RE = /^\d+(\.\d+)?/
// Longest-match first so '<=' wins over '<'.
const OPS = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '!'] as const

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue }
    if (ch === '(') { out.push({ t: 'lparen' }); i++; continue }
    if (ch === ')') { out.push({ t: 'rparen' }); i++; continue }
    if (ch === '\'' || ch === '"') {
      const end = src.indexOf(ch, i + 1)
      if (end === -1) throw new ExprError('unterminated string literal', src)
      out.push({ t: 'str', v: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    const num = NUM_RE.exec(src.slice(i))
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) })
      i += num[0].length
      continue
    }
    const ident = IDENT_RE.exec(src.slice(i))
    if (ident) {
      const word = ident[0]
      if (word === 'true' || word === 'false') out.push({ t: 'bool', v: word === 'true' })
      else out.push({ t: 'ident', v: word })
      i += word.length
      continue
    }
    const op = OPS.find(o => src.startsWith(o, i))
    if (op) {
      out.push({ t: 'op', v: op })
      i += op.length
      continue
    }
    // Deliberate rejections with precise messages (spec: no calls/index/ternary).
    if (ch === '[' || ch === ']') throw new ExprError('indexing is not allowed in charter expressions', src)
    if (ch === '?' || ch === ':') throw new ExprError('ternary is not allowed in charter expressions', src)
    if (ch === '=') throw new ExprError("assignment is not allowed (use '==')", src)
    throw new ExprError(`unexpected character '${ch}'`, src)
  }
  out.push({ t: 'eof' })
  return out
}

// ── Parser (precedence climbing) ──────────────────────────────────────────────

const BIN_PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6,
}

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[], private readonly src: string) {}

  parse(): Ast {
    const ast = this.expression(0)
    if (this.peek().t !== 'eof') throw new ExprError('unexpected trailing tokens', this.src)
    return ast
  }

  private peek(): Token { return this.tokens[this.pos]! }
  private next(): Token { return this.tokens[this.pos++]! }

  private expression(minPrec: number): Ast {
    let left = this.unary()
    for (;;) {
      const tok = this.peek()
      if (tok.t !== 'op') break
      const prec = BIN_PRECEDENCE[tok.v]
      if (prec === undefined || prec < minPrec) break
      this.next()
      const right = this.expression(prec + 1)
      left = { kind: 'binary', op: tok.v as BinaryOp, left, right }
    }
    return left
  }

  private unary(): Ast {
    const tok = this.peek()
    if (tok.t === 'op' && (tok.v === '!' || tok.v === '-')) {
      this.next()
      return { kind: 'unary', op: tok.v, operand: this.unary() }
    }
    return this.primary()
  }

  private primary(): Ast {
    const tok = this.next()
    switch (tok.t) {
      case 'num': return { kind: 'lit', value: tok.v }
      case 'str': return { kind: 'lit', value: tok.v }
      case 'bool': return { kind: 'lit', value: tok.v }
      case 'ident': {
        // Reject function-call syntax explicitly: `foo(...)` is not data.
        if (this.peek().t === 'lparen') {
          throw new ExprError(`function calls are not allowed ('${tok.v}(')`, this.src)
        }
        return { kind: 'ref', name: tok.v }
      }
      case 'lparen': {
        const inner = this.expression(0)
        if (this.next().t !== 'rparen') throw new ExprError('missing closing parenthesis', this.src)
        return inner
      }
      default:
        throw new ExprError('unexpected end of expression', this.src)
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse an expression. When `declared` is given, every identifier must be in
 * it — this is the create-time static check (D3): a charter referencing an
 * undeclared observable/meter is rejected BEFORE the loop ever runs.
 */
export function parse(src: string, declared?: ReadonlySet<string>): Ast {
  if (typeof src !== 'string' || !src.trim()) throw new ExprError('expression is empty')
  const ast = new Parser(tokenize(src), src).parse()
  if (declared) {
    const missing = collectRefs(ast).filter(name => !declared.has(name))
    if (missing.length > 0) {
      throw new ExprError(`undeclared identifier(s): ${missing.join(', ')}`, src)
    }
  }
  return ast
}

/** All identifiers referenced by an AST (deduped, declaration-order). */
export function collectRefs(ast: Ast): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (node: Ast): void => {
    switch (node.kind) {
      case 'ref':
        if (!seen.has(node.name)) { seen.add(node.name); out.push(node.name) }
        return
      case 'unary': walk(node.operand); return
      case 'binary': walk(node.left); walk(node.right); return
      case 'lit': return
    }
  }
  walk(ast)
  return out
}

export type EvalContext = Readonly<Record<string, Value>>

/** Evaluate an AST against a context. Pure; throws ExprError on type misuse. */
export function evaluate(ast: Ast, ctx: EvalContext): Value {
  switch (ast.kind) {
    case 'lit': return ast.value
    case 'ref': {
      const v = ctx[ast.name]
      if (v === undefined) throw new ExprError(`identifier '${ast.name}' is missing from context`)
      return v
    }
    case 'unary': {
      const v = evaluate(ast.operand, ctx)
      if (ast.op === '!') {
        if (typeof v !== 'boolean') throw new ExprError(`'!' needs a boolean, got ${typeof v}`)
        return !v
      }
      if (typeof v !== 'number') throw new ExprError(`unary '-' needs a number, got ${typeof v}`)
      return -v
    }
    case 'binary': {
      const op = ast.op
      // Short-circuit logicals evaluate lazily (left first).
      if (op === '&&' || op === '||') {
        const l = evaluate(ast.left, ctx)
        if (typeof l !== 'boolean') throw new ExprError(`'${op}' needs booleans, got ${typeof l}`)
        if (op === '&&' && !l) return false
        if (op === '||' && l) return true
        const r = evaluate(ast.right, ctx)
        if (typeof r !== 'boolean') throw new ExprError(`'${op}' needs booleans, got ${typeof r}`)
        return r
      }
      const l = evaluate(ast.left, ctx)
      const r = evaluate(ast.right, ctx)
      if (op === '==' || op === '!=') {
        if (typeof l !== typeof r) {
          throw new ExprError(`'${op}' operands must share a type (${typeof l} vs ${typeof r})`)
        }
        return op === '==' ? l === r : l !== r
      }
      if (typeof l !== 'number' || typeof r !== 'number') {
        throw new ExprError(`'${op}' needs numbers (${typeof l} vs ${typeof r})`)
      }
      switch (op) {
        case '<': return l < r
        case '<=': return l <= r
        case '>': return l > r
        case '>=': return l >= r
        case '+': return l + r
        case '-': return l - r
        case '*': return l * r
        case '/': {
          if (r === 0) throw new ExprError('division by zero')
          return l / r
        }
      }
    }
  }
}

/** Convenience: evaluate expecting a boolean (tripwires / meter conditions). */
export function evaluateBool(ast: Ast, ctx: EvalContext): boolean {
  const v = evaluate(ast, ctx)
  if (typeof v !== 'boolean') throw new ExprError(`expression must yield a boolean, got ${typeof v}`)
  return v
}
