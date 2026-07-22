import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { GraphRuntimeCatalog } from '../runtime/GraphCatalog.js'
import type { LoopGraphSpec } from '../spec/GraphTypes.js'
import { freezeLoopGraph, validateLoopGraph } from '../spec/GraphValidate.js'
import {
  buildGraphImplementationManifest,
  validateConstraintLedger,
  validateGraphTraceability,
  type GraphTraceabilityMap,
  type LoopConstraintLedger,
} from './DistillDesign.js'
import { CANONICAL_GRAPH_DISTILL_EXAMPLE } from './GraphDistiller.js'

export type GraphReferenceSection = 'overview' | 'nodes' | 'workspace' | 'lanes' | 'control' | 'capabilities' | 'example'

export interface GraphDistillToolHooks {
  /** Called only after the exact candidate validated and froze successfully.
   * The host can preserve this executable draft if the model times out while
   * redundantly formatting the final metadata envelope. */
  onValidatedGraph?: (graph: LoopGraphSpec) => void
}

export function createGraphDistillTools(catalog: GraphRuntimeCatalog, hooks: GraphDistillToolHooks = {}): MetaAgentTool[] {
  const draft: { graph?: LoopGraphSpec; lastValid?: LoopGraphSpec } = {}
  return [referenceTool(catalog), validateTool(catalog, hooks, draft), patchValidateTool(catalog, hooks, draft)]
}

function referenceTool(catalog: GraphRuntimeCatalog): MetaAgentTool {
  const sections: GraphReferenceSection[] = ['overview', 'nodes', 'workspace', 'lanes', 'control', 'capabilities', 'example']
  return {
    name: 'graph_reference',
    description: 'Return one focused section of the exact durable-graph-v2 ABI or capability catalog. Use it instead of guessing fields.',
    abortSupport: 'bounded', isConcurrencySafe: true, permission: { category: 'read', planMode: 'allow' },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { section: { type: 'string', enum: sections } }, required: ['section'],
    },
    async call(input): Promise<ToolResult> {
      const section = String(input.section ?? '') as GraphReferenceSection
      if (!sections.includes(section)) return { content: `Unknown graph reference section '${section}'.`, isError: true }
      return { content: graphReference(section, catalog), isError: false }
    },
  }
}

function validateTool(
  catalog: GraphRuntimeCatalog,
  hooks: GraphDistillToolHooks,
  draft: { graph?: LoopGraphSpec; lastValid?: LoopGraphSpec },
): MetaAgentTool {
  return {
    name: 'graph_validate',
    description: 'Validate and Freeze one complete graph-2.0 candidate. Optionally validate the constraint ledger and traceability in the same call. Call this before returning.',
    abortSupport: 'bounded', isConcurrencySafe: true, permission: { category: 'read', planMode: 'allow' }, maxResultSizeChars: 48_000,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        graph: { type: 'object', additionalProperties: true },
        constraints: { type: 'object', additionalProperties: true },
        traceability: { type: 'object', additionalProperties: true },
      }, required: ['graph'],
    },
    async call(input): Promise<ToolResult> {
      try {
        if (!input.graph || typeof input.graph !== 'object' || Array.isArray(input.graph)) return result({ valid: false, frozen: false, errors: ['graph must be an object'] })
        const graph = structuredClone(input.graph) as unknown as LoopGraphSpec
        draft.graph = graph
        draft.lastValid = undefined
        const checked = validateCandidate(graph, catalog, hooks, input.constraints, input.traceability)
        if (checked.valid) draft.lastValid = structuredClone(graph)
        return checked.result
      } catch (error) {
        return result({ valid: false, frozen: false, errorCount: 1, errors: [`candidate validation could not continue: ${error instanceof Error ? error.message : String(error)}`], hint: 'Use graph_reference, repair the candidate, then call graph_validate again.' })
      }
    },
  }
}

type GraphPatchOperation = { op: 'set' | 'remove'; path: string; value?: unknown }

/** Keeps the last graph_validate candidate in tool-local memory so an ABI
 * repair changes only the reported fields. The executable graph stays simple;
 * this is merely a compact compiler scratchpad. */
