/**
 * SessionStore — persistent conversation history for session resume.
 *
 * Storage layout under ~/.meta-agent/sessions/:
 *   index.json                           — list of all sessions (newest first)
 *   <sessionId>/history.jsonl            — newline-delimited ConversationMessage records
 *   <sessionId>/blobs/<sha256>.<ext>     — image bytes, referenced from history
 *
 * Design decisions:
 *   - JSONL (append-only) for history so every message is written atomically
 *     without rewriting the entire conversation on each turn.
 *   - The index is rewritten on each save (small, bounded by MAX_INDEX_ENTRIES).
 *   - History writes surface I/O errors to their caller; CLI callers may
 *     choose best-effort handling, but the store never reports a failed durable
 *     write as success. Divergence between the index count and a caller's
 *     append cursor is self-healed with a full atomic rewrite (warned, never
 *     thrown) so persistence can never silently stall for the rest of a
 *     session. Administrative cleanup remains best-effort.
 */

import { readFile, writeFile, appendFile, mkdir, open, stat, rm, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { atomicWriteFile, atomicWriteJson, withFileLock } from '../infra/persist/index.js'
import { validateStoreId, isValidStoreId, resolveWithinRoot } from '../infra/persist/storeId.js'
import { SessionMetaSchema, parseArrayFiltered } from '../infra/persist/schemas.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationMessage } from './types.js'
import { RuntimeEnv } from '../infra/env/RuntimeEnv.js'
import { META_AGENT_HOME } from './metaAgentHome.js'

// ─────────────────────────────────────────────────────────────────────────────

const SESSIONS_ROOT = join(META_AGENT_HOME, 'sessions')
const MAX_INDEX_ENTRIES = 50   // keep last 50 sessions in the index
// Default 64 MiB read guard. Full history is loaded on resume by default (no
// message-count cap); runtime auto-compaction shrinks it if it overflows the
// model window. Override the message cap with META_AGENT_MAX_RESUME_MESSAGES
// and this byte guard with META_AGENT_MAX_RESUME_BYTES.
const DEFAULT_MAX_RESUME_BYTES = 64 * 1024 * 1024
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
  /** Stable loop workspace identity for cross-workspace resume isolation. */
  workspaceId?: string
  /** Loop instance within workspaceId, when this is a lineage seat. */
  loopInstanceId?: string
  /** Flash-generated concise title (≤ ~16 chars). Preferred picker display. */
  title?: string
  /** messageCount when the title was generated — drives refresh cadence. */
  titleMessageCount?: number
}

export interface SessionListOptions {
  workspace?: string
  rootDir?: string
}

export interface SessionStoreOptions {
  rootDir?: string
  /** Optional optimistic-concurrency guard used by replace(). */
  expectedMessageCount?: number
}

const SESSION_LOCK_OPTIONS = { staleMs: 30 * 60_000, timeoutMs: 60_000 } as const
// Eviction only deletes a session directory after this much idle time. A
// session can be index-evicted while another process is still actively using
// it (>50 live sessions); deleting its history mid-conversation would be data
// loss. A recently-active evicted session keeps its directory — if it persists
// again it re-enters the index; if not, the orphan sweep below reaps it once
// it has been idle past the grace window.
const EVICTION_DELETE_GRACE_MS = 24 * 60 * 60_000   // 24 h; META_AGENT_SESSION_EVICT_GRACE_MS overrides
function evictionGraceMs(): number {
  return RuntimeEnv.sessionEvictGraceMs(EVICTION_DELETE_GRACE_MS)
}

function withSessionLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(target, fn, SESSION_LOCK_OPTIONS)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sessionsRoot(options: SessionStoreOptions = {}): string {
  return options.rootDir ?? SESSIONS_ROOT
}

function indexFile(options: SessionStoreOptions = {}): string {
  return join(sessionsRoot(options), 'index.json')
}

/**
 * Resolve a session's directory, refusing ids that would escape the root.
 *
 * P0-1 (review 2026-08-27): this used a bare `join()`, and `deleteSession()`
 * feeds the result straight into a recursive `rm()`. A `sessionId` of `..`
 * therefore reached one level above the sessions root. Validated on the way in
 * and containment-checked on the way out.
 *
 * @throws {StoreIdError} if `sessionId` is not a safe path segment.
 */
