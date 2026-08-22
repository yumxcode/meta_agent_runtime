/**
 * RuntimeContext — the three shared singletons that power Phase 1 integration.
 *
 * A RuntimeContext bundles:
 *   • JobManager       — async job submission, polling, cancellation
 *   • VVHookChain      — pre/post-call validation & verification
 *   • ProvenanceTracker — full audit trail for every tool call
 *
 * A single RuntimeContext is typically created per agent process and shared
 * across multiple sessions.  Pass it to MetaAgentConfig.runtimeContext to
 * enable automatic tool instrumentation, session preamble injection, and
 * provenance-to-context routing.
 *
 * Usage:
 *   const rtx = createRuntimeContext({ sessionId: 'agent-1' })
 *   const session = new MetaAgentSession({ runtimeContext: rtx, ... })
 */

import { JobManager } from '../jobs/JobManager.js'
import { LocalExecutor } from '../jobs/JobExecutor.js'
import { VVHookChain } from '../validation/VVHookChain.js'
import { createDefaultVVChain } from '../validation/index.js'
import { ProvenanceTracker } from '../provenance/ProvenanceTracker.js'
import { TurnDiffTracker } from '../infra/fs/TurnDiffTracker.js'

// ─────────────────────────────────────────────────────────────────────────────
// RuntimeContext interface
// ─────────────────────────────────────────────────────────────────────────────

export interface RuntimeContext {
  readonly jobManager: JobManager
  readonly vvChain: VVHookChain
  readonly provenanceTracker: ProvenanceTracker
  /** Session ID shared by all services in this context */
  readonly sessionId: string
  /** Agent ID (defaults to sessionId) */
  readonly agentId: string
  /**
   * Per-turn file change tracker, when enabled.
   *
   * Optional rather than always-on because tracking costs a read of the old
   * bytes on every first mutation of a path, and a host that never surfaces a
   * turn diff would pay that for nothing. Hosts that DO want it call
   * `turnDiff.beginTurn()` at each turn boundary; the write tools populate it
   * on their own.
   */
  readonly turnDiff?: TurnDiffTracker
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory options
// ─────────────────────────────────────────────────────────────────────────────

export interface RuntimeContextOptions {
  /** Session identifier (used for job storage paths and provenance records) */
  sessionId: string
  /** Agent identifier (defaults to sessionId) */
  agentId?: string
  /**
   * Maximum number of jobs that can run concurrently.
   * Default: 4
   */
  maxConcurrentJobs?: number
  /**
   * Custom VVHookChain.  If omitted, creates the default chain with
   * OOMChecker + PhysicsConstraintChecker + DimensionChecker.
   */
  vvChain?: VVHookChain
  /**
   * Custom ProvenanceTracker.  If omitted, creates a new one for sessionId.
   */
  provenanceTracker?: ProvenanceTracker
  /**
   * Track file changes per turn so `turn_diff` can render (and revert) them.
   *
   * Default: false. Pass `true` for the default tracker, or an instance to
   * share one across contexts.
   */
  turnDiff?: boolean | TurnDiffTracker
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a RuntimeContext with sensible defaults.
 *
 * Example (minimal):
 *   const rtx = createRuntimeContext({ sessionId: 'sess-abc' })
 *
 * Example (custom V&V chain):
 *   const chain = new VVHookChain([new OOMChecker(), myCustomHook])
 *   const rtx = createRuntimeContext({ sessionId: 'sess-abc', vvChain: chain })
 */
export function createRuntimeContext(opts: RuntimeContextOptions): RuntimeContext {
  const sessionId = opts.sessionId
  const agentId = opts.agentId ?? sessionId

  const executor = new LocalExecutor(opts.maxConcurrentJobs ?? 4)
  const jobManager = new JobManager(sessionId, executor)

  const vvChain = opts.vvChain ?? createDefaultVVChain()
  const provenanceTracker = opts.provenanceTracker ?? new ProvenanceTracker(sessionId)
  const turnDiff =
    opts.turnDiff === true ? new TurnDiffTracker()
      : opts.turnDiff instanceof TurnDiffTracker ? opts.turnDiff
      : undefined

  return {
    jobManager, vvChain, provenanceTracker, sessionId, agentId,
    ...(turnDiff ? { turnDiff } : {}),
  }
}