function patchValidateTool(
  catalog: GraphRuntimeCatalog,
  hooks: GraphDistillToolHooks,
  draft: { graph?: LoopGraphSpec; lastValid?: LoopGraphSpec },
): MetaAgentTool {
  return {
    name: 'graph_patch_validate',
    description: 'Apply small set/remove operations to the last graph_validate candidate, then Validate and Freeze it. Use stable transition selectors such as /transitions/@id=route_id/when instead of numeric indexes. Use after validation errors instead of resending the whole graph.',
    abortSupport: 'bounded', isConcurrencySafe: false, permission: { category: 'read', planMode: 'allow' }, maxResultSizeChars: 48_000,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        operations: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              op: { type: 'string', enum: ['set', 'remove'] },
              path: { type: 'string' },
              value: {},
            },
            required: ['op', 'path'],
          },
        },
      },
      required: ['operations'],
    },
    async call(input): Promise<ToolResult> {
      try {
        if (!draft.graph) return result({ valid: false, frozen: false, errors: ['no prior graph_validate candidate; call graph_validate with one complete graph first'] })
        if (!Array.isArray(input.operations) || input.operations.length === 0) return result({ valid: false, frozen: false, errors: ['operations must be a non-empty array'] })
        const candidate = structuredClone(draft.graph) as unknown as Record<string, unknown>
        for (const raw of input.operations) applyGraphPatch(candidate, raw as GraphPatchOperation)
        const graph = candidate as unknown as LoopGraphSpec
        const checked = validateCandidate(graph, catalog, hooks)
        if (checked.valid) {
          draft.graph = graph
          draft.lastValid = structuredClone(graph)
          return checked.result
        }
        // Before the first valid candidate, incremental repairs must compose.
        // Once a valid baseline exists, a bad semantic patch is transactional:
        // roll back instead of poisoning every later repair.
        if (!draft.lastValid) {
          draft.graph = graph
          return checked.result
        }
        draft.graph = structuredClone(draft.lastValid)
        const details = JSON.parse(checked.result.content) as Record<string, unknown>
        return result({ ...details, draftRolledBackToLastValid: true })
      } catch (error) {
        return result({
          valid: false, frozen: false, errorCount: 1,
          errors: [`graph patch could not be applied: ${error instanceof Error ? error.message : String(error)}`],
          hint: 'Use paths into the last graph_validate candidate. Select transitions with /transitions/@id=<stable-id>; set with /- appends to an array.',
        })
      }
    },
  }
}

function validateCandidate(
  graph: LoopGraphSpec,
  catalog: GraphRuntimeCatalog,
  hooks: GraphDistillToolHooks,
  constraints?: unknown,
  traceability?: unknown,
): { result: ToolResult; valid: boolean } {
  const errors = validateLoopGraph(graph, catalog)
  if (constraints !== undefined || traceability !== undefined) {
    if (!constraints || typeof constraints !== 'object' || Array.isArray(constraints)) errors.push('constraints must be an object')
    else errors.push(...validateConstraintLedger(constraints as LoopConstraintLedger))
    if (!traceability || typeof traceability !== 'object' || Array.isArray(traceability)) errors.push('traceability must be an object')
    else if (constraints && typeof constraints === 'object' && !Array.isArray(constraints)) {
      errors.push(...validateGraphTraceability(traceability as GraphTraceabilityMap, constraints as LoopConstraintLedger, graph))
    }
  }
  if (errors.length) return {
    valid: false,
    result: result({
      valid: false, frozen: false, errorCount: errors.length, errors,
      repairHints: graphRepairHints(errors),
      patchSelectors: graphPatchSelectors(graph),
    }),
  }
  const frozen = freezeLoopGraph(graph, catalog, 0)
  hooks.onValidatedGraph?.(structuredClone(graph))
  return {
    valid: true,
    result: result({
      valid: true, frozen: true, graphHash: frozen.graphHash,
      summary: {
        nodes: Object.keys(graph.nodes).length,
        transitions: graph.transitions.length,
        lanes: Object.keys(graph.lanes).length,
        workspaceWrites: Object.values(graph.lanes).reduce((sum, lane) => sum + (lane.workspace.write?.length ?? 0), 0),
      },
      patchSelectors: graphPatchSelectors(graph),
      manifest: buildGraphImplementationManifest(graph),
    }),
  }
}

