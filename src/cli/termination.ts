/**
 * Classify how a session ended, for presentation and for deciding whether an
 * LLM post-mortem is worth paying for.
 *
 * ## Why this exists
 *
 * The kernel knows precisely why it stopped — `LoopTerminationReason` has 17
 * distinct values — and carries that through to the CLI as `result.stopReason`.
 * But `KernelSession.subtypeMap` folds ten of them into the single subtype
 * `error_during_execution`, and the CLI branched on the SUBTYPE. So a planned,
 * checkpointed 2-hour wall-clock suspension printed:
 *
 *     ✗  执行过程中发生错误。请检查以下错误信息，调整指令后重试。
 *
 * — one line after the loop itself had correctly said "Progress was
 * checkpointed; resume the session to continue." Three things wrong at once:
 *
 *   1. It is not an error. The run hit a configured ceiling and saved its work.
 *   2. The advice is the wrong lever. "Adjust instructions and retry" throws
 *      away a checkpoint whose entire purpose is `--resume`.
 *   3. "请检查以下错误信息" points at information that cannot exist here:
 *      `errors` is only ever populated when the loop THREW, never when it
 *      returned a termination reason. The sentence promised a diagnosis and
 *      then printed nothing.
 *
 * A user interrupting with Ctrl+C got the same banner, and both cases also
 * triggered `analyzeAbnormalTermination` — a billed LLM call to explain an
 * outcome that was either planned or explicitly requested by the user.
 *
 * The fix is not more branches in the printer. It is to stop discarding the
 * reason the runtime already computed: classify on `stopReason`, and let the
 * subtype be the fallback for callers that predate it.
 */

/** What KIND of ending this was, independent of the coarse result subtype. */
export type TerminationClass =
  /** Completed normally (includes an orchestration hook's clean stop). */
  | 'success'
  /** Durable self-timer suspension; a scheduler will resume it. */
  | 'parked'
  /** Hit a configured autonomy ceiling, checkpointed, resumable by the user. */
  | 'suspended'
  /** The user asked it to stop. */
  | 'interrupted'
  /** Hit a configured limit that a flag can raise. */
  | 'limit'
  /** Something actually went wrong; a post-mortem is worth running. */
  | 'abnormal'

/**
 * Reasons that represent a planned stop with durable progress.
 *
 * These are the ones that hurt most when mislabelled: the run did everything
 * right, saved its state, and told the user to resume — and the old banner then
 * told them to rewrite their prompt instead.
 */
const SUSPENDED_REASONS = new Set(['auto_runtime_limit', 'auto_tool_batch_limit'])

/** Reasons that mean "a human (or the host) pulled the plug on purpose". */
const INTERRUPTED_REASONS = new Set(['aborted_streaming', 'aborted_tools'])

/** Reasons that are a configured ceiling with a specific flag to raise it. */
const LIMIT_REASONS = new Set([
  'max_turns', 'max_budget_usd', 'max_output_tokens', 'blocking_limit',
])

/**
 * Reasons where the agent genuinely failed to make progress or the machinery
 * around it broke. Only these justify spending a model call on a diagnosis.
 */
const ABNORMAL_REASONS = new Set([
  'no_progress', 'verify_exhausted', 'auto_verify_unavailable',
  'auto_drift_unavailable', 'phase_hook_fail', 'error',
])

export function classifyTermination(input: {
  subtype: string
  stopReason?: string | null
}): TerminationClass {
  if (input.subtype === 'success') return 'success'
  if (input.subtype === 'parked') return 'parked'

  const reason = input.stopReason ?? ''
  if (SUSPENDED_REASONS.has(reason)) return 'suspended'
  if (INTERRUPTED_REASONS.has(reason)) return 'interrupted'
  if (LIMIT_REASONS.has(reason)) return 'limit'
  if (ABNORMAL_REASONS.has(reason)) return 'abnormal'

  // No stopReason (older event producers, or a subtype-only caller): fall back
  // to what the subtype can tell us. Unknown reasons land on 'abnormal', which
  // is the safe default — it shows the diagnosis rather than quietly hiding a
  // failure nobody has classified yet.
  switch (input.subtype) {
    case 'error_max_turns':
    case 'error_max_budget':
    case 'error_max_budget_usd':
    case 'error_max_output_tokens':
    case 'error_blocking_limit':
      return 'limit'
    default:
      return 'abnormal'
  }
}

/**
 * True when an LLM post-mortem is worth its cost and latency.
 *
 * Gating on `isError` (the old behaviour) billed the user to explain their own
 * Ctrl+C and to narrate a wall-clock limit whose message already said exactly
 * what happened and what to do next.
 */
export function warrantsTerminationDiagnosis(input: {
  subtype: string
  stopReason?: string | null
}): boolean {
  return classifyTermination(input) === 'abnormal'
}

/**
 * Precise, human-readable reason. Prefers `stopReason` because the subtype has
 * already thrown the distinction away — `terminationReasonLabel` used to be fed
 * the subtype, so the diagnosis prompt was told "执行中止（可能是无进展死循环、
 * verify 未通过、被外部依赖阻塞，或运行时错误）" and asked to guess between four
 * possibilities the runtime could already name.
 */
export function terminationLabel(input: { subtype: string; stopReason?: string | null }): string {
  switch (input.stopReason) {
    case 'auto_runtime_limit':      return '达到自治运行墙钟上限（auto_runtime_limit）'
    case 'auto_tool_batch_limit':   return '达到自治工具批次上限（auto_tool_batch_limit）'
    case 'aborted_streaming':
    case 'aborted_tools':           return '被用户中断（Ctrl+C）'
    case 'no_progress':             return '连续无进展，判定为死循环（no_progress）'
    case 'verify_exhausted':        return '完成度审核在轮次上限内始终未通过（verify_exhausted）'
    case 'auto_verify_unavailable': return '完成度审核不可用（auto_verify_unavailable）'
    case 'auto_drift_unavailable':  return '航向检查不可用（auto_drift_unavailable）'
    case 'phase_hook_fail':         return '编排阶段钩子报告失败（phase_hook_fail）'
    case 'max_turns':               return '达到最大步数上限（max_turns）'
    case 'max_budget_usd':          return '超出费用上限（max_budget_usd）'
    case 'max_output_tokens':       return '模型输出连续达到上限（max_output_tokens）'
    case 'blocking_limit':          return '上下文超出可发送上限（blocking_limit）'
  }
  // Subtype-only fallback for producers that do not carry stopReason.
  switch (input.subtype) {
    case 'error_max_turns':         return '达到最大步数上限（max_turns）'
    case 'error_max_budget':
    case 'error_max_budget_usd':    return '超出预算/费用上限（max_budget）'
    case 'error_max_output_tokens': return '模型输出达到上限（max_output_tokens）'
    case 'error_blocking_limit':    return '达到阻塞操作上限（blocking_limit）'
    case 'error_during_execution':
      return '执行中止（可能是无进展死循环、verify 未通过、被外部依赖阻塞，或运行时错误）'
    default: return input.subtype
  }
}

/**
 * The exact command that continues a checkpointed session.
 *
 * The loop's own message says "resume the session to continue" without saying
 * how, and the session id is not something a user has memorised — so the advice
 * was correct and still unusable.
 */
export function resumeCommand(sessionId: string, mode?: string | null): string {
  const modeFlag = mode && mode !== 'agentic' ? `--mode ${mode} ` : ''
  return `meta-agent ${modeFlag}--resume ${sessionId} "继续"`
}
