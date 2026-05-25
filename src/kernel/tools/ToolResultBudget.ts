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

function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return content.slice(0, maxChars) + TRUNCATION_NOTICE
}

/**
 * Apply tool result budget to a message array.
 * Returns a new message array with oversized tool results truncated.
 */
export function applyToolResultBudget(
  messages: readonly KernelMessage[],
  tools: readonly KernelTool[],
): KernelMessage[] {
  const limits = buildLimits(tools)
  if (limits.size === 0) return [...messages]

  const toolUseIdToName = buildToolUseIdToNameMap(messages)

  return messages.map(msg => {
    if (msg.role !== 'user') return msg

    let changed = false
    const newContent = msg.content.map((block: ContentBlock): ContentBlock => {
      if (block.type !== 'tool_result') return block

      const toolName = toolUseIdToName.get(block.tool_use_id)
      if (!toolName) return block

      const limit = limits.get(toolName)
      if (limit === undefined) return block

      // Handle string content
      if (typeof block.content === 'string' && block.content.length > limit) {
        changed = true
        return { ...block, content: truncateContent(block.content, limit) }
      }

      // Handle array content (find text blocks)
      if (Array.isArray(block.content)) {
        let innerChanged = false
        const newInner = (block.content as ContentBlock[]).map(inner => {
          if (inner.type === 'text' && inner.text.length > limit) {
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
  })
}