function applyGraphPatch(root: Record<string, unknown>, operation: GraphPatchOperation): void {
  if (!operation || (operation.op !== 'set' && operation.op !== 'remove')) throw new Error("op must be 'set' or 'remove'")
  const parts = decodeJsonPointer(operation.path)
  if (!parts.length) throw new Error('root replacement/removal is not supported')
  let parent: unknown = root
  for (const part of parts.slice(0, -1)) parent = graphPatchChild(parent, part, operation.path)
  const key = parts.at(-1)!
  if (Array.isArray(parent)) {
    if (operation.op === 'set' && key === '-') {
      parent.push(structuredClone(operation.value))
      return
    }
    const index = graphPatchArrayIndex(parent, key, operation.path, operation.op === 'set')
    if (operation.op === 'set') {
      if (index < 0 || index > parent.length) throw new Error(`array index ${index} is out of bounds`)
      if (index === parent.length) parent.push(structuredClone(operation.value))
      else parent[index] = structuredClone(operation.value)
    } else {
      if (index < 0 || index >= parent.length) throw new Error(`array index ${index} is out of bounds`)
      parent.splice(index, 1)
    }
    return
  }
  if (!parent || typeof parent !== 'object') throw new Error(`parent of '${operation.path}' is not an object`)
  const object = parent as Record<string, unknown>
  if (operation.op === 'set') object[key] = structuredClone(operation.value)
  else {
    if (!Object.prototype.hasOwnProperty.call(object, key)) throw new Error(`path '${operation.path}' does not exist`)
    delete object[key]
  }
}

function graphPatchChild(parent: unknown, key: string, path: string): unknown {
  if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`unsafe path '${path}'`)
  if (Array.isArray(parent)) {
    const index = graphPatchArrayIndex(parent, key, path, false)
    return parent[index]
  }
  if (!parent || typeof parent !== 'object' || !Object.prototype.hasOwnProperty.call(parent, key)) throw new Error(`path '${path}' does not exist`)
  return (parent as Record<string, unknown>)[key]
}

function graphPatchArrayIndex(parent: unknown[], key: string, path: string, allowEnd: boolean): number {
  if (key.startsWith('@id=')) {
    const id = key.slice(4)
    const index = parent.findIndex(value => value !== null && typeof value === 'object' && (value as { id?: unknown }).id === id)
    if (index < 0) throw new Error(`array selector '${key}' in '${path}' matched no id`)
    return index
  }
  if (!/^\d+$/.test(key)) throw new Error(`array path segment '${key}' must be a numeric index or @id=<stable-id> selector`)
  const index = Number(key)
  const upper = allowEnd ? parent.length : parent.length - 1
  if (index < 0 || index > upper) throw new Error(`array index ${index} is out of bounds`)
  return index
}

function graphPatchSelectors(graph: LoopGraphSpec): { transitions: Record<string, string> } {
  return {
    transitions: Object.fromEntries(graph.transitions.map(transition => [
      transition.id,
      `/transitions/@id=${escapeJsonPointer(transition.id)}`,
    ])),
  }
}

function escapeJsonPointer(value: string): string { return value.replace(/~/g, '~0').replace(/\//g, '~1') }

function decodeJsonPointer(path: string): string[] {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error("path must be a JSON Pointer beginning with '/'")
  return path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')).map(part => {
    if (['__proto__', 'prototype', 'constructor'].includes(part)) throw new Error(`unsafe path '${path}'`)
    return part
  })
}

function result(value: unknown): ToolResult { return { content: JSON.stringify(value, null, 2), isError: false } }

