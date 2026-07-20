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

export function createGraphDistillTools(catalog: GraphRuntimeCatalog): MetaAgentTool[] {
  return [referenceTool(catalog), validateTool(catalog)]
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

function validateTool(catalog: GraphRuntimeCatalog): MetaAgentTool {
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
        const graph = input.graph as unknown as LoopGraphSpec
        const errors = validateLoopGraph(graph, catalog)
        if (input.constraints !== undefined || input.traceability !== undefined) {
          if (!input.constraints || typeof input.constraints !== 'object' || Array.isArray(input.constraints)) errors.push('constraints must be an object')
          else errors.push(...validateConstraintLedger(input.constraints as unknown as LoopConstraintLedger))
          if (!input.traceability || typeof input.traceability !== 'object' || Array.isArray(input.traceability)) errors.push('traceability must be an object')
          else if (input.constraints && typeof input.constraints === 'object' && !Array.isArray(input.constraints)) {
            errors.push(...validateGraphTraceability(input.traceability as unknown as GraphTraceabilityMap, input.constraints as unknown as LoopConstraintLedger, graph))
          }
        }
        if (errors.length) return result({ valid: false, frozen: false, errorCount: errors.length, errors })
        const frozen = freezeLoopGraph(graph, catalog, 0)
        return result({
          valid: true, frozen: true, graphHash: frozen.graphHash,
          summary: {
            nodes: Object.keys(graph.nodes).length,
            transitions: graph.transitions.length,
            lanes: Object.keys(graph.lanes).length,
            workspaceWrites: Object.values(graph.lanes).reduce((sum, lane) => sum + (lane.workspace.write?.length ?? 0), 0),
          },
          manifest: buildGraphImplementationManifest(graph),
        })
      } catch (error) {
        return result({ valid: false, frozen: false, errorCount: 1, errors: [`candidate validation could not continue: ${error instanceof Error ? error.message : String(error)}`], hint: 'Use graph_reference, repair the candidate, then call graph_validate again.' })
      }
    },
  }
}

function result(value: unknown): ToolResult { return { content: JSON.stringify(value, null, 2), isError: false } }

