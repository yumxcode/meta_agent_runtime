/**
 * AutoStallGuard — auto-mode "everything keeps failing" circuit.
 *
 * The loop already terminates on REPEATED IDENTICAL tool signatures
 * (NO_PROGRESS_REPEAT_LIMIT) and on strict A↔B oscillation (AlternationGuard).
 * Those miss a different stall: an unattended agent that keeps trying DIFFERENT
 * commands that ALL fail (15 distinct bash invocations, each erroring). No human
 * is watching, so this should trip a circuit before it burns the whole budget.
 *
 * This module is intentionally tiny and pure. The stateful counter lives in the
 * loop; this just answers "did every tool result this turn error?". Only
 * consulted when KernelConfig.autonomousMode is set, so other modes are
 * unaffected (their existing guards + budget/turn caps still apply).
 */
import type { KernelMessage } from '../types/KernelMessage.js'

/** Consecutive all-error tool turns before the auto stall circuit HARD-stops. */
export const AUTO_STALL_FAILURE_LIMIT = 5
/** All-error turns before injecting a one-shot self-eval nudge (soft, < hard). */
export const AUTO_STALL_SOFT_LIMIT = 3
/**
 * Turns that ran tools but mutated NO file before the one-shot self-eval nudge.
 * Deliberately high so a legitimate read/search/plan phase (which writes nothing)
 * is not mistaken for a stall. This NEVER hard-stops — it only nudges.
 */
export const AUTO_NO_FS_PROGRESS_LIMIT = 12

/** Tools that constitute real filesystem progress when they succeed. */
export const FS_MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'notebook_edit'])

/** The self-eval prompt injected when a soft stall threshold is first crossed. */
export const SELF_EVAL_PROMPT =
  '[系统·自评估] 你已连续多轮没有取得进展（工具反复失败，或长时间未改动任何文件）。' +
  '请先停下来：(1) 用一句话说明当前卡在哪里；(2) 判断是方法有误、缺少信息，还是该换思路或直接终止；' +
  '(3) 给出下一步**最小可行动作**。不要重复刚才失败的做法。'

/**
 * True when this turn produced at least one tool result AND every tool result
 * was an error. A turn with no tool results, or with any successful result,
 * returns false (and the caller resets its counter).
 */
export function allToolResultsErrored(toolResultMessages: readonly KernelMessage[]): boolean {
  let sawResult = false
  for (const msg of toolResultMessages) {
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        sawResult = true
        if (block.is_error !== true) return false
      }
    }
  }
  return sawResult
}

/**
 * True when at least one FS-mutating tool (write_file/edit_file/notebook_edit)
 * SUCCEEDED this turn — i.e. the agent made real filesystem progress. bash is
 * deliberately excluded: it's too ambiguous to count as progress, and counting
 * it would mask a spinning agent.
 */
export function turnMutatedFs(
  toolResultMessages: readonly KernelMessage[],
  toolNameByUseId: ReadonlyMap<string, string>,
): boolean {
  for (const msg of toolResultMessages) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.is_error !== true) {
        const name = toolNameByUseId.get(block.tool_use_id)
        if (name && FS_MUTATING_TOOLS.has(name)) return true
      }
    }
  }
  return false
}
