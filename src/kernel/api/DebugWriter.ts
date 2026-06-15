/**
 * DebugWriter — writes LLM request + response chunks to disk for debug mode.
 *
 * File layout:
 *   ~/.meta-agent/debug/<sessionId>/<ISO-timestamp>-<model>.jsonl   — machine格式
 *   ~/.meta-agent/debug/<sessionId>/<ISO-timestamp>-<model>.md      — 人读格式
 *
 * JSONL (unchanged):
 *   Line 0 : { "type": "request", "ts": <iso>, "payload": { ...req params (no apiKey) } }
 *   Line 1 : { "type": "done",    "ts": <iso> }
 *
 * Markdown (content-only, NOT a JSON dump):
 *   发送侧 — system prompt 全文 + 每条消息的实际内容（text 原文、tool_use 的
 *   工具名+入参、tool_result 的返回内容），Anthropic 与 OpenAI/DeepSeek 两种
 *   请求形状都支持。
 *   返回侧 — 从归一化流事件累积（recordStreamEvent），按 thinking / text /
 *   tool_use 渲染，close() 时一次性追加。
 *
 * Usage:
 *   const writer = await DebugWriter.open(sessionId, model, debug)
 *   await writer.writeRequest(reqParams)
 *   …for each stream event: writer.recordStreamEvent(event)
 *   await writer.close()
 */

import { homedir } from 'os'
import { join } from 'path'
import { mkdir, open, readdir, rm, stat } from 'fs/promises'
import type { FileHandle } from 'fs/promises'

const DEBUG_ROOT = join(homedir(), '.meta-agent', 'debug')
const DEFAULT_DEBUG_TTL_MS = 14 * 24 * 60 * 60 * 1000   // 14 days
const DEFAULT_SESSION_DIR_SIZE_CAP = 200 * 1024 * 1024   // 200 MB per session

/**
 * S4: Best-effort cleanup of stale debug data.
 *
 * Two passes:
 *   1. Age pass — any session directory whose newest file is older than
 *      `ttlMs` (default 14 days) is removed in full.
 *   2. Size pass — within each surviving session directory, if total size
 *      exceeds `sessionSizeCapBytes`, the oldest `.jsonl` files are removed
 *      until under cap.
 *
 * Both passes swallow every error: this runs from session shutdown paths
 * where I/O failures must never block the host.  Returns a summary so
 * callers can log it if desired.
 */
export interface DebugPurgeOptions {
  /** Sessions whose newest file is older than this are deleted. */
  ttlMs?: number
  /** Per-session-directory size cap (bytes). */
  sessionSizeCapBytes?: number
  /** Override the debug root (mostly for tests). */
  rootDir?: string
}

export interface DebugPurgeSummary {
  scannedSessions: number
  removedSessions: number
  trimmedFiles: number
  bytesFreed: number
}

export async function pruneStaleDebug(
  options: DebugPurgeOptions = {},
): Promise<DebugPurgeSummary> {
  const ttlMs = options.ttlMs ?? DEFAULT_DEBUG_TTL_MS
  const sessionCap = options.sessionSizeCapBytes ?? DEFAULT_SESSION_DIR_SIZE_CAP
  const root = options.rootDir ?? DEBUG_ROOT
  const summary: DebugPurgeSummary = {
    scannedSessions: 0, removedSessions: 0, trimmedFiles: 0, bytesFreed: 0,
  }
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return summary  // debug dir never created — nothing to do
  }
  const now = Date.now()
  for (const sessionId of entries) {
    summary.scannedSessions++
    const sessionDir = join(root, sessionId)
    let files: string[]
    try { files = await readdir(sessionDir) } catch { continue }
    // Collect (name, size, mtime) for each file; tolerate stat errors.
    const records: Array<{ name: string; size: number; mtime: number }> = []
    let newestMtime = 0
    let totalSize = 0
    for (const name of files) {
      try {
        const s = await stat(join(sessionDir, name))
        if (!s.isFile()) continue
        records.push({ name, size: s.size, mtime: s.mtimeMs })
        if (s.mtimeMs > newestMtime) newestMtime = s.mtimeMs
        totalSize += s.size
      } catch { /* skip */ }
    }
    // Age pass — whole directory.
    if (records.length === 0 || (newestMtime > 0 && now - newestMtime > ttlMs)) {
      try {
        await rm(sessionDir, { recursive: true, force: true })
        summary.removedSessions++
        summary.bytesFreed += totalSize
      } catch { /* ignore */ }
      continue
    }
    // Size pass — drop oldest until under cap.
    if (totalSize > sessionCap) {
      records.sort((a, b) => a.mtime - b.mtime)
      for (const rec of records) {
        if (totalSize <= sessionCap) break
        try {
          await rm(join(sessionDir, rec.name), { force: true })
          totalSize -= rec.size
          summary.bytesFreed += rec.size
          summary.trimmedFiles++
        } catch { /* ignore */ }
      }
    }
  }
  return summary
}

function isoNow(): string {
  return new Date().toISOString()
}

/** Sanitise model string for use in a filename (replace `/` and `:` etc.) */
function safeModel(model: string): string {
  return model.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
}

