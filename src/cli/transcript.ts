/**
 * cli/transcript — turning conversation messages into short display strings.
 *
 * Shared by the session picker, the resume banner and the flash side-calls, so
 * a prompt preview looks the same everywhere it appears.
 *
 * Extracted from cli/index.ts.
 */
import type { ConversationMessage } from '../core/types.js'
import { sanitizeTerminalPreview } from './terminalSanitizer.js'

export function renderPromptContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts = content.map(block => {
    if (!block || typeof block !== 'object') return ''
    const item = block as Record<string, unknown>
    if (item['type'] === 'text' && typeof item['text'] === 'string') return item['text']
    if (item['type'] === 'tool_use') {
      const name = typeof item['name'] === 'string' ? item['name'] : 'tool'
      return `[tool_use: ${name}]`
    }
    if (item['type'] === 'tool_result') {
      const result = item['content']
      if (typeof result === 'string') return `[tool_result] ${result}`
      return '[tool_result]'
    }
    return ''
  }).filter(Boolean)

  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60)    return `${s}秒前`
  const m = Math.floor(s / 60)
  if (m < 60)    return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24)    return `${h}小时前`
  return `${Math.floor(h / 24)}天前`
}

export function sessionPromptPreview(firstPrompt: string, limit: number): string {
  return sanitizeTerminalPreview(extractPromptPreviewText(firstPrompt), limit)
}

function extractPromptPreviewText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown
    const rendered = renderPromptContent(parsed)
    if (rendered) return rendered
  } catch {
    const rendered = renderTruncatedJsonPromptPreview(raw)
    if (rendered) return rendered
  }
  return raw
}

function renderTruncatedJsonPromptPreview(raw: string): string {
  const textMatch = raw.match(/"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"((?:\\.|[^"\\])*)/)
  if (textMatch?.[1]) {
    try {
      return JSON.parse(`"${textMatch[1]}"`) as string
    } catch {
      return textMatch[1]
    }
  }
  if (/"type"\s*:\s*"tool_result"/.test(raw)) return '[tool_result] historical tool output'
  if (/"type"\s*:\s*"tool_use"/.test(raw)) return '[tool_use] historical tool call'
  return ''
}

export function firstPromptFromMessage(message: ConversationMessage | undefined, fallback: string): string {
  if (!message) return fallback.slice(0, 80)
  return renderPromptContent(message.content).slice(0, 80) || fallback.slice(0, 80)
}

export function findSessionPreviewMessage(messages: readonly ConversationMessage[]): ConversationMessage | undefined {
  const realUser = messages.find(message => {
    if (message.role !== 'user') return false
    const meta = message as unknown as Record<string, unknown>
    if (meta['isCompactSummary'] || meta['isCompactBoundary'] || meta['sourceToolAssistantUUID']) return false
    const text = renderPromptContent(message.content)
    return text.length > 0 && !text.startsWith('[Local resume summary]')
  })
  if (realUser) return realUser

  return messages.find(message => {
    if (message.role !== 'user') return false
    return renderPromptContent(message.content).length > 0
  })
}
