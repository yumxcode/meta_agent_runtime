/**
 * return_result — a sub-agent's authoritative final-result channel.
 *
 * Problem this solves:
 *   Previously a sub-agent's `summary` was reconstructed by concatenating every
 *   `text` event it emitted across the whole run (`lastText`) and then slicing
 *   the head.  That blends transient narration ("let me search again…") with the
 *   real answer and — because agents put their structured payload LAST — truncation
 *   cut off exactly the part the caller needed.
 *
 * Fix:
 *   Give the sub-agent an explicit tool to hand back its final result. Whatever it
 *   passes here becomes the authoritative summary, independent of how chatty the
 *   run was.  The runner captures the payload via the injected `sink` callback.
 *
 * The tool is injected per-run by SubAgentRunner; the `sink` closes over the
 * runner's captured-result slot.
 */

import type { MetaAgentTool, ToolResult } from '../../core/types.js'

/**
 * Guidance appended to a sub-agent's task description so it knows to hand its
 * result back through return_result rather than relying on chat text capture.
 */
export const RETURN_RESULT_HINT = `\
---
When you have finished, call the return_result tool exactly once to hand your
result back to the calling agent:
  - summary: a concise natural-language summary of the outcome.
  - data:    (optional) any structured result, preserved verbatim.
This is the authoritative channel — do not rely on your chat text being captured.
After calling return_result you may stop.`

/** Append the return_result guidance to a task description (idempotent-ish). */
export function withReturnResultHint(taskDescription: string): string {
  if (taskDescription.includes('return_result')) return taskDescription
  return `${taskDescription.trimEnd()}\n\n${RETURN_RESULT_HINT}\n`
}

export interface ReturnedResult {
  /** Concise natural-language summary of the outcome. */
  summary: string
  /** Optional structured payload — preserved verbatim and prioritized on truncation. */
  data?: unknown
}

export function makeReturnResultTool(
  sink: (result: ReturnedResult) => void,
): MetaAgentTool {
  return {
    name: 'return_result',
    isConcurrencySafe: false,
    description: `Submit your FINAL result for this task.

Call this exactly once, when you are done, instead of relying on your chat text to
be captured. Whatever you pass here is what the calling agent receives — verbatim
and untruncated-by-narration.

- summary: a concise natural-language summary of what you found / did.
- data:    (optional) the structured result object. For a literature survey this
           is { papers: [...], synthesis: "...", recommendation: "..." }. It is
           preserved whole and prioritized if the summary must be shortened.

After calling return_result you may stop — no further tool calls are needed.`,
    inputSchema: {
      type: 'object',
      required: ['summary'],
      properties: {
        summary: {
          type: 'string',
          description: 'Concise natural-language summary of the final outcome.',
        },
        data: {
          type: 'object',
          description:
            'Optional structured result object (e.g. {papers, synthesis, recommendation}). ' +
            'Preserved verbatim and prioritized over narration when space is tight.',
        },
      },
    },
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      const summary = String(input['summary'] ?? '').trim()
      if (!summary) {
        return { content: 'Error: return_result requires a non-empty "summary".', isError: true }
      }
      const result: ReturnedResult = { summary }
      if (input['data'] !== undefined) result.data = input['data']
      sink(result)
      return {
        content: 'Final result recorded. You may stop now — no further action needed.',
        isError: false,
      }
    },
  }
}