function sessionDir(sessionId: string, options: SessionStoreOptions = {}): string {
  return resolveWithinRoot(sessionsRoot(options), validateStoreId(sessionId, 'sessionId'))
}

function historyPath(sessionId: string, options: SessionStoreOptions = {}): string {
  return resolveWithinRoot(sessionDir(sessionId, options), 'history.jsonl')
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

// ── Image externalisation ─────────────────────────────────────────────────────
//
// Image bytes never enter history.jsonl. A single 1 MB screenshot becomes ~1.4 MB
// of base64 on one line, and a session with a handful of them blows past the
// 64 MiB resume read guard while META_AGENT_MAX_RESUME_MESSAGES — a count, not a
// size — reports everything as fine. Bytes go to a content-addressed blob file
// and the message keeps a reference.
//
// Content addressing means re-attaching the same image across many turns costs
// one file, and `deleteSession`'s recursive rm of the session directory already
// takes the blobs with it.

/** Storage-only image source. Never sent to any provider. */
interface BlobImageSource {
  type: 'blob_ref'
  sha256: string
  media_type: string
  bytes: number
}

const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function blobsDir(sessionId: string, options: SessionStoreOptions = {}): string {
  return resolveWithinRoot(sessionDir(sessionId, options), 'blobs')
}

function blobPath(sessionId: string, sha: string, mediaType: string, options: SessionStoreOptions = {}): string {
  const ext = MEDIA_TYPE_EXTENSIONS[mediaType] ?? 'bin'
  // `sha` is hex from createHash, so it cannot escape; validated anyway because
  // the rehydrate path reads it back from a file an operator may have edited.
  return resolveWithinRoot(blobsDir(sessionId, options), `${validateStoreId(sha, 'blobSha')}.${ext}`)
}

type StoredBlock = Record<string, unknown>

async function externalizeBlock(
  block: StoredBlock,
  sessionId: string,
  options: SessionStoreOptions,
): Promise<StoredBlock> {
  if (block['type'] === 'image') {
    const source = block['source'] as Record<string, unknown> | undefined
    if (!source || source['type'] !== 'base64' || typeof source['data'] !== 'string') return block
    const mediaType = typeof source['media_type'] === 'string' ? source['media_type'] : 'image/png'
    const bytes = Buffer.from(source['data'], 'base64')
    const sha = createHash('sha256').update(bytes).digest('hex')
    const path = blobPath(sessionId, sha, mediaType, options)
    if (!existsSync(path)) {
      await mkdir(blobsDir(sessionId, options), { recursive: true })
      await writeFile(path, bytes)
    }
    const ref: BlobImageSource = { type: 'blob_ref', sha256: sha, media_type: mediaType, bytes: bytes.length }
    return { type: 'image', source: ref }
  }
  if (block['type'] === 'tool_result' && Array.isArray(block['content'])) {
    const content = await Promise.all(
      (block['content'] as StoredBlock[]).map(inner =>
        inner && typeof inner === 'object' ? externalizeBlock(inner, sessionId, options) : inner,
      ),
    )
    return { ...block, content }
  }
  return block
}

async function externalizeImagesForStorage(
  message: ConversationMessage,
  sessionId: string,
  options: SessionStoreOptions,
): Promise<ConversationMessage> {
  if (!Array.isArray(message.content)) return message
  const blocks = message.content as unknown as StoredBlock[]
  if (!blocks.some(hasImageSomewhere)) return message
  const content = await Promise.all(blocks.map(b => externalizeBlock(b, sessionId, options)))
  return { ...message, content } as unknown as ConversationMessage
}

function hasImageSomewhere(block: StoredBlock): boolean {
  if (!block || typeof block !== 'object') return false
  if (block['type'] === 'image') return true
  if (block['type'] === 'tool_result' && Array.isArray(block['content'])) {
    return (block['content'] as StoredBlock[]).some(hasImageSomewhere)
  }
  return false
}

async function rehydrateBlock(
  block: StoredBlock,
  sessionId: string,
  options: SessionStoreOptions,
): Promise<StoredBlock> {
  if (block['type'] === 'image') {
    const source = block['source'] as Record<string, unknown> | undefined
    if (!source || source['type'] !== 'blob_ref' || typeof source['sha256'] !== 'string') return block
    const mediaType = typeof source['media_type'] === 'string' ? source['media_type'] : 'image/png'
    try {
      const bytes = await readFile(blobPath(sessionId, source['sha256'], mediaType, options))
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } }
    } catch {
      // A missing blob must degrade, never abort the resume: the transcript is
      // the valuable part and one unreadable attachment is not worth losing it.
      return { type: 'text', text: '[image: attachment no longer available]' }
    }
  }
  if (block['type'] === 'tool_result' && Array.isArray(block['content'])) {
    const content = await Promise.all(
      (block['content'] as StoredBlock[]).map(inner =>
        inner && typeof inner === 'object' ? rehydrateBlock(inner, sessionId, options) : inner,
      ),
    )
    return { ...block, content }
  }
  return block
}

