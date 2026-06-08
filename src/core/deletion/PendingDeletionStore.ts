/**
 * PendingDeletionStore — review queue for AI-proposed deletions.
 *
 * Deletion is destructive, so when the LLM calls a `*_delete` tool the request
 * is NOT applied. It is queued here and surfaced via `/<mechanism> delete
 * review`, where the user approves or rejects each one. Only the human review
 * path (`/<mechanism> delete`) deletes committed entries directly.
 *
 * One queue per mechanism, persisted globally under
 * `~/.meta-agent/deletions/<mechanism>.json`. Pending deletions survive
 * restarts; they are never auto-applied.
 */

import { readFile, rm } from 'fs/promises'
import { join } from 'path'
import { META_AGENT_HOME } from '../metaAgentHome.js'
import { atomicWriteJson } from '../persist/index.js'

export type DeletionMechanism = 'memory' | 'experience' | 'principle' | 'anchor'

export const DELETION_MECHANISMS: readonly DeletionMechanism[] = [
  'memory',
  'experience',
  'principle',
  'anchor',
]

export interface PendingDeletion {
  /** Temporary pending ID for this deletion request. */
  pendingId: string
  mechanism: DeletionMechanism
  /** Committed-entry ID to delete (experience/principle/anchor ID, or memory filename). */
  targetId: string
  /** Human-readable label shown during review (title / name). */
  label: string
  /** Optional justification provided by the AI. */
  reason?: string
  requestedAt: number
}

const DELETION_ROOT = join(META_AGENT_HOME, 'deletions')
const MAX_PENDING_ENTRIES = 500

export class PendingDeletionStore {
  private readonly _pending: PendingDeletion[] = []
  private readonly _filePath: string
  private readonly _mechanism: DeletionMechanism
  private _persistTail: Promise<void> = Promise.resolve()

  constructor(mechanism: DeletionMechanism, root: string = DELETION_ROOT) {
    this._mechanism = mechanism
    this._filePath = join(root, `${mechanism}.json`)
  }

  /** Load persisted pending deletions, if any. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this._filePath, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return
      this._pending.length = 0
      for (const item of parsed) {
        if (!isPendingDeletion(item)) continue
        this._pending.push(item)
      }
      if (this._pending.length > MAX_PENDING_ENTRIES) {
        this._pending.splice(0, this._pending.length - MAX_PENDING_ENTRIES)
        this._persistSoon()
      }
    } catch {
      // Missing or malformed pending file: start with an empty queue.
    }
  }

  /**
   * Queue a deletion for review. Deduplicates by targetId so repeated proposals
   * collapse into one. Returns the pending ID (existing or new).
   */
  add(input: { targetId: string; label: string; reason?: string }): string {
    const existing = this._pending.find(p => p.targetId === input.targetId)
    if (existing) return existing.pendingId
    if (this._pending.length >= MAX_PENDING_ENTRIES) {
      throw new Error(
        `Pending deletion queue limit reached (${MAX_PENDING_ENTRIES}); run /${this._mechanism} delete review first.`,
      )
    }
    const pendingId = `pdel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    this._pending.push({
      pendingId,
      mechanism: this._mechanism,
      targetId: input.targetId,
      label: input.label,
      reason: input.reason,
      requestedAt: Date.now(),
    })
    this._persistSoon()
    return pendingId
  }

  list(): readonly PendingDeletion[] {
    return this._pending
  }

  get count(): number {
    return this._pending.length
  }

  remove(pendingId: string): boolean {
    const idx = this._pending.findIndex(p => p.pendingId === pendingId)
    if (idx < 0) return false
    this._pending.splice(idx, 1)
    this._persistSoon()
    return true
  }

  clear(): void {
    this._pending.length = 0
    this._persistSoon()
  }

  /** Wait for queued persistence writes to drain. */
  async flush(): Promise<void> {
    await this._persistTail
  }

  private _persistSoon(): void {
    const snapshot = this._pending.map(item => ({ ...item }))
    this._persistTail = this._persistTail
      .catch(() => {})
      .then(() => this._persist(snapshot))
      .catch(() => {})
  }

  private async _persist(snapshot: PendingDeletion[]): Promise<void> {
    if (snapshot.length === 0) {
      await rm(this._filePath, { force: true }).catch(() => undefined)
      return
    }
    await atomicWriteJson(this._filePath, snapshot)
  }
}

function isPendingDeletion(value: unknown): value is PendingDeletion {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return typeof r['pendingId'] === 'string' &&
    typeof r['mechanism'] === 'string' &&
    typeof r['targetId'] === 'string' &&
    typeof r['label'] === 'string' &&
    typeof r['requestedAt'] === 'number'
}

// ── Per-mechanism singletons ────────────────────────────────────────────────
//
// The *_delete tools (in the agent session) and the CLI review command must
// share one queue per mechanism. Mirrors the memory pending store singleton.

const _stores = new Map<DeletionMechanism, PendingDeletionStore>()
const _loadOnce = new Map<DeletionMechanism, Promise<void>>()

export function getPendingDeletionStore(mechanism: DeletionMechanism): PendingDeletionStore {
  let store = _stores.get(mechanism)
  if (!store) {
    store = new PendingDeletionStore(mechanism)
    _stores.set(mechanism, store)
  }
  return store
}

export function ensurePendingDeletionsLoaded(mechanism: DeletionMechanism): Promise<void> {
  let p = _loadOnce.get(mechanism)
  if (!p) {
    p = getPendingDeletionStore(mechanism).load()
    _loadOnce.set(mechanism, p)
  }
  return p
}