function graphRepairHints(errors: readonly string[]): string[] {
  const joined = errors.join('\n')
  const hints: string[] = []
  if (/uses unsupported root/.test(joined)) {
    hints.push("A bare enum word is parsed as a reference root. Keep the semantic enum and quote the right-hand literal exactly, e.g. $output.trend == 'worsened'; string literals are supported. Do not replace it with numeric codes or precomputed booleans.")
  }
  if (/outputSchema\.properties\..+ is not part of/.test(joined)) {
    hints.push('Keep outputSchema routing fields minimal and use only the exact Shape keys accepted by the validator; remove decorative per-property metadata reported by the error.')
  }
  if (/transitions\[\d+\]\.from must be a string|transitions\[\d+\]\.(node|inputs) is not part of/.test(joined)) {
    hints.push('Entrypoints belong only in graph.entrypoints. A Transition needs string `from` and puts the destination under `to` (including target inputs).')
  }
  if (/is strict but the source outputSchema does not require that path/.test(joined)) {
    hints.push('A target input or Reducer arg is a strict ValueExpression. Add the referenced field to the source outputSchema.required and require a schema-valid sentinel such as an empty string, or bind a literal on paths where it is absent. `null` is valid only with a ShapeSpec of type `null`; unions are not supported.')
  }
  if (/is not guaranteed for '.+' output/.test(joined)) {
    hints.push('Failure/always payloads are not validated by the success outputSchema. Bind the whole $output error payload or a literal instead of a nested $output field.')
  }
  return hints
}

