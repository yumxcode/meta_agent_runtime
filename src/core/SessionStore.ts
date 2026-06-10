/**
 * SessionStore — persistent conversation history for session resume.
 *
 * Storage layout under ~/.meta-agent/sessions/:
 *   index.json                           — list of all sessions (newest first)
 *   <sessionId>/history.jsonl            — newline-delimited ConversationMessage records
 *
 * Design decisions:
 *   - JSONL (append-only) for history so every message is written atomically
 *     without rewriting the entire conversation on each turn.
 *   - The index is rewritten on each save (small, bounded by MAX_INDEX_ENTRIES).
 *   - All I/O is best-effort: errors are swallowed so a disk failure never
 *     crashes the CLI session in progress.
 */

import { readFile, appendFile, mkdir, open, stat, rm, writeFile } from 'node:fs/promises'
import { atomicWriteJson } from './persist/index.js'
import { SessionMetaSchema, parseArrayFiltered } from './persist/schemas.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ConversationMessage } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────

const SESSIONS_ROOT = join(homedir(), '.meta-agent', 'sessions')
const INDEX_FILE    = join(SESSIONS_ROOT, 'index.json')
const MAX_INDEX_ENTRIES = 50   // keep last 50 sessions in the index
const MAX_RESUME_BYTES = 5 * 1024 * 1024
const MAX_RESUME_MESSAGES = 200
const RESUME_SUMMARY_RECENT_USER_LIMIT = 8
const RESUME_SUMMARY_RECENT_ASSISTANT_LIMIT = 6
const RESUME_SUMMARY_TEXT_LIMIT = 1_000

// ── Public types ─────────────────────────────────────────────────────────────

export interface SessionMeta {
  sessionId: string
  mode: string
  startTime: number
  lastActivity: number
  messageCount: number
  /** First ~80 chars of the first user prompt — picker fallback when no title. */
  firstPrompt: string
  workspace?: string
  /** Flash-generated concise title (≤ ~16 chars). Preferred picker display. */
  title?: string
  /** messageCount when the title was generated — drives refresh cadence. */
  titleMessageCount?: number
}

