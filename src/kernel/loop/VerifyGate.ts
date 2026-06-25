/**
 * VerifyGate — auto-mode completion gate (kernel-layer contract).
 *
 * When an unattended (auto) run *thinks* it is done — the model stops issuing
 * tool calls — the loop must not just trust that judgment. The blog calls this
 * "Verify": the real guardrail. We close the loop with an INDEPENDENT judge that
 * runs in an isolated context and decides whether the original goal is actually
 * met.
 *
 * This module deliberately holds ONLY the kernel-side contract:
 *   - the verdict shape the loop consumes,
 *   - the callback signature the loop calls,
 *   - the bounded-retry constant,
 *   - the prompt that re-injects unfinished items.
 *
 * The IMPLEMENTATION of the gate (spawning a judge sub-agent, building a git
 * snapshot, gathering deterministic evidence) lives in core/auto/verify and is
 * wired in via KernelConfig.verifyGate — the kernel never imports it, exactly
 * like onPermissionDenial. This keeps the layering clean: kernel defines the
 * hook, the session layer supplies the behaviour.
 */

/** Max executor→verify→fix rounds before the loop stops with verify_exhausted. */
export const MAX_VERIFY_ROUNDS = 5

/** Structured verdict returned by the judge. */
export interface VerifyVerdict {
  /** True when the judge is satisfied the goal is met. */
  done: boolean
  /** Concrete outstanding items (one actionable line each) when not done. */
  unfinished: string[]
  /** Evidence the judge cites for its verdict (file:line, command + exit code). */
  evidence: string[]
  /**
   * Optional free-text note (e.g. why the judge could not reach a verdict).
   * Surfaced to the human; never load-bearing for the loop decision.
   */
  note?: string
  /**
   * True when the gate did NOT actually verify: goal missing, judge timed out /
   * could not spawn (e.g. sub-agent budget exhausted), or an internal error.
   * The kernel's autoGateFailurePolicy decides whether this stops the run
   * (default) or preserves legacy fail-open behaviour.
   */
  skipped?: boolean
}

/**
 * Arguments the loop hands the gate at the natural-completion point.
 *
 * Note the loop does NOT supply the goal: the pure, frozen goal lives in the
 * session layer (SessionRouter._autoGoal), so the gate implementation closes
 * over it directly. The loop only contributes what it authoritatively knows.
 */
export interface VerifyGateArgs {
  /** Workspace root (the auto jail root) — the kernel's live cwd. */
  workspaceRoot: string
  /** Completed-turn count so far (observability / judge budget hints). */
  turnCount: number
  /** 1-based index of THIS verify round (1 = first completion check). */
  round: number
  /** Abort signal — judge work must bail when the parent run is interrupted. */
  signal: AbortSignal
}

/**
 * The verify gate. Returns a verdict; the loop continues (re-injecting the
 * unfinished items) when `done === false`. Implementations should prefer
 * resolving to a skipped verdict with a useful note on internal failure; the
 * kernel handles retry and auto-only failure policy.
 */
export type VerifyGateFn = (args: VerifyGateArgs) => Promise<VerifyVerdict>

/**
 * Build the meta user-message re-injected when verify rejects completion. It
 * frames the verdict as an external review the executor must address, not as
 * the executor's own second-guessing — that independence is the whole point.
 */
export function buildVerifyRejectionPrompt(verdict: VerifyVerdict, round: number): string {
  const items = verdict.unfinished.length
    ? verdict.unfinished.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
    : '  （审核未给出具体项，请自查目标是否真正满足）'
  const evidence = verdict.evidence.length
    ? `\n审核依据：\n${verdict.evidence.map(e => `  - ${e}`).join('\n')}`
    : ''
  return (
    `[系统·完成度审核 第 ${round} 轮] 一个独立审核 Agent（隔离上下文，未看你的推理过程）` +
    `检查了你针对原始目标的实际产物，判定**尚未完成**。请处理以下未完成项后再结束：\n` +
    items +
    evidence +
    '\n\n请直接继续修复这些项，不要重述已做的工作；全部解决后再次停下即可。'
  )
}