export function graphReference(section: GraphReferenceSection, catalog: GraphRuntimeCatalog): string {
  if (section === 'overview') return document({
    contract: 'durable-graph-v2 source object; omit unused optional fields',
    exactSkeleton: {
      schemaVersion: 'graph-2.0', id: 'loop_id', version: 1, goal: 'goal',
      state: {}, lanes: {}, nodes: {}, transitions: [], entrypoints: [], limits: { maxActivations: 100 },
    },
    optionalTopLevel: ['capabilityPacks', 'concurrency', 'annotations'],
    freezeOwned: ['capabilityLock', 'graphHash', 'frozenAt'],
    rule: 'Unknown executable fields are rejected. Domain-only notes belong under annotations.',
  })
  if (section === 'nodes') return document({
    valueExpression: { exactForms: [{ literal: 'any JSON value' }, { ref: '$state.name' }, { call: 'function@version', args: [{ literal: 1 }] }] },
    inputDataflow: {
      strictRefs: 'Every $input.x a node reads (inputs, effect idempotencyKey, wait delayMs/correlation, terminal result) is STRICT: if any incoming transition or entrypoint does not bind x, the Activation fails at runtime and the validator rejects the graph.',
      optionalInputIdiom: 'A value only some paths supply must be bound { "literal": null } on every other incoming edge and entrypoint; downstream treats null as absent.',
      whenIsLenient: 'Only transition `when` conditions treat a missing reference as no-match; ValueExpression refs never fall back.',
      entrypointScope: 'Entrypoint inputs may only reference $state or literals — $input/$output do not exist at instance creation.',
      functionOutput: 'A function node $output is the raw function return value. builtin/identity@1 returns the ENTIRE inputs record: with inputs {value:...} downstream must read $output.value, not $output.',
    },
    exactNodeTemplates: {
      agent: {
        type: 'agent', lane: 'lane_id', prompt: 'one bounded responsibility', inputs: { item: { ref: '$state.item' } },
        outputSchema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } }, additionalProperties: false },
        tools: ['read_file'], maxAttempts: 3, budget: { turns: 20, usd: 1, wallTimeMs: 600000 },
      },
      function: { type: 'function', function: 'builtin/identity@1', inputs: { value: { ref: '$input.value' } } },
      effect: { type: 'effect', effect: 'pack/effect@1', inputs: {}, idempotencyKey: { ref: '$input.key' }, timeoutMs: 60000 },
      timerWait: { type: 'wait', wait: { kind: 'timer', delayMs: { literal: 1800000 }, maxDelayMs: 3600000 } },
      eventWait: { type: 'wait', wait: { kind: 'event', event: 'event.name', correlation: { ref: '$input.id' }, timeoutMs: 3600000 } },
      join: { type: 'join', mode: 'all', expects: ['incoming_transition_id'] },
      terminal: { type: 'terminal', status: 'done', result: { ref: '$input.result' } },
      pausedTerminal: { type: 'terminal', status: 'paused', result: { ref: '$input.result' } },
    },
    hardParkAgentAdditions: { lifetimeBudget: { turns: 200, usd: 10, elapsedMs: 86400000 }, timerPolicy: { allowHardPark: true, maxDelayMs: 3600000, maxParks: 48 } },
    rules: [
      'Prefer Agent, Wait, and Terminal. Add Function/Effect/Join only when the requirement needs them.',
      'Keep strongly coupled work in one Agent Activation.',
      "A paused terminal halts the graph until an operator runs `loop resume`; it may only have on:'resume' outgoing transitions and resumes exactly once.",
      'Never emulate waiting with sleep-style tools inside an Agent — a sleeping segment burns its budget and cannot be durably recovered. Use a wait node or agent timer hard-park.',
      'Join has NO timeout: every transition in expects must either reach the join, or the failing branch must route the graph to a terminal; otherwise arrived members wait forever.',
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
      defaultWithUpdate: { id: 'continue_route', from: 'worker', on: 'success', default: true, updates: [{ target: 'iteration', reducer: 'builtin/increment@1', args: [{ literal: 1 }] }], to: 'worker' },
      failure: { id: 'worker_failed', from: 'worker', on: 'failure', to: { node: 'failed', inputs: { error: { ref: '$output' } } } },
    },
    exactEntrypoint: { id: 'start', node: 'worker', inputs: {} },
    exactLimits: { maxActivations: 100, maxWallTimeMs: 86400000, maxCostUsd: 20, maxFanOut: 4, maxPendingTimers: 16 },
    exactConcurrency: { maxActivations: 1, maxPerNode: 1, stateConsistency: 'commit_latest' },
    rules: [
      'updates.args is an array of ValueExpression objects.',
      'Conditional routes need unique priorities and exactly one default.',
      'Agent/Function/Effect need success and failure routes; Wait routes use timer/event/timeout/failure; a paused terminal needs a resume route.',
      'Every cycle has a business terminal and maxActivations.',
      "on:'always' matches any outcome that has no exact route; use it only as a deliberate catch-all.",
      '`when` reads PRE-update $state; transition target inputs are evaluated AFTER updates commit (post-update $state).',
      'Every $input.x a target node reads must be bound by this transition (and every other incoming path); bind { "literal": null } where the value is absent.',
      'External events match on exact name plus structurally-equal correlation; with wait timeoutMs the earlier of event-arrival and deadline wins deterministically.',
      "stateConsistency:'serializable' replays an Activation whenever State advanced during its execution — for Agent nodes each replay re-runs a paid segment, so declare lifetimeBudget/maxCostUsd when using it.",
    ],
  })
  if (section === 'example') return JSON.stringify(CANONICAL_GRAPH_DISTILL_EXAMPLE, null, 2)
  return JSON.stringify({
    agentTools: [...catalog.agentTools].sort(), functions: catalog.functions.manifests(), reducers: catalog.reducers.manifests(),
    effects: catalog.effects.manifests(), capabilityPacks: catalog.packs.list(), scenarioGuidance: catalog.packs.scenarios(),
  }, null, 2)
}

function document(value: unknown): string { return JSON.stringify(value, null, 2) }