export interface SessionListOptions {
  workspace?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sessionDir(sessionId: string): string {
  return join(SESSIONS_ROOT, sessionId)
}

function historyPath(sessionId: string): string {
  return join(sessionDir(sessionId), 'history.jsonl')
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

function stripThinkingForStorage(message: ConversationMessage): ConversationMessage {
  if (!Array.isArray(message.content)) return message
  const content = message.content.filter(block =>
    block.type !== 'thinking' && block.type !== 'redacted_thinking',
  )
  if (content.length === message.content.length) return message
  return { ...message, content } as ConversationMessage
}

function serializeMessages(messages: readonly ConversationMessage[]): string {
  if (messages.length === 0) return ''
  return messages
    .map(stripThinkingForStorage)
    .filter(m => !Array.isArray(m.content) || m.content.length > 0)
    .map(m => JSON.stringify(m))
    .join('\n') + '\n'
}

function contentBlocks(message: ConversationMessage): Array<Record<string, unknown>> {
  return Array.isArray(message.content)
    ? message.content as Array<Record<string, unknown>>
    : [{ type: 'text', text: message.content }]
}

function textFromMessage(message: ConversationMessage): string {
  return contentBlocks(message)
    .filter(block => block['type'] === 'text' && typeof block['text'] === 'string')
    .map(block => block['text'] as string)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(text: string, limit = RESUME_SUMMARY_TEXT_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 16))}... [truncated]`
}

function buildLocalResumeSummary(
  omitted: readonly ConversationMessage[],
  retainedCount: number,
  parsedCount: number,
): ConversationMessage | null {
  if (omitted.length === 0) return null

  const toolUseCounts = new Map<string, number>()
  let toolResultCount = 0
  let toolResultErrorCount = 0
  let toolResultChars = 0

  const userTexts: string[] = []
  const assistantTexts: string[] = []

  for (const message of omitted) {
    const text = textFromMessage(message)
    if (text) {
      if (message.role === 'user') userTexts.push(text)
      else assistantTexts.push(text)
    }

    for (const block of contentBlocks(message)) {
      if (block['type'] === 'tool_use') {
        const name = typeof block['name'] === 'string' ? block['name'] : 'unknown'
        toolUseCounts.set(name, (toolUseCounts.get(name) ?? 0) + 1)
      } else if (block['type'] === 'tool_result') {
        toolResultCount++
        if (block['is_error']) toolResultErrorCount++
        if (typeof block['content'] === 'string') toolResultChars += block['content'].length
      }
    }
  }

  const firstUser = userTexts[0]
  const recentUsers = userTexts.slice(-RESUME_SUMMARY_RECENT_USER_LIMIT)
  const recentAssistant = assistantTexts.slice(-RESUME_SUMMARY_RECENT_ASSISTANT_LIMIT)
  const toolUseSummary = [...toolUseCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([name, count]) => `- ${name}: ${count}`)

  const lines = [
    '[Local resume summary]',
    `This session was resumed from ${parsedCount} stored messages. Earlier history (${omitted.length} messages) was summarized locally; the most recent ${retainedCount} messages are preserved after this summary.`,
    'Older tool outputs are not fully included here. Re-run tools or re-read files before relying on exact historical output.',
    '',
    '## First User Request',
    firstUser ? `- ${clip(firstUser)}` : '- No earlier user text was available.',
    '',
    '## Recent Earlier User Messages',
    ...(recentUsers.length > 0 ? recentUsers.map(text => `- ${clip(text)}`) : ['- None.']),
    '',
    '## Recent Earlier Assistant Messages',
    ...(recentAssistant.length > 0 ? recentAssistant.map(text => `- ${clip(text)}`) : ['- None.']),
    '',
    '## Earlier Tool Activity',
    ...(toolUseSummary.length > 0 ? toolUseSummary : ['- No earlier tool_use blocks.']),
    `- tool_result blocks: ${toolResultCount} (${toolResultErrorCount} errors, ${toolResultChars} chars total)`,
  ]

  return { role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }
}

function toolUseIdsIn(messages: readonly ConversationMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (block['type'] === 'tool_use' && typeof block['id'] === 'string') {
        ids.add(block['id'])
      }
    }
  }
  return ids
}

function hasToolResult(message: ConversationMessage): boolean {
  return contentBlocks(message).some(block => block['type'] === 'tool_result')
}

function hasOnlyToolResults(message: ConversationMessage): boolean {
  const blocks = contentBlocks(message)
  return blocks.length > 0 && blocks.every(block => block['type'] === 'tool_result')
}

function startsWithOrphanToolResult(messages: readonly ConversationMessage[]): boolean {
  const first = messages[0]
  if (!first || !hasToolResult(first)) return false
  const toolUseIds = toolUseIdsIn(messages)
  return contentBlocks(first)
    .filter(block => block['type'] === 'tool_result')
    .some(block => typeof block['tool_use_id'] === 'string' && !toolUseIds.has(block['tool_use_id']))
}

function trimToSafeResumeBoundary(messages: readonly ConversationMessage[]): ConversationMessage[] {
  let start = 0
  while (start < messages.length) {
    const candidate = messages.slice(start)
    const first = candidate[0]
    if (!first) break
    if (startsWithOrphanToolResult(candidate) || hasOnlyToolResults(first)) {
      start++
      continue
    }
    break
  }
  return messages.slice(start)
}

function buildResumedHistory(parsed: readonly ConversationMessage[]): ConversationMessage[] {
  if (parsed.length <= MAX_RESUME_MESSAGES) {
    return trimToSafeResumeBoundary(parsed)
  }

  const recentLimit = MAX_RESUME_MESSAGES - 1
  const recentRaw = parsed.slice(-recentLimit)
  const recent = trimToSafeResumeBoundary(recentRaw)
  const omitted = parsed.slice(0, parsed.length - recentRaw.length + (recentRaw.length - recent.length))
  const summary = buildLocalResumeSummary(omitted, recent.length, parsed.length)

  return summary ? [summary, ...recent] : recent
}

async function readIndex(): Promise<SessionMeta[]> {
  try {
    const raw = await readFile(INDEX_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    // Validate each entry; silently drop corrupt records so a partial migration
    // never causes all sessions to disappear from the picker.
    const { valid, dropped } = parseArrayFiltered(SessionMetaSchema, parsed)
    if (dropped > 0) {
      console.warn(`[SessionStore] Dropped ${dropped} corrupt session index entries`)
    }
    return valid as SessionMeta[]
  } catch {
    return []
  }
}

async function writeIndex(entries: SessionMeta[]): Promise<void> {
  await ensureDir(SESSIONS_ROOT)
  await atomicWriteJson(INDEX_FILE, entries)
}

// ── SessionStore ──────────────────────────────────────────────────────────────

export class SessionStore {
  /**
   * Append a batch of new messages to the session's history file.
   * Idempotent: only messages after `appendFrom` index are written.
   *
   * @param sessionId    UUID of the session.
   * @param meta         Metadata to update in the index.
   * @param messages     Full current message list.
   * @param appendFrom   Index of the first NEW message (skip already-written ones).
   */
  static async append(
    sessionId: string,
    meta: Omit<SessionMeta, 'sessionId'>,
    messages: readonly ConversationMessage[],
    appendFrom: number,
  ): Promise<void> {
    if (messages.length === 0 || appendFrom >= messages.length) return
    try {
      await ensureDir(sessionDir(sessionId))
      const lines = serializeMessages(messages.slice(appendFrom))
      await appendFile(historyPath(sessionId), lines, 'utf-8')
      await SessionStore._upsertIndex({ sessionId, ...meta })
    } catch {
      // Best-effort — never crash the session on a storage failure
    }
  }

  /**
   * Replace a session's persisted history with the current in-memory message
   * list. Used after compaction, where the message array shrinks and append-by-
   * index can no longer represent the authoritative history.
   */
  static async replace(
    sessionId: string,
    meta: Omit<SessionMeta, 'sessionId'>,
    messages: readonly ConversationMessage[],
  ): Promise<void> {
    try {
      await ensureDir(sessionDir(sessionId))
      await writeFile(historyPath(sessionId), serializeMessages(messages), 'utf-8')
      await SessionStore._upsertIndex({ sessionId, ...meta })
    } catch {
      // Best-effort — never crash the session on a storage failure
    }
  }

  /**
   * Load the full conversation history for a session.
   * Returns [] if the history file doesn't exist.
   */
  static async loadHistory(sessionId: string): Promise<ConversationMessage[]> {
    try {
      const path = historyPath(sessionId)
      const info = await stat(path)
      let raw: string
      if (info.size > MAX_RESUME_BYTES) {
        const fh = await open(path, 'r')
        try {
          const buffer = Buffer.alloc(MAX_RESUME_BYTES)
          await fh.read(buffer, 0, MAX_RESUME_BYTES, info.size - MAX_RESUME_BYTES)
          raw = buffer.toString('utf-8')
          const firstNewline = raw.indexOf('\n')
          if (firstNewline >= 0) raw = raw.slice(firstNewline + 1)
        } finally {
          await fh.close()
        }
      } else {
        raw = await readFile(path, 'utf-8')
      }
      const parsed = raw
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as ConversationMessage)
      return buildResumedHistory(parsed)
    } catch {
      return []
    }
  }

  /**
   * Return the session index, newest first.
   * @param limit  Maximum number of entries to return (default: 10).
   */
  static async listSessions(limit = 10, options: SessionListOptions = {}): Promise<SessionMeta[]> {
    const index = await readIndex()
    const workspace = options.workspace
    const filtered = workspace
      ? index.filter(entry => entry.workspace === workspace)
      : index
    return filtered.slice(0, limit)
  }

  /**
   * Return one session metadata record by ID, or null if it is not indexed.
   */
  static async getSession(sessionId: string): Promise<SessionMeta | null> {
    const index = await readIndex()
    return index.find(entry => entry.sessionId === sessionId) ?? null
  }

  /**
   * Check whether a session directory exists (quick existence check).
   */
  static sessionExists(sessionId: string): boolean {
    return existsSync(historyPath(sessionId))
  }

  /**
   * Delete a single session: remove from index + delete its directory.
   */
  static async deleteSession(sessionId: string): Promise<void> {
    try {
      // Remove from index
      const entries = await readIndex()
      const filtered = entries.filter(e => e.sessionId !== sessionId)
      await writeIndex(filtered)
      // Remove directory (best-effort)
      await rm(sessionDir(sessionId), { recursive: true, force: true })
    } catch {
      // Best-effort
    }
  }

  /**
   * Delete ALL sessions: clear index + remove every session directory.
   */
  static async deleteAllSessions(): Promise<void> {
    try {
      const entries = await readIndex()
      await writeIndex([])
      await Promise.all(
        entries.map(e => rm(sessionDir(e.sessionId), { recursive: true, force: true })),
      )
    } catch {
      // Best-effort
    }
  }

  /**
   * Set/refresh the generated title on an indexed session. No-op when the
   * session is not in the index. Best-effort like all SessionStore writes.
   */
  static async updateTitle(
    sessionId: string,
    title: string,
    titleMessageCount: number,
  ): Promise<void> {
    try {
      const entries = await readIndex()
      const idx = entries.findIndex(e => e.sessionId === sessionId)
      if (idx < 0) return
      entries[idx] = { ...entries[idx]!, title, titleMessageCount }
      await writeIndex(entries)
    } catch {
      // Best-effort
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private static async _upsertIndex(meta: SessionMeta): Promise<void> {
    const entries = await readIndex()
    const idx = entries.findIndex(e => e.sessionId === meta.sessionId)
    if (idx >= 0) {
      // Merge-preserve: per-turn persists rebuild meta WITHOUT the title fields;
      // a plain replace would wipe the generated title on every turn.
      entries[idx] = { ...entries[idx], ...meta }
    } else {
      entries.unshift(meta)
    }
    // Sort newest-first by lastActivity, then keep index bounded.
    // Sort before slice so the most-recently-active sessions always survive the cap.
    entries.sort((a, b) => b.lastActivity - a.lastActivity)
    await writeIndex(entries.slice(0, MAX_INDEX_ENTRIES))
  }
}
