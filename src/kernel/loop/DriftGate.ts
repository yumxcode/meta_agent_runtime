/**
 * DriftGate — auto-mode mid-flight reflection (Checkpoint + Learn).
 *
 * Verify fires once, at "I'm done". DriftGate fires DURING a long run, at coarse
 * structural boundaries, to answer a different question: "are we still heading at
 * the goal, and is there a durable lesson worth recording?" It is the loop's
 * periodic "stop, look back, confirm we haven't wandered off" — exactly the
 * Checkpoint role the blog describes, plus the write half of Learn.
 *
 * Like VerifyGate, this module holds ONLY the kernel-side contract; the
 * implementation (spawning a drift sub-agent that reads goal + checkpoint and may
 * write experiences) lives in core/auto/learn and is injected via
 * KernelConfig.driftGate. The kernel never imports it.
 *
 * Trigger policy (double gate, evaluated in the loop):
 *   • a durable checkpoint revision advanced since the previous drift; AND
 *   • DRIFT_TURN_INTERVAL tool batches completed since the previous drift.
 *
 * Compaction has its own before/after checkpoint boundaries but does not trigger
 * drift by itself.
 */

/** Completed tool batches required between drift checks. */
export const DRIFT_TURN_INTERVAL = 30

/** Why a drift check was triggered (observability + judge hint). */
export type DriftReason = 'turn_interval'

/** Structured verdict returned by the drift agent. */
export interface DriftVerdict {
  /** True when the run has wandered off the goal and needs correction. */
  drifted: boolean
  /** Severity hint; 'minor' nudges, 'major' is a strong steer. */
  severity?: 'minor' | 'major'
  /** Concrete corrective steps to re-inject when drifted. */
  corrective: string[]
  /** Free-text reasoning / what was observed. */
  note?: string
  /** IDs of experiences the agent wrote this round (observability only). */
  experiencesWritten?: string[]
  /**
   * True when the gate did NOT actually run: goal/checkpoint missing, drift
   * agent could not spawn / timed out, or an internal error. The kernel's
   * autoGateFailurePolicy decides whether this warning is tolerated briefly,
   * stops immediately, or preserves legacy fail-open behaviour.
   */
  skipped?: boolean
}

/** Arguments the loop hands the drift gate. */
export interface DriftGateArgs {
  /** Workspace root (auto jail root) — the kernel's live cwd. */
  workspaceRoot: string
  /** Completed-turn count so far. */
  turnCount: number
  /** What triggered this check. */
  reason: DriftReason
  /** Abort signal — drift work bails when the parent run is interrupted. */
  signal: AbortSignal
}

/**
 * The drift gate. Implementations should prefer resolving to a skipped verdict
 * with a useful note on internal failure; the kernel handles retry, consecutive
 * failure counting, and auto-only failure policy.
 */
export type DriftGateFn = (args: DriftGateArgs) => Promise<DriftVerdict>

/**
 * Build the one-shot meta message re-injected when drift is detected. Framed as
 * an external mid-flight review so the executor treats it as a course
 * correction, not as its own rumination.
 */
export function buildDriftCorrectionPrompt(verdict: DriftVerdict): string {
  const sev = verdict.severity === 'major' ? '（严重）' : ''
  const items = verdict.corrective.length
    ? verdict.corrective.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
    : '  （未给出具体纠偏项，请对照原始目标自查当前方向）'
  const note = verdict.note ? `\n判断依据：${verdict.note}` : ''
  return (
    `[系统·航向校正${sev}] 一次独立的中途审查（对照原始目标与进度快照）判定当前推进已偏离目标。` +
    `请在继续前先校正方向：\n` +
    items +
    note +
    '\n\n如果你认为没有偏离，请用一句话说明理由再继续；否则按上述校正后推进。'
  )
}