// ── Markdown rendering helpers (content-only view) ───────────────────────────

function prettyJson(value: unknown): string {
  try {
    if (typeof value === 'string') {
      try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
    }
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Wrap arbitrary content in a code fence whose length always beats any
 * backtick run inside the content — raw tool output / file dumps can contain
 * ``` themselves and would otherwise break the document structure.
 */
function fenced(content: string, lang = ''): string {
  const longestRun = content.match(/`+/g)?.reduce((m, run) => Math.max(m, run.length), 0) ?? 0
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}${lang}\n${content}\n${fence}`
}

/** Render text as a blockquote (used for thinking). */
function quoted(text: string): string {
  return text.split('\n').map(line => `> ${line}`).join('\n')
}

const ROLE_ICONS: Record<string, string> = {
  user: '👤',
  assistant: '🤖',
  system: '⚙️',
  tool: '🧰',
}

/** Render one content block (Anthropic shape) to markdown lines. */
function renderBlockMd(block: Record<string, unknown>): string {
  switch (block['type']) {
    case 'text':
      // Natural-language content — keep raw so it reads as prose/markdown.
      return String(block['text'] ?? '')
    case 'thinking':
      return `**💭 thinking**\n\n${quoted(String(block['thinking'] ?? ''))}`
    case 'redacted_thinking':
      return '**💭 redacted_thinking**'
    case 'tool_use':
      return `**🔧 tool_use → \`${String(block['name'] ?? '')}\`**\n\n${fenced(prettyJson(block['input']), 'json')}`
    case 'tool_result': {
      const error = block['is_error'] ? ' · ❌ ERROR' : ''
      const header = `**🧰 tool_result ← \`${String(block['tool_use_id'] ?? '')}\`${error}**`
      const content = block['content']
      if (typeof content === 'string') return `${header}\n\n${fenced(content, 'text')}`
      if (Array.isArray(content)) {
        const inner = content
          .map(item => {
            if (!item || typeof item !== 'object') return String(item)
            const b = item as Record<string, unknown>
            // Inner text blocks are tool OUTPUT — fence them, unlike message text.
            if (b['type'] === 'text') return fenced(String(b['text'] ?? ''), 'text')
            return renderBlockMd(b)
          })
          .filter(Boolean)
          .join('\n\n')
        return `${header}\n\n${inner}`
      }
      return header
    }
    case 'image':
      return '*🖼 [image omitted]*'
    default:
      return `*[${String(block['type'] ?? 'unknown')}]*`
  }
}

/** Render one message (Anthropic MessageParam OR OpenAI chat message) to markdown. */
function renderMessageMd(message: Record<string, unknown>, index: number): string {
  let role = String(message['role'] ?? 'unknown')
  let suffix = ''
  // OpenAI shape: a `tool` role message is a tool result.
  if (role === 'tool' && message['tool_call_id']) {
    suffix = ` · tool_result ← \`${String(message['tool_call_id'])}\``
  }
  const icon = ROLE_ICONS[role] ?? '❔'
  const parts: string[] = [`### ${index} · ${icon} ${role}${suffix}`]

  const content = message['content']
  if (typeof content === 'string') {
    if (content) parts.push(role === 'tool' ? fenced(content, 'text') : content)
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        parts.push(renderBlockMd(block as Record<string, unknown>))
      }
    }
  }

  // OpenAI shape: assistant tool_calls
  const toolCalls = message['tool_calls']
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      const fn = (call as Record<string, unknown>)['function'] as Record<string, unknown> | undefined
      parts.push(
        `**🔧 tool_use → \`${String(fn?.['name'] ?? '')}\`**\n\n${fenced(prettyJson(fn?.['arguments']), 'json')}`,
      )
    }
  }

  return parts.join('\n\n')
}

/**
 * Render the request payload as content-only markdown.
 * Supports both wire shapes:
 *   Anthropic — { system?: string, messages: MessageParam[] }
 *   OpenAI    — { messages: [{role:'system'|'user'|'assistant'|'tool', …}] }
 */
function renderRequestMarkdown(payload: Record<string, unknown>): string {
  // System prompt: Anthropic top-level `system`, or OpenAI leading system message
  const messages = Array.isArray(payload['messages'])
    ? payload['messages'] as Array<Record<string, unknown>>
    : []
  let bodyMessages = messages
  let system = typeof payload['system'] === 'string' ? payload['system'] as string : ''
  if (!system && messages[0]?.['role'] === 'system' && typeof messages[0]?.['content'] === 'string') {
    system = messages[0]['content'] as string
    bodyMessages = messages.slice(1)
  }

  const lines: string[] = [
    `# 📤 发送给 LLM`,
    '',
    `| 模型 | 时间 | 消息数 |`,
    `|---|---|---|`,
    `| \`${String(payload['model'] ?? 'unknown-model')}\` | ${isoNow()} | ${bodyMessages.length} |`,
    '',
    '---',
    '',
    // System prompt is itself markdown — keep raw so it reads naturally.
    '## ⚙️ System Prompt',
    '',
    system || '*(empty)*',
    '',
    '---',
    '',
    `## 💬 Messages（${bodyMessages.length} 条）`,
    '',
  ]
  bodyMessages.forEach((message, i) => {
    lines.push(renderMessageMd(message, i + 1), '')
  })

  return lines.join('\n')
}

