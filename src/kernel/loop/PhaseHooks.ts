/**
 * PhaseHooks — kernel-side contract for the auto-orch main-loop phase hooks (B).
 *
 * Verify/Drift answer "is the run done / on-goal" at coarse structural points.
 * Phase hooks are FINER: they let an injected policy observe and minimally steer
 * the loop at the four intra-turn transitions the kernel could not previously
 * expose —
 *
 *   • pre_query   — just before the model is queried for the next turn;
 *   • post_query  — right after the assistant turn streamed, before tools run;
 *   • pre_tool    — before the tool batch executes;
 *   • post_tool   — after the tool batch completed.
 *
 * Like VerifyGate / DriftGate, this module holds ONLY the kernel-side contract;
 * the registry/middleware implementation lives in core/auto-orch and is injected
 * via KernelConfig.phaseHooks. The kernel never imports the implementation.
 *
 * Design invariants (mirrors the gate contracts):
 *   • Additive & opt-in — when KernelConfig.phaseHooks is absent the kernel makes
 *     ZERO extra calls, so agentic/auto/campaign/robotics behaviour is byte-for-
 *     byte unchanged (zero regression).
 *   • Minimal action surface — a hook may only (a) inject meta user messages at
 *     the next natural boundary, or (b) request an abort. It can NEVER mutate
 *     history, call tools, or rewrite the model output. This keeps the
 *     battle-tested loop in control of execution; hooks only nudge.
 *   • Fail-open — the kernel treats a thrown/timed-out hook as an empty outcome.
 */

/** The four intra-turn transitions a phase hook can observe. */
export type PhaseHookPoint = 'pre_query' | 'post_query' | 'pre_tool' | 'post_tool'

/** Read-only view of loop state handed to a phase hook (no live references). */
export interface PhaseHookState {
  /** Session-lifetime count of completed tool batches. */
  turnCount: number
  /** Cumulative estimated cost so far. */
  estimatedCostUsd: number
  /** Tool names about to run / just ran, when applicable (pre_tool/post_tool). */
  toolNames?: readonly string[]
  /** Tool names that errored in the just-completed batch (post_tool). */
  erroredToolNames?: readonly string[]
}

/** Arguments the loop hands a phase hook at a transition. */
export interface PhaseHookEvent {
  /** Which transition fired. */
  point: PhaseHookPoint
  /** Workspace root (auto jail root). */
  workspaceRoot: string
  /** Read-only loop state at this point. */
  state: PhaseHookState
  /** Abort signal — hook work bails when the parent run is interrupted. */
  signal: AbortSignal
}

/**
 * What a phase hook may ask the loop to do. Both fields are optional; an empty
 * outcome (the fail-open default) is a no-op.
 */
export interface PhaseHookOutcome {
  /**
   * Meta user messages to append at the next natural boundary so the model
   * incorporates them on the following turn (same mechanism drift corrections
   * use). Framed by the implementation as external guidance.
   */
  inject?: string[]
  /** When true, the loop terminates cleanly after applying any inject. */
  abort?: boolean
  /** Free-text reason for observability; never load-bearing. */
  note?: string
}

/**
 * The phase-hook dispatch function. One call per transition. Implementations
 * should resolve to an empty outcome on internal failure; the kernel does not
 * retry phase hooks (unlike gates) — they are advisory and best-effort.
 */
export type PhaseHookFn = (event: PhaseHookEvent) => Promise<PhaseHookOutcome>
