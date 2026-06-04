/**
 * MemoryPendingStore — global buffer for proposed memory entries.
 *
 * Both write paths funnel through here instead of committing directly:
 *   - the `memory_write` tool (LLM-proposed, any mode)
 *   - the post-session auto-writer (flash side-call)
 *
 * The user reviews pending entries via the `/memory review` REPL command (or at
 * session end when the queue is surfaced).  Only approved entries are written to
 * the global memory directory.  This keeps premature or low-quality memories out
 * of the shared MEMORY.md index.
 *
 * Memory is global (not project-scoped), so a single pending file is used.
 * Storage: in-memory + best-effort persistence under
 * `~/.meta-agent/memory/pending/pending.json`.  Pending entries survive normal
 * restarts; they are never auto-committed.
 */

import { readFile, rm } from 'fs/promises'
import { join } from 'path'
import { META_AGENT_HOME } from '../metaAgentHome.js'
import { atomicWriteJson } from '../persist/index.js'
import { commitMemoryProposal, type CommitMemoryResult, type NormalizedMemoryProposal } from './memoryProposal.js'
import { MEMORY_DIR } from './paths.js'

const PENDING_DIR = join(META_AGENT_HOME, 'memory', 'pending')
const PENDING_FILE = join(PENDING_DIR, 'pending.json')
const MAX_PENDING_ENTRIES = 500

/** Where a pending memory originated, surfaced during review. */
export type MemoryProposalOrigin = 'tool' | 'auto'

export interface PendingMemory {
  /** Temporary pending ID (not a final memory filename). */
  pendingId: string
  proposedAt: number
  origin: MemoryProposalOrigin
  /** Normalised, ready-to-render proposal. */
  proposal: NormalizedMemoryProposal
}

export class MemoryPendingStore {
  private readonly _pending: PendingMemory[] = []
  private readonly _filePath: string
  private _persistTail: Promise<void> = Promise.resolve()

  constructor(filePath: string = PENDING_FILE) {
    this._filePath = filePath
  }

  /** Load persisted pending entries, if any. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this._filePath, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return
      this._pending.length = 0
      for (const item of parsed) {
        if (!isPendingMemory(item)) continue
        this._pending.push(item)
      }
      this._trimToLimit()
    } catch {
      // Missing or malformed pending file: start with an empty queue.
    }
  }

  /** Queue a normalised proposal for review. Returns the temporary pending ID. */
  add(proposal: NormalizedMemoryProposal, origin: MemoryProposalOrigin = 'tool'): string {
    if (this._pending.length >= MAX_PENDING_ENTRIES) {
      throw new Error(`Pending memory queue limit reached (${MAX_PENDING_ENTRIES}); run /memory review before adding more.`)
    }
    const pendingId = `pmem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    this._pending.push({ pendingId, proposedAt: Date.now(), origin, proposal })
    this._persistSoon()
    return pendingId
  }

  /** All pending entries in proposal order. */
  list(): readonly PendingMemory[] {
    return this._pending
  }

  /** Number of pending entries awaiting review. */
  get count(): number {
    return this._pending.length
  }

  /** Remove one pending entry (after commit or discard). */
  remove(pendingId: string): boolean {
    const idx = this._pending.findIndex(p => p.pendingId === pendingId)
    if (idx < 0) return false
    this._pending.splice(idx, 1)
    this._persistSoon()
    return true
  }

  /** Clear all pending entries. */
  clear(): void {
    this._pending.length = 0
    this._persistSoon()
  }

  /** Wait for queued persistence writes to drain. Useful in tests / shutdown. */
  async flush(): Promise<void> {
    await this._persistTail
  }

  /**
   * Commit one pending entry to the global memory directory.
   * On success the entry is removed from the queue.
   * Pass `overwrite: true` to replace an existing same-named memory.
   */
  async commit(pendingId: string, memoryDir: string = MEMORY_DIR, overwrite?: boolean): Promise<CommitMemoryResult> {
    const entry = this._pending.find(p => p.pendingId === pendingId)
    if (!entry) return { ok: false, reason: 'error', detail: 'pending entry not found' }

    const result = await commitMemoryProposal(entry.proposal, memoryDir, undefined, overwrite)
    if (result.ok) this.remove(pendingId)
    return result
  }

  private _persistSoon(): void {
    const snapshot = this._pending.map(item => ({
      pendingId: item.pendingId,
      proposedAt: item.proposedAt,
      origin: item.origin,
      proposal: { ...item.proposal },
    }))
    this._persistTail = this._persistTail
      .catch(() => {})
      .then(() => this._persist(snapshot))
      .catch(() => {})
  }

  private _trimToLimit(): void {
    if (this._pending.length <= MAX_PENDING_ENTRIES) return
    this._pending.splice(0, this._pending.length - MAX_PENDING_ENTRIES)
    this._persistSoon()
  }

  private async _persist(snapshot: PendingMemory[]): Promise<void> {
    if (snapshot.length === 0) {
      await rm(this._filePath, { force: true }).catch(() => undefined)
      return
    }
    await atomicWriteJson(this._filePath, snapshot)
  }
}

function isPendingMemory(value: unknown): value is PendingMemory {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record['pendingId'] !== 'string') return false
  if (typeof record['proposedAt'] !== 'number') return false
  const proposal = record['proposal']
  if (!proposal || typeof proposal !== 'object') return false
  const p = proposal as Record<string, unknown>
  return typeof p['filename'] === 'string' &&
    typeof p['name'] === 'string' &&
    typeof p['type'] === 'string' &&
    typeof p['body'] === 'string'
}

// ── Module-level global singleton ───────────────────────────────────────────
//
// The memory_write tool, the post-session auto-writer, and the CLI review
// command must all share one queue.  Mirrors the cron store singleton pattern.

let _globalStore: MemoryPendingStore | null = null
let _loadOnce: Promise<void> | null = null

/** Get (lazily create) the process-wide pending memory store. */
export function getMemoryPendingStore(): MemoryPendingStore {
  if (!_globalStore) _globalStore = new MemoryPendingStore()
  return _globalStore
}

/** Load the global store's persisted entries exactly once. */
export function ensureMemoryPendingLoaded(): Promise<void> {
  if (!_loadOnce) _loadOnce = getMemoryPendingStore().load()
  return _loadOnce
}