async function rehydrateImagesFromStorage(
  messages: readonly ConversationMessage[],
  sessionId: string,
  options: SessionStoreOptions,
): Promise<ConversationMessage[]> {
  return Promise.all(messages.map(async message => {
    if (!Array.isArray(message.content)) return message
    const blocks = message.content as unknown as StoredBlock[]
    if (!blocks.some(hasBlobRefSomewhere)) return message
    const content = await Promise.all(blocks.map(b => rehydrateBlock(b, sessionId, options)))
    return { ...message, content } as unknown as ConversationMessage
  }))
}

function hasBlobRefSomewhere(block: StoredBlock): boolean {
  if (!block || typeof block !== 'object') return false
  if (block['type'] === 'image') {
    const source = block['source'] as Record<string, unknown> | undefined
    return source?.['type'] === 'blob_ref'
  }
  if (block['type'] === 'tool_result' && Array.isArray(block['content'])) {
    return (block['content'] as StoredBlock[]).some(hasBlobRefSomewhere)
  }
  return false
}

async function serializeMessages(
  messages: readonly ConversationMessage[],
  sessionId: string,
  options: SessionStoreOptions = {},
): Promise<string> {
  if (messages.length === 0) return ''
  const prepared = await Promise.all(
    messages
      .map(stripThinkingForStorage)
      .filter(m => !Array.isArray(m.content) || m.content.length > 0)
      .map(m => externalizeImagesForStorage(m, sessionId, options)),
  )
  return prepared.map(m => JSON.stringify(m)).join('\n') + '\n'
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

  // isCompactSummary: this is a summary artifact, not a real user request —
  // goal capture and compact anchor selection must skip it (review F-1).
  return {
    role: 'user',
    content: [{ type: 'text', text: lines.join('\n') }],
    isCompactSummary: true,
  }
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

/**
 * Synthesise tool_result blocks for any tool_use left unanswered at the END of
 * a transcript.
 *
 * The producer side (KernelLoop.doneBeforeTools) now guarantees every exit
 * between "assistant turn committed" and "tools ran" writes its own results, but
 * transcripts recorded before that fix are already on disk and cannot be
 * rewritten retroactively. Without this repair they are unresumable: the
 * Messages API rejects a request whose tool_use has no following tool_result, so
 * the first turn after `--resume` fails with a 400 and the session is lost for
 * good.
 *
 * Repair rather than drop: the offending assistant message also carries the
 * model's reasoning text, and discarding it would silently delete the very
 * context the resume exists to recover. A synthetic error result is honest about
 * what happened and keeps the protocol valid.
 */
function repairDanglingToolUse(messages: readonly ConversationMessage[]): ConversationMessage[] {
  const answered = new Set<string>()
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        answered.add(block['tool_use_id'])
      }
    }
  }
  const unanswered: string[] = []
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (block['type'] === 'tool_use' && typeof block['id'] === 'string' && !answered.has(block['id'])) {
        unanswered.push(block['id'])
      }
    }
  }
  if (unanswered.length === 0) return [...messages]
  return [
    ...messages,
    {
      role: 'user',
      content: unanswered.map(id => ({
        type: 'tool_result' as const,
        tool_use_id: id,
        content: 'This tool never ran: the previous session ended before executing it.',
        is_error: true,
      })),
      isMeta: true,
    } as ConversationMessage,
  ]
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

