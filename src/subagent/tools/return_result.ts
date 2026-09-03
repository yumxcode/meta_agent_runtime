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
import { validateJsonSchemaValue } from '../../core/jsonSchema.js'

export const DEFAULT_RETURN_RESULT_MAX_DATA_CHARS = 512 * 1024
export const FILE_DELIVERY_MAX_DATA_CHARS = 32 * 1024

export interface ReturnResultToolOptions {
  /** Serialized data limit. File-producing tasks use the smaller manifest-only cap. */
  maxDataChars?: number
  /** Adds explicit file-delivery guidance to the tool description and errors. */
  fileProducingTask?: boolean
}

/**
 * Guidance appended to a sub-agent's task description so it knows to hand its
 * result back through return_result rather than relying on chat text capture.
 */
export const RETURN_RESULT_HINT = `\
---
When you have finished, call the return_result tool exactly once to hand your
result back to the calling agent:
  - summary: a concise natural-language summary of the outcome.
  - data:    (optional) a compact structured result.
If the task creates code/files, write and test the deliverables in the workspace.
In data return only a manifest (paths, hashes, tests, and remaining issues), never
the full contents of generated files. Large non-file results should be split into
durable artifacts and referenced by path.
This is the authoritative channel — do not rely on your chat text being captured.
After calling return_result you may stop.`

/** Append the return_result guidance to a task description (idempotent-ish). */
export function withReturnResultHint(taskDescription: string): string {
  if (taskDescription.includes(RETURN_RESULT_HINT)) return taskDescription
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
  dataSchema?: Record<string, unknown>,
  options: ReturnResultToolOptions = {},
): MetaAgentTool {
  const maxDataChars = options.maxDataChars ?? DEFAULT_RETURN_RESULT_MAX_DATA_CHARS
  const dataDescription =
    'Compact authoritative structured result, preserved verbatim and prioritized over narration.'
  const fileDeliveryGuidance = options.fileProducingTask
    ? `\n\nThis task can write files. Put deliverables in the workspace and return only a compact\n` +
      `manifest in data (paths, hashes, tests, remaining issues). Do NOT paste file contents\n` +
      `into data. The serialized data limit for this task is ${maxDataChars} characters.`
    : `\n\nThe serialized data limit is ${maxDataChars} characters. Persist larger results as artifacts.`
  return {
    name: 'return_result',
    isConcurrencySafe: false,
    description: `Submit your FINAL result for this task.

Call this exactly once, when you are done, instead of relying on your chat text to
be captured. Accepted data is preserved independently of narration, subject to
the serialized-size limit below.

- summary: a concise natural-language summary of what you found / did.
- data:    (optional) the structured result object. For a literature survey this
           is { papers: [...], synthesis: "...", recommendation: "..." }. It is
           preserved whole and prioritized if the summary must be shortened.${fileDeliveryGuidance}

After calling return_result you may stop — no further tool calls are needed.`,
    inputSchema: {
      type: 'object',
      required: dataSchema ? ['summary', 'data'] : ['summary'],
      properties: {
        summary: {
          type: 'string',
          description: 'Concise natural-language summary of the final outcome.',
        },
        data: dataSchema
          ? { ...dataSchema, description: dataDescription }
          : {
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
      if (dataSchema) {
        const error = validateJsonSchemaValue(input['data'], dataSchema, 'return_result.data')
        if (error) return { content: `Error: ${error}.`, isError: true }
      }
      if (input['data'] !== undefined) {
        let serialized: string
        try {
          serialized = JSON.stringify(input['data'])
        } catch {
          return {
            content: 'Error: return_result.data must be JSON-serializable.',
            isError: true,
          }
        }
        if (serialized.length > maxDataChars) {
          return {
            content:
              `Error: return_result.data is ${serialized.length} characters; limit is ${maxDataChars}. ` +
              'Write large deliverables to workspace files, then retry with data containing only ' +
              'the file paths, hashes, test results, and remaining issues.',
            isError: true,
          }
        }
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
