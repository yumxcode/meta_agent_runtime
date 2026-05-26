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

import { readFile, appendFile, mkdir, open, stat, rm } from 'node:fs/promises'
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

// ── Public types ─────────────────────────────────────────────────────────────

export interface SessionMeta {
  sessionId: string
  mode: string
  startTime: number
  lastActivity: number
  messageCount: number
  /** First ~80 chars of the first user prompt — shown in the session picker. */
  firstPrompt: string
  workspace?: string
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
      const lines = messages
        .slice(appendFrom)
        .map(m => JSON.stringify(m))
        .join('\n') + '\n'
      await appendFile(historyPath(sessionId), lines, 'utf-8')
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
      return raw
        .split('\n')
        .filter(Boolean)
        .slice(-MAX_RESUME_MESSAGES)
        .map(line => JSON.parse(line) as ConversationMessage)
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

  // ── Private ────────────────────────────────────────────────────────────────

  private static async _upsertIndex(meta: SessionMeta): Promise<void> {
    const entries = await readIndex()
    const idx = entries.findIndex(e => e.sessionId === meta.sessionId)
    if (idx >= 0) {
      entries[idx] = meta
    } else {
      entries.unshift(meta)
    }
    // Sort newest-first by lastActivity, then keep index bounded.
    // Sort before slice so the most-recently-active sessions always survive the cap.
    entries.sort((a, b) => b.lastActivity - a.lastActivity)
    await writeIndex(entries.slice(0, MAX_INDEX_ENTRIES))
  }
}
