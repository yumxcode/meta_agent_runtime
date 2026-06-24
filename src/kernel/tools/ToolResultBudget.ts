/**
 * ToolResultBudget — truncate oversized tool results to prevent context overflow.
 *
 * Mirrors CC's applyToolResultBudget (query.ts ~line 369-394).
 *
 * For each tool_result content block, if the content string exceeds the tool's
 * maxResultSizeChars, truncate it and append a note.
 */
import type { KernelMessage, ContentBlock } from '../types/KernelMessage.js'
import type { KernelTool } from '../types/KernelTool.js'

const TRUNCATION_NOTICE =
  '\n\n[Content truncated: result exceeded maximum allowed size. ' +
  'Use more targeted queries to retrieve specific information.]'

/**
 * Build a map of tool name → maxResultSizeChars for tools that have a limit.
 * Tools without maxResultSizeChars are exempt from truncation.
 */
function buildLimits(tools: readonly KernelTool[]): Map<string, number> {
  const limits = new Map<string, number>()
  for (const tool of tools) {
    if (tool.maxResultSizeChars !== undefined && isFinite(tool.maxResultSizeChars)) {
      limits.set(tool.name, tool.maxResultSizeChars)
      // Also register aliases
      for (const alias of tool.aliases ?? []) {
        limits.set(alias, tool.maxResultSizeChars)
      }
    }
  }
  return limits
}

/**
 * We need to map tool_use_id → tool_name to apply the right limit.
 * Build this index from the messages.
 */
function buildToolUseIdToNameMap(messages: readonly KernelMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          map.set(block.id, block.name)
        }
      }
    }
  }
  return map
}

/**
 * A string is considered already-budgeted when it carries our truncation
 * marker. truncateContent appends TRUNCATION_NOTICE, so the result is strictly
 * longer than the limit — without this check, every subsequent pass would
 * re-slice and re-allocate the same already-clipped block, churning GC on long
 * sessions (the whole history is re-budgeted on every loop turn).
 */
function isAlreadyTruncated(content: string): boolean {
  return content.endsWith(TRUNCATION_NOTICE)
}

function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  if (isAlreadyTruncated(content)) return content   // idempotent: leave as-is
  return content.slice(0, maxChars) + TRUNCATION_NOTICE
}

/**
 * Budget a single message. Returns the SAME reference when nothing changed so
 * callers can detect no-ops by identity and skip re-allocating.
 */
function budgetMessage(
  msg: KernelMessage,
  limits: Map<string, number>,
  toolUseIdToName: Map<string, string>,
): KernelMessage {
  if (msg.role !== 'user') return msg

  let changed = false
  const newContent = msg.content.map((block: ContentBlock): ContentBlock => {
    if (block.type !== 'tool_result') return block

    const toolName = toolUseIdToName.get(block.tool_use_id)
    if (!toolName) return block

    const limit = limits.get(toolName)
    if (limit === undefined) return block

    // Handle string content
    if (typeof block.content === 'string'
      && block.content.length > limit
      && !isAlreadyTruncated(block.content)) {
      changed = true
      return { ...block, content: truncateContent(block.content, limit) }
    }

    // Handle array content (find text blocks)
    if (Array.isArray(block.content)) {
      let innerChanged = false
      const newInner = (block.content as ContentBlock[]).map(inner => {
        if (inner.type === 'text'
          && inner.text.length > limit
          && !isAlreadyTruncated(inner.text)) {
          innerChanged = true
          changed = true
          return { ...inner, text: truncateContent(inner.text, limit) }
        }
        return inner
      })
      if (innerChanged) return { ...block, content: newInner as unknown as string }
    }

    return block
  })

  return changed ? { ...msg, content: newContent } : msg
}

/**
 * Apply tool result budget to a message array.
 *
 * Returns a message array with oversized tool results truncated. The result is
 * intended to be READ, not mutated, by callers; to avoid per-turn allocation
 * churn it shares structure with the input:
 *   - when no tool has a size limit, or no message needs truncation, the
 *     original array reference is returned unchanged;
 *   - otherwise the unchanged prefix is copied once (lazily, at the first
 *     change) and unchanged messages keep their original references.
 *
 * Because truncation is idempotent (already-clipped blocks are left untouched),
 * a steady-state long session re-budgets only the freshly-appended tail rather
 * than re-allocating the entire history every loop turn.
 */
export function applyToolResultBudget(
  messages: readonly KernelMessage[],
  tools: readonly KernelTool[],
): KernelMessage[] {
  const limits = buildLimits(tools)
  if (limits.size === 0) return messages as KernelMessage[]

  const toolUseIdToName = buildToolUseIdToNameMap(messages)

  // Lazy copy-on-write: allocate the output array only once a message actually
  // changes, copying the unchanged prefix at that point. The common case (a
  // change confined to the newest tool_result, or no change at all) avoids
  // re-allocating the whole list.
  let out: KernelMessage[] | null = null
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const budgeted = budgetMessage(msg, limits, toolUseIdToName)
    if (out === null && budgeted !== msg) {
      out = messages.slice(0, i)
    }
    if (out !== null) out.push(budgeted)
  }

  return out ?? (messages as KernelMessage[])
}