/**
 * Apply the exact boundary/cap policy used by legacy history resume. Exported
 * so the trajectory projector and dual-read parity check share one semantic
 * normalization instead of slowly drifting apart.
 */
export function normalizeResumedHistory(
  parsed: readonly ConversationMessage[],
): ConversationMessage[] {
  // Default: unlimited → replay the FULL history verbatim. Only when an explicit
  // META_AGENT_MAX_RESUME_MESSAGES cap is set (and exceeded) do we fold older
  // history into a single local summary.
  const cap = RuntimeEnv.resumeMaxMessages()
  if (parsed.length <= cap) {
    return repairDanglingToolUse(trimToSafeResumeBoundary(parsed))
  }

  const recentLimit = cap - 1
  const recentRaw = parsed.slice(-recentLimit)
  const recent = trimToSafeResumeBoundary(recentRaw)
  const omitted = parsed.slice(0, parsed.length - recentRaw.length + (recentRaw.length - recent.length))
  const summary = buildLocalResumeSummary(omitted, recent.length, parsed.length)

  // Repair AFTER the head trim and the summary splice, so the dangling scan sees
  // exactly the message list that will go on the wire.
  return repairDanglingToolUse(summary ? [summary, ...recent] : recent)
}

async function readIndex(options: SessionStoreOptions = {}): Promise<SessionMeta[]> {
  try {
    const raw = await readFile(indexFile(options), 'utf-8')
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

async function writeIndex(entries: SessionMeta[], options: SessionStoreOptions = {}): Promise<void> {
  await ensureDir(sessionsRoot(options))
  await atomicWriteJson(indexFile(options), entries)
}

async function loadHistoryUnlocked(
  sessionId: string,
  options: SessionStoreOptions,
): Promise<ConversationMessage[]> {
  const path = historyPath(sessionId, options)
  const info = await stat(path)
  const maxBytes = RuntimeEnv.resumeMaxBytes(DEFAULT_MAX_RESUME_BYTES)
  let raw: string
  if (info.size > maxBytes) {
    const fh = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      await fh.read(buffer, 0, maxBytes, info.size - maxBytes)
      raw = buffer.toString('utf-8')
      const firstNewline = raw.indexOf('\n')
      if (firstNewline >= 0) raw = raw.slice(firstNewline + 1)
    } finally {
      await fh.close()
    }
  } else {
    raw = await readFile(path, 'utf-8')
  }
  const parsed: ConversationMessage[] = []
  let dropped = 0
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      parsed.push(JSON.parse(line) as ConversationMessage)
    } catch {
      dropped++
    }
  }
  if (dropped > 0) {
    console.warn(`[SessionStore] Skipped ${dropped} corrupt history line(s) for session ${sessionId}`)
  }
  return normalizeResumedHistory(await rehydrateImagesFromStorage(parsed, sessionId, options))
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
    options: SessionStoreOptions = {},
  ): Promise<void> {
    if (messages.length === 0 || appendFrom >= messages.length) return
    await ensureDir(sessionDir(sessionId, options))

    // ── Phase 1: history, under the PER-SESSION lock only ────────────────────
    //
    // P3-2 (review 2026-08-27): this whole method used to run inside the GLOBAL
    // index.json lock. History serialisation and a full rewrite — up to the
    // 64 MiB resume guard — therefore blocked every OTHER session's persist,
    // so one large session hitting divergence or compaction stalled the entire
    // host. The expensive work is inherently per-session, so it belongs under
    // the per-session lock.
    //
    // Divergence detection moves in here with it. Reading index.json without
    // its lock is safe (it is only ever written via atomicWriteJson → rename,
    // so a reader sees one complete version or another, never a torn one), and
    // checking it under the SAME lock that guards the subsequent write is
    // strictly more coherent than the old arrangement: two processes appending
    // to one session now serialise on the check-then-write pair.
    await withSessionLock(historyPath(sessionId, options), async () => {
      const current = (await readIndex(options)).find(entry => entry.sessionId === sessionId)
      // The index count and appendFrom legitimately drift apart (resume-boundary
      // trimming, byte-guard truncation, corrupt-line drops, summary folding,
      // thinking-only messages filtered at write time), and two processes
      // resuming the same session diverge too. Throwing here would make callers
      // silently stop persisting for the rest of the session — the worst
      // failure mode. Instead, self-heal: the caller's in-memory transcript is
      // authoritative, so atomically REPLACE the whole history. Concurrent
      // writers degrade to last-coherent-writer-wins with a warning, never to a
      // torn file or a silent persistence stall.
      const conflicted = current !== undefined && current.messageCount !== appendFrom
      if (conflicted) {
        console.warn(
          `[SessionStore] History divergence for ${sessionId}: index has ${current.messageCount} ` +
          `messages, caller expected ${appendFrom}. Rewriting full history from memory.`,
        )
        await atomicWriteFile(historyPath(sessionId, options), await serializeMessages(messages, sessionId, options))
      } else {
        const lines = await serializeMessages(messages.slice(appendFrom), sessionId, options)
        await appendFile(historyPath(sessionId, options), lines, 'utf-8')
      }
    })

    // ── Phase 2: index, under the GLOBAL lock, briefly ───────────────────────
    //
    // What the old arrangement bought by holding the index lock across both
    // phases was "eviction cannot delete this session between its history write
    // and its upsert". That is still covered, by two independent guards:
    //
    //   - eviction only deletes a directory idle longer than the grace window
    //     (24 h by default), and we just wrote to this one;
    //   - deleteSession() takes this session's history lock before its rm(),
    //     so it cannot interleave with phase 1 at all.
    //
    // Note the two phases never hold both locks at once, so this method cannot
    // participate in a lock cycle with loadHistory()/deleteSession(), which do
    // nest index → history.
    await SessionStore._commitIndex({ sessionId, ...meta }, options)
  }

  /** Short critical section: upsert the index entry and reap what it evicted. */
  private static async _commitIndex(
    meta: SessionMeta,
    options: SessionStoreOptions,
  ): Promise<void> {
    await withSessionLock(indexFile(options), async () => {
      const evicted = await SessionStore._upsertIndexUnlocked(meta, options)
      await SessionStore._removeEvicted(evicted, options)
    })
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
    options: SessionStoreOptions = {},
  ): Promise<void> {
    await ensureDir(sessionDir(sessionId, options))

    // Same two-phase split as append() (P3-2). replace() is the worst offender
    // for head-of-line blocking: it is called after compaction, so it always
    // serialises and rewrites the FULL transcript — previously with every other
    // session's persist queued behind it on the global index lock.
    await withSessionLock(historyPath(sessionId, options), async () => {
      const current = (await readIndex(options)).find(entry => entry.sessionId === sessionId)
      if (
        options.expectedMessageCount !== undefined &&
        current &&
        current.messageCount !== options.expectedMessageCount
      ) {
        // Advisory only — see append(). replace() is already a full atomic
        // rewrite from the caller's authoritative in-memory transcript, so the
        // right response to divergence is to proceed loudly, not to strand the
        // session in a permanently-unpersistable state.
        console.warn(
          `[SessionStore] History divergence for ${sessionId}: index has ${current.messageCount} ` +
          `messages, caller expected ${options.expectedMessageCount}. Proceeding with full replace.`,
        )
      }
      // Atomic rename: a crash leaves either the old complete transcript or
      // the new complete transcript, never a truncated history.jsonl.
      await atomicWriteFile(historyPath(sessionId, options), await serializeMessages(messages, sessionId, options))
    })

    await SessionStore._commitIndex({ sessionId, ...meta }, options)
  }

  /**
   * Load the full conversation history for a session.
   * Returns [] if the history file doesn't exist.
   */
  static async loadHistory(
    sessionId: string,
    options: SessionStoreOptions = {},
  ): Promise<ConversationMessage[]> {
    try {
      return await withSessionLock(indexFile(options), () =>
        withSessionLock(historyPath(sessionId, options), () =>
          loadHistoryUnlocked(sessionId, options),
        ),
      )
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
      throw err
    }
  }

  /**
   * Return the session index, newest first.
   * @param limit  Maximum number of entries to return (default: 10).
   */
  static async listSessions(limit = 10, options: SessionListOptions = {}): Promise<SessionMeta[]> {
    const index = await readIndex(options)
    const workspace = options.workspace
    const filtered = workspace
      ? index.filter(entry => entry.workspace === workspace)
      : index
    return filtered.slice(0, limit)
  }

  /**
   * Return one session metadata record by ID, or null if it is not indexed.
   */
  static async getSession(
    sessionId: string,
    options: SessionStoreOptions = {},
  ): Promise<SessionMeta | null> {
    const index = await readIndex(options)
    return index.find(entry => entry.sessionId === sessionId) ?? null
  }

  /**
   * Check whether a session directory exists (quick existence check).
   */
  static sessionExists(sessionId: string, options: SessionStoreOptions = {}): boolean {
    // A predicate answers "no", it does not throw. An unsafe id cannot name an
    // existing session by construction, so `false` is both true and safe.
    if (!isValidStoreId(sessionId)) return false
    return existsSync(historyPath(sessionId, options))
  }

  /**
   * Delete a single session: remove from index + delete its directory.
   */
  static async deleteSession(
    sessionId: string,
    options: SessionStoreOptions = {},
  ): Promise<void> {
    try {
      // Remove from index (read-modify-write under the cross-process lock)
      await withSessionLock(indexFile(options), async () => {
        const entries = await readIndex(options)
        const filtered = entries.filter(e => e.sessionId !== sessionId)
        await writeIndex(filtered, options)
        // P3-2: take the session's own lock before removing its directory.
        // append()/replace() no longer run under the index lock, so this is
        // what keeps a delete from landing in the middle of a history write.
        // Order is index → history here, matching loadHistory(); append() holds
        // the two locks in separate phases and never both at once, so no cycle
        // exists between the three.
        await withSessionLock(historyPath(sessionId, options), async () => {
          await rm(sessionDir(sessionId, options), { recursive: true, force: true })
        })
      })
    } catch {
      // Best-effort
    }
  }

  /**
   * Delete a SPECIFIC set of sessions: filter them out of the index in one
   * atomic read-modify-write (so concurrent single deletes can't race to a
   * last-writer-wins loss) and remove their directories.
   *
   * This is what callers that have already scoped a list (e.g. "all sessions in
   * the current workspace") must use — NOT deleteAllSessions(), which ignores
   * the scope and wipes every workspace's history.
   */
  static async deleteSessions(
    sessionIds: string[],
    options: SessionStoreOptions = {},
  ): Promise<void> {
    if (sessionIds.length === 0) return
    const ids = new Set(sessionIds)
    // Split before the lock: an id that cannot name a directory is still
    // removed from the index (harmless, and it should not linger there), but it
    // never reaches `rm()`. Filtering rather than throwing keeps one bad id in a
    // bulk delete from aborting every other deletion in the batch.
    const deletable = [...ids].filter(isValidStoreId)
    try {
      await withSessionLock(indexFile(options), async () => {
        const entries = await readIndex(options)
        const filtered = entries.filter(e => !ids.has(e.sessionId))
        await writeIndex(filtered, options)
        await Promise.all(
          deletable.map(id => rm(sessionDir(id, options), { recursive: true, force: true })),
        )
      })
    } catch {
      // Best-effort
    }
  }

  /**
   * Delete ALL sessions: clear index + remove every session directory.
   */
  static async deleteAllSessions(options: SessionStoreOptions = {}): Promise<void> {
    try {
      await withSessionLock(indexFile(options), async () => {
        // Scan the physical directory instead of trusting the bounded index, so
        // legacy/unindexed orphan sessions are removed too.
        const entries = await readdir(sessionsRoot(options), { withFileTypes: true }).catch(() => [])
        await writeIndex([], options)
        await Promise.all(entries
          .filter(entry => entry.isDirectory())
          // Names come from readdir so they cannot contain separators, but the
          // containment check is what makes that an invariant rather than an
          // assumption — and it costs one resolve() per entry.
          .map(entry => rm(resolveWithinRoot(sessionsRoot(options), entry.name), { recursive: true, force: true })))
      })
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
    options: SessionStoreOptions = {},
  ): Promise<void> {
    try {
      await withSessionLock(indexFile(options), async () => {
        const entries = await readIndex(options)
        const idx = entries.findIndex(e => e.sessionId === sessionId)
        if (idx < 0) return
        entries[idx] = { ...entries[idx]!, title, titleMessageCount }
        await writeIndex(entries, options)
      })
    } catch {
      // Best-effort
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private static async _upsertIndex(
    meta: SessionMeta,
    options: SessionStoreOptions = {},
  ): Promise<void> {
    // M2-fix: the whole read→merge→write must be atomic ACROSS PROCESSES.
    // Two concurrent CLI sessions both rewrite index.json at every turn end;
    // without the lock, the slower writer silently drops the faster writer's
    // upsert (lost update) and sessions vanish from the picker.
    await withSessionLock(indexFile(options), async () => {
      const evicted = await SessionStore._upsertIndexUnlocked(meta, options)
      await SessionStore._removeEvicted(evicted, options)
    })
  }

  /** Caller must hold indexFile(options)'s lock. */
  private static async _upsertIndexUnlocked(
    meta: SessionMeta,
    options: SessionStoreOptions,
  ): Promise<SessionMeta[]> {
    const entries = await readIndex(options)
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
    const retained = entries.slice(0, MAX_INDEX_ENTRIES)
    const evicted = entries.slice(MAX_INDEX_ENTRIES)
    await writeIndex(retained, options)
    return evicted
  }

  /**
   * Caller must hold indexFile(options)'s lock.
   *
   * Deletes evicted sessions' directories, but only when they have been idle
   * longer than the grace window — an index-evicted session may still be live
   * in another process. Skipped (recently-active) directories either re-enter
   * the index on their next persist, or are reaped by _sweepStaleOrphans once
   * truly idle.
   */
  private static async _removeEvicted(
    evicted: readonly SessionMeta[],
    options: SessionStoreOptions,
  ): Promise<void> {
    if (evicted.length === 0) return
    const cutoff = Date.now() - evictionGraceMs()
    await Promise.all(evicted
      .filter(entry => entry.lastActivity <= cutoff && isValidStoreId(entry.sessionId))
      .map(entry => rm(sessionDir(entry.sessionId, options), { recursive: true, force: true })))
    await SessionStore._sweepStaleOrphans(options)
  }

  /**
   * Caller must hold indexFile(options)'s lock. Remove unindexed session
   * directories whose history has been idle past the grace window — the
   * long-term cleanup for directories the grace check above spared and for
   * orphans left behind by older versions. Runs only on actual evictions
   * (index overflow), so steady-state turns pay no readdir cost.
   */
  private static async _sweepStaleOrphans(options: SessionStoreOptions): Promise<void> {
    try {
      const indexed = new Set((await readIndex(options)).map(e => e.sessionId))
      const entries = await readdir(sessionsRoot(options), { withFileTypes: true }).catch(() => [])
      const cutoff = Date.now() - evictionGraceMs()
      await Promise.all(entries
        .filter(entry => entry.isDirectory() && !indexed.has(entry.name))
        .map(async entry => {
          const dir = resolveWithinRoot(sessionsRoot(options), entry.name)
          const mtime = await stat(join(dir, 'history.jsonl'))
            .then(s => s.mtimeMs)
            .catch(() => stat(dir).then(s => s.mtimeMs).catch(() => Number.POSITIVE_INFINITY))
          if (mtime <= cutoff) {
            await rm(dir, { recursive: true, force: true })
          }
        }))
    } catch {
      // Sweep is best-effort housekeeping — never fail the caller's persist.
    }
  }
}