/** Accumulated response block (normalized stream-event shape). */
interface ResponseBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'other'
  text: string
  name?: string
}

export class DebugWriter {
  private readonly _responseBlocks = new Map<number, ResponseBlock>()
  private _stopReason: string | null = null
  private _responseWritten = false

  private constructor(
    private readonly fh: FileHandle,
    private readonly mdFh: FileHandle | null,
  ) {}

  /** Open (create) a new debug file for one LLM call. Returns null when debug is disabled. */
  static async open(
    sessionId: string | undefined,
    model: string,
    debug: boolean | undefined,
    rootDir?: string,
  ): Promise<DebugWriter | null> {
    if (!debug || !sessionId) return null

    const dir = join(rootDir ?? join(homedir(), '.meta-agent', 'debug'), sessionId)
    await mkdir(dir, { recursive: true })

    const ts = isoNow().replace(/[:.]/g, '-')
    const base = `${ts}-${safeModel(model)}`

    const fh = await open(join(dir, `${base}.jsonl`), 'a')
    // Markdown twin is best-effort — its failure must never disable debug jsonl.
    const mdFh = await open(join(dir, `${base}.md`), 'a').catch(() => null)
    return new DebugWriter(fh, mdFh)
  }

  /** Write the full request payload (apiKey is stripped for safety). */
  async writeRequest(payload: Record<string, unknown>): Promise<void> {
    // Strip sensitive fields
    const { apiKey: _apiKey, ...safe } = payload as Record<string, unknown>
    void _apiKey
    const line = JSON.stringify({ type: 'request', ts: isoNow(), payload: safe })
    await this.fh.write(line + '\n')
    if (this.mdFh) {
      await this.mdFh.write(renderRequestMarkdown(safe) + '\n').catch(() => undefined)
    }
  }

  /**
   * Accumulate a normalized stream event (both clients emit the Anthropic
   * event shape). Synchronous and allocation-light — called per chunk on the
   * hot streaming path; rendering happens once at close().
   */
  recordStreamEvent(event: unknown): void {
    if (!this.mdFh || !event || typeof event !== 'object') return
    const e = event as Record<string, unknown>

    if (e['type'] === 'content_block_start') {
      const index = Number(e['index'] ?? 0)
      const cb = (e['content_block'] ?? {}) as Record<string, unknown>
      const type = cb['type'] === 'text' || cb['type'] === 'thinking' || cb['type'] === 'tool_use'
        ? cb['type'] as ResponseBlock['type']
        : 'other'
      this._responseBlocks.set(index, {
        type,
        text: '',
        ...(cb['name'] ? { name: String(cb['name']) } : {}),
      })
      return
    }

    if (e['type'] === 'content_block_delta') {
      const block = this._responseBlocks.get(Number(e['index'] ?? 0))
      if (!block) return
      const delta = (e['delta'] ?? {}) as Record<string, unknown>
      if (delta['type'] === 'text_delta') block.text += String(delta['text'] ?? '')
      else if (delta['type'] === 'thinking_delta') block.text += String(delta['thinking'] ?? '')
      else if (delta['type'] === 'input_json_delta') block.text += String(delta['partial_json'] ?? '')
      return
    }

    if (e['type'] === 'message_delta') {
      const delta = (e['delta'] ?? {}) as Record<string, unknown>
      if (typeof delta['stop_reason'] === 'string') this._stopReason = delta['stop_reason']
    }
  }

  /** Render the accumulated response markdown once. */
  private async _flushResponseMarkdown(): Promise<void> {
    if (!this.mdFh || this._responseWritten) return
    this._responseWritten = true

    const lines: string[] = ['', '---', '', `# 📥 LLM 返回`, '', `*时间：${isoNow()}*`, '']
    if (this._responseBlocks.size === 0) {
      lines.push('*(no content received)*', '')
    }
    const ordered = [...this._responseBlocks.entries()].sort((a, b) => a[0] - b[0])
    for (const [, block] of ordered) {
      if (block.type === 'text') {
        lines.push(block.text, '')
      } else if (block.type === 'thinking') {
        lines.push('**💭 thinking**', '', quoted(block.text), '')
      } else if (block.type === 'tool_use') {
        lines.push(`**🔧 tool_use → \`${block.name ?? ''}\`**`, '', fenced(prettyJson(block.text), 'json'), '')
      }
    }
    if (this._stopReason) lines.push(`*stop_reason：\`${this._stopReason}\`*`, '')
    await this.mdFh.write(lines.join('\n')).catch(() => undefined)
  }

  /** Write a done sentinel and close the file handles. */
  async close(): Promise<void> {
    try {
      const line = JSON.stringify({ type: 'done', ts: isoNow() })
      await this.fh.write(line + '\n')
      await this._flushResponseMarkdown()
    } finally {
      await this.fh.close()
      if (this.mdFh) await this.mdFh.close().catch(() => undefined)
    }
  }
}