export function graphReference(section: GraphReferenceSection, catalog: GraphRuntimeCatalog): string {
  if (section === 'overview') return document({
    contract: 'durable-graph-v2 source object; omit unused optional fields',
    exactSkeleton: {
      schemaVersion: 'graph-2.0', id: 'loop_id', version: 1, goal: 'goal',
      state: {}, lanes: {}, nodes: {}, transitions: [], entrypoints: [], limits: { maxTotalActivations: 100, maxLiveActivations: 4 },
    },
    optionalTopLevel: ['capabilityPacks', 'concurrency', 'annotations'],
    freezeOwned: ['capabilityLock', 'graphHash', 'frozenAt'],
    repairWorkflow: 'Call graph_validate once with the complete candidate. After any errors, use graph_patch_validate set/remove operations against its saved draft; do not resend the full graph.',
    rule: 'Unknown executable fields are rejected. Domain-only notes belong under annotations.',
  })
  if (section === 'nodes') return document({
    valueExpression: { exactForms: [{ literal: 'any JSON value' }, { ref: '$state.name' }, { call: 'function@version', args: [{ literal: 1 }] }] },
    inputDataflow: {
      strictRefs: 'Every $input.x a node reads is STRICT and must be bound by every incoming edge. Likewise, a success Transition target/update may bind $output.x only when x is required by the source outputSchema; missing optional refs are lenient only inside when conditions. Failure/always edges may bind the whole $output or literals, not assumed nested fields.',
      optionalInputIdiom: 'A value only some paths supply must be bound { "literal": null } on every other incoming edge and entrypoint; downstream treats null as absent.',
      whenIsLenient: 'Only transition `when` conditions treat a missing reference as no-match; ValueExpression refs never fall back.',
      entrypointScope: 'Entrypoint inputs may only reference $state or literals — $input/$output do not exist at instance creation.',
      functionOutput: 'A function node $output is the raw function return value. builtin/identity@1 returns the ENTIRE inputs record: with inputs {value:...} downstream must read $output.value, not $output.',
    },
    exactNodeTemplates: {
      agent: {
        type: 'agent', lane: 'lane_id', prompt: 'one bounded responsibility', inputs: { item: { ref: '$state.item' } },
        outputSchema: { type: 'object', required: ['complete'], properties: { complete: { type: 'boolean' } }, additionalProperties: false },
        tools: ['read_file'], maxAttempts: 3, budget: { turns: 20, usd: 10, wallTimeMs: 600000 },
      },
      function: { type: 'function', function: 'builtin/identity@1', inputs: { value: { ref: '$input.value' } } },
      effect: { type: 'effect', effect: 'pack/effect@1', inputs: {}, idempotencyKey: { ref: '$input.key' }, timeoutMs: 60000 },
      timerWait: { type: 'wait', wait: { kind: 'timer', delayMs: { literal: 1800000 }, maxDelayMs: 3600000 } },
      eventWait: { type: 'wait', wait: { kind: 'event', event: 'event.name', correlation: { ref: '$input.id' }, timeoutMs: 3600000 } },
      join: { type: 'join', mode: 'all', expects: ['incoming_transition_id'], timeoutMs: 3600000 },
      terminal: { type: 'terminal', status: 'done', result: { ref: '$input.result' } },
      exhaustedTerminal: { type: 'terminal', status: 'exhausted', result: { ref: '$input.result' } },
      pausedTerminal: { type: 'terminal', status: 'paused', result: { ref: '$input.result' } },
    },
    hardParkAgentMinimum: { timerPolicy: { allowHardPark: true, maxDelayMs: 3600000, maxParks: 48 } },
    optionalAgentBudgetOverrides: { budget: { turns: 20, usd: 10, wallTimeMs: 600000 }, lifetimeBudget: { turns: 200, usd: 10, elapsedMs: 86400000 } },
    rules: [
      'Prefer Agent, Wait, and Terminal. Add Function/Effect/Join only when the requirement needs them.',
      'Keep strongly coupled work in one Agent Activation.',
      "A paused terminal halts the graph until an operator runs `loop resume`; it may only have on:'resume' outgoing transitions and resumes exactly once.",
      'Never emulate waiting with sleep-style tools inside an Agent — a sleeping segment burns its budget and cannot be durably recovered. Use a wait node or agent timer hard-park.',
      'Join expects must list exactly its incoming transition ids. Add timeoutMs only when a missing branch needs a timeout route.',
    ],
  })
  if (section === 'workspace') return document({
    contract: 'Agents read and write the real project workspace directly. Kernel stores no duplicate user data.',
    exactWriteRules: [
      { path: 'state/progress.json', mode: 'atomic_replace', description: 'current status' },
      { path: 'state/findings.jsonl', mode: 'append_only', description: 'history' },
      { path: 'work', mode: 'owned', description: 'lane-owned directory' },
    ],
    modes: {
      owned: 'the Lane may create and edit anything below the path',
      atomic_replace: 'replace the declared file atomically',
      append_only: 'append records; never rewrite old content',
    },
    rules: [
      'Paths are project-relative prefixes, not globs.',
      'deny wins over read/write.',
      'Two Lanes cannot own overlapping write paths.',
      'A Lane with no write rules is read-only.',
      'There is NO writable location outside the project root: the sandbox denies every external write. Anything the loop must EDIT — including an external git work tree — must be cloned/placed INSIDE the project under a Lane write prefix and declared as a directory precondition. Never plan to "locate it at runtime".',
      'Never put absolute paths or ~ paths in Agent prompts as write targets.',
    ],
  })
  if (section === 'lanes') return document({
    exactLaneTemplates: {
      persistentWriter: { context: 'persistent', maxConcurrency: 1, workspace: { read: ['requirements.md', 'state'], write: [{ path: 'state', mode: 'owned' }], deny: ['.git'] } },
      freshReader: { context: 'fresh_per_activation', maxConcurrency: 1, workspace: { read: ['state'], write: [], deny: ['.git'] } },
      gitCommitter: { context: 'persistent', maxConcurrency: 1, scm: 'git', workspace: { read: ['src'], write: [{ path: 'src', mode: 'owned' }], deny: [] } },
    },
    sourceControl: {
      defaultProtection: 'The Kernel denies all writes to the project-root .git by default — a plain lane CANNOT git commit/push at the project root.',
      scmOptIn: "A loop whose workflow requires committing/pushing the project repo must set scm:'git' on exactly ONE lane (git index is single-writer). That lane may write .git EXCEPT .git/hooks and .git/config, which stay protected. The lane also needs at least one workspace write rule.",
      nestedRepoIdiom: 'Alternative without scm: keep a separate clone under an owned write prefix (e.g. write [{path:"vendor_repo",mode:"owned"}]); a nested vendor_repo/.git is ordinary owned content — only the project-root .git is Kernel-special.',
      review: "scm:'git' is a privilege escalation: declare it only when the source requirement actually needs version control, and say so in taskSpec.",
    },
    rules: ['Lane is conversation continuity, serialization, and workspace ownership.', 'Lane is not a business step and never creates a worktree.', 'All Agent nodes inherit the Lane workspace contract.'],
  })
  if (section === 'control') return document({
    exactTransitionTemplates: {
      conditional: { id: 'done_route', from: 'worker', on: 'success', when: '$output.done == true', priority: 100, to: { node: 'done', inputs: { result: { ref: '$output' } } } },
      stringEnumConditional: { id: 'worsened_route', from: 'worker', on: 'success', when: "$output.trend == 'worsened'", priority: 90, to: 'writer' },
      defaultWithUpdate: { id: 'continue_route', from: 'worker', on: 'success', default: true, updates: [{ target: 'iteration', reducer: 'builtin/increment@1', args: [{ literal: 1 }] }], to: 'worker' },
      failure: { id: 'worker_failed', from: 'worker', on: 'failure', to: { node: 'failed', inputs: { error: { ref: '$output' } } } },
    },
    exactEntrypoint: { id: 'start', node: 'worker', inputs: {} },
    boundedLimits: { maxTotalActivations: 100, maxLiveActivations: 4, maxWallTimeMs: 86400000, maxCostUsd: 20, maxFanOut: 4, maxPendingTimers: 16 },
    continuousLimits: { maxLiveActivations: 4, maxCostUsd: 20, maxFanOut: 4, maxPendingTimers: 16 },
    exactConcurrency: { maxActivations: 1, maxPerNode: 1, stateConsistency: 'commit_latest' },
    rules: [
      'updates.args is an array of ValueExpression objects.',
      'Conditional routes need unique priorities and exactly one default.',
      'Agent/Function/Effect need success and failure routes; Wait routes use timer/event/timeout/failure; a paused terminal needs a resume route.',
      'Bounded loops declare maxTotalActivations plus maxLiveActivations. Continuous/reactive loops omit the total cap and use maxLiveActivations; maxActivations is a legacy input alias and must not be emitted.',
      "Limit exhaustion is an exhausted graph status, not failure. An Agent may route on:'exhausted' for a final deterministic cleanup/summary path.",
      "on:'always' matches any outcome that has no exact route; use it only as a deliberate catch-all.",
      '`when` reads PRE-update $state; transition target inputs are evaluated AFTER updates commit (post-update $state).',
      "String literals in `when` are supported and MUST be quoted: $output.trend == 'worsened'. An unquoted word is a reference root and will be rejected; never replace a semantic enum with a numeric code to work around missing quotes.",
      'For next_count=current+1 threshold routing, test current>=threshold-1 and update count+derived status together on the same transition. Do not add identity/status gate nodes merely to read post-update state.',
      'Every $input.x a target node reads must be bound by this transition (and every other incoming path); bind { "literal": null } where the value is absent.',
      'External events match on exact name plus structurally-equal correlation; with wait timeoutMs the earlier of event-arrival and deadline wins deterministically.',
      "When concurrency.maxActivations > 1, stateConsistency is required. serializable replays an Activation whenever State advanced during its execution — for Agent nodes each replay re-runs a paid segment, so declare lifetimeBudget/maxCostUsd when using it. commit_latest must not mix fresh $state and stale-snapshot $output for a decision that requires one coherent snapshot.",
    ],
  })
  if (section === 'example') return JSON.stringify(CANONICAL_GRAPH_DISTILL_EXAMPLE, null, 2)
  return JSON.stringify({
    agentTools: [...catalog.agentTools].sort(), functions: catalog.functions.manifests(), reducers: catalog.reducers.manifests(),
    effects: catalog.effects.manifests(), capabilityPacks: catalog.packs.list(), scenarioGuidance: catalog.packs.scenarios(),
  }, null, 2)
}

function document(value: unknown): string { return JSON.stringify(value, null, 2) }
