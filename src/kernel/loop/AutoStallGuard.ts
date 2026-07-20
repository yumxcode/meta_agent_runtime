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
export const FS_MUTATING_TOOLS = new Set(['write_file', 'append_file', 'edit_file', 'notebook_edit'])

/**
 * Recurring-error axis: how many times the SAME normalized error signature must
 * recur within the recent window before one reflection nudge is injected. This
 * axis is SOFT-ONLY — it never hard-stops (the maxTurns cap is the backstop). It
 * exists because the all-error and no-FS axes both reset on any successful edit,
 * so a "edit → run → same error → edit → run → same error" debug/retry loop
 * defeats them and burns the whole turn budget. Keyed on the error (not the tool
 * input), so it survives both interleaved successes and varied inputs.
 */
export const AUTO_RECURRING_ERROR_LIMIT = 6
/** Sliding window (in error occurrences) over which recurrences are counted. */
export const RECURRING_ERROR_WINDOW = 40

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

/**
 * Normalize a tool error into a stable signature for the recurring-error axis.
 *
 * Deliberately CONSERVATIVE (fewer false matches): it keeps the discriminating
 * message words intact and only blurs volatile tokens that legitimately change
 * between identical failures — hex addresses, long hashes/UUIDs, file paths,
 * line:col numbers and bare integers. Two `AttributeError` lines that differ
 * only in a traceback line number collapse to the same signature; two genuinely
 * different errors do not. Capped to keep the key bounded.
 */
export function normalizeErrorSignature(toolName: string, rawError: string): string {
  const s = rawError
    .replace(/0x[0-9a-fA-F]+/g, '0x')          // hex addresses
    .replace(/\b[0-9a-fA-F]{8,}\b/g, 'H')      // long hex / hashes / uuids
    .replace(/\/[^\s'"`)]+/g, '/P')            // file paths
    .replace(/:\d+(?::\d+)?/g, ':N')           // :line(:col)
    .replace(/\b\d+\b/g, 'N')                  // bare numbers
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 160)
  return `${toolName}|${s}`
}

/**
 * Collect this turn's ERRORED tool results as { signature, sample } pairs.
 * `signature` feeds the recurring-error window; `sample` is a short raw excerpt
 * shown back to the model in the reflection nudge so it knows which loop to break.
 */
export function collectTurnErrors(
  toolResultMessages: readonly KernelMessage[],
  toolNameByUseId: ReadonlyMap<string, string>,
): Array<{ signature: string; sample: string }> {
  const out: Array<{ signature: string; sample: string }> = []
  for (const msg of toolResultMessages) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.is_error === true) {
        const name = toolNameByUseId.get(block.tool_use_id) ?? 'tool'
        const raw = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        out.push({
          signature: normalizeErrorSignature(name, raw),
          sample: raw.replace(/\s+/g, ' ').trim().slice(0, 300),
        })
      }
    }
  }
  return out
}

/** The one-shot reflection injected when an error signature recurs ≥ the limit. */
export function buildRecurringErrorReflection(sample: string, count: number): string {
  return (
    `[系统·自评估] 同一个错误已反复出现约 ${count} 次（即使你中间改过文件，它仍在复现）：\n` +
    `${sample}\n` +
    `先停下来想清楚：(1) 这个错误的真正根因是什么，而不是表面症状？` +
    `(2) 你前几次的修法为什么没能消除它？` +
    `(3) 换一个**不同的**诊断或方案——例如打印/检查实际的数据结构与返回值、加日志、查文档或源码、或换一条实现路径。不要再重复刚才那种改法。`
  )
}
