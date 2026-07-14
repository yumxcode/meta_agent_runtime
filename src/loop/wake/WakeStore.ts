/**
 * WakeStore — durable wake records with atomic claims (spec C4, D11/D12).
 *
 * Generalised from AutoOrchScheduleStore: the same file-per-record store +
 * claim discipline, but wake KINDS are loop v2's three sources (timer / probe /
 * event) plus manual. M1 ships timer + manual; probe/event land in M2 on the
 * same record shape.
 *
 * Guarantees the kernel relies on:
 *   • at-most-one in-flight round per loop — `claimDue` refuses to claim a
 *     wake for a loop that already has a live claim;
 *   • coalescing (D12) — scheduling a timer for a loop that already has a
 *     pending timer REPLACES it (missed/duplicate ticks merge, never queue);
 *   • crash recovery — claims carry an expiry; `reconcileOrphans` returns
 *     expired claims to `pending` so a kill -9'd tick child is self-healing;
 *   • multi-process safety — claim is an atomic compare-and-swap via
 *     `withFileLock` around read-modify-write.
 */
import { randomUUID } from 'crypto'
import { hostname } from 'os'
import { join, resolve } from 'path'
import {
  atomicWriteJson,
  deleteJsonFile,
  ensureDir,
  listJsonIds,
  readJsonFile,
  withFileLock,
} from '../../infra/persist/index.js'
import type { LoopInstanceId } from '../types.js'

export type WakeKind = 'timer' | 'event' | 'effect_poll' | 'manual'
export type WakeStatus = 'pending' | 'claimed' | 'done' | 'cancelled'

export interface WakeRecord {
  schemaVersion: '1.0'
  wakeId: string
  loopId: LoopInstanceId
  /** Workspace scope (absolute) — a scheduler only claims wakes for its own. */
  projectDir: string
  kind: WakeKind
  fireAt: number
  /** Effect this probe/event wake belongs to (M2). */
  effectKey?: string
  status: WakeStatus
  claim?: { owner: string; claimedAt: number; expiresAt: number }
  attempts: number
  /** Cost observed on safely-cancelled attempts before this wake completed.
   * It is carried into the eventual RoundEntry so abort/restart cannot reset
   * the lifetime USD ledger. */
  abortedCostUsd?: number
  createdAt: number
  updatedAt: number
}

export interface WakeStoreOptions {
  /** Store root. Default: `<projectDir>/.loop/wakes`. */
  dir?: string
  /** Claim TTL before an orphaned claim is recoverable. Default 10 min. */
  claimTtlMs?: number
}

const DEFAULT_CLAIM_TTL_MS = 10 * 60_000

export function wakeClaimOwner(): string {
  return `${hostname()}#${process.pid}`
}

export class WakeStore {
  private readonly dir: string
  private readonly claimTtlMs: number
  private readonly projectDir: string

  constructor(projectDir: string, opts?: WakeStoreOptions) {
    this.projectDir = resolve(projectDir)
    this.dir = opts?.dir ?? join(this.projectDir, '.loop', 'wakes')
    this.claimTtlMs = opts?.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS
  }

  private pathFor(wakeId: string): string {
    return join(this.dir, `${wakeId}.json`)
  }

  private lockPath(): string {
    return join(this.dir, '.lock')
  }

  /**
   * Schedule a wake. Timer wakes COALESCE per loop (D12): an existing pending
   * timer for the same loop is replaced, so "missed three ticks" collapses to
   * one. Manual/probe/event wakes never coalesce (each stands for a distinct
   * cause).
   */
  async schedule(input: {
    loopId: LoopInstanceId
    kind: WakeKind
    fireAt: number
    effectKey?: string
  }): Promise<WakeRecord> {
    await ensureDir(this.dir)
    return withFileLock(this.lockPath(), async () => {
      if (input.kind === 'timer' || input.kind === 'effect_poll') {
        for (const existing of await this.listUnlocked()) {
          if (
            existing.loopId === input.loopId &&
            existing.kind === input.kind &&
            (input.kind !== 'effect_poll' || existing.effectKey === input.effectKey) &&
            existing.status === 'pending'
          ) {
            const replaced: WakeRecord = {
              ...existing,
              fireAt: input.fireAt,
              updatedAt: Date.now(),
            }
            await atomicWriteJson(this.pathFor(existing.wakeId), replaced)
            return replaced
          }
        }
      }
      const record: WakeRecord = {
        schemaVersion: '1.0',
        wakeId: `wake-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        loopId: input.loopId,
        projectDir: this.projectDir,
        kind: input.kind,
        fireAt: input.fireAt,
        effectKey: input.effectKey,
        status: 'pending',
        attempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await atomicWriteJson(this.pathFor(record.wakeId), record)
      return record
    })
  }

  async list(): Promise<WakeRecord[]> {
    await ensureDir(this.dir)
    return this.listUnlocked()
  }

  private async listUnlocked(): Promise<WakeRecord[]> {
    const ids = await listJsonIds(this.dir)
    const records = await Promise.all(ids.map(id => readJsonFile<WakeRecord>(this.pathFor(id))))
    return records
      .filter((r): r is WakeRecord => r !== null)
      .sort((a, b) => a.fireAt - b.fireAt || a.createdAt - b.createdAt)
  }

  /**
   * Atomically claim due wakes. At most one claim per loop: if the loop
   * already has a live (unexpired) claim, its due wakes stay pending.
   */
  async claimDue(
    now = Date.now(),
    owner = wakeClaimOwner(),
    limit = Number.POSITIVE_INFINITY,
  ): Promise<WakeRecord[]> {
    await ensureDir(this.dir)
    return withFileLock(this.lockPath(), async () => {
      const all = await this.listUnlocked()
      const liveClaimedLoops = new Set(
        all
          .filter(r => r.status === 'claimed' && (r.claim?.expiresAt ?? 0) > now)
          .map(r => r.loopId),
      )
      const claimed: WakeRecord[] = []
      for (const record of all) {
        if (claimed.length >= limit) break
        if (record.status !== 'pending' || record.fireAt > now) continue
        if (liveClaimedLoops.has(record.loopId)) continue
        const next: WakeRecord = {
          ...record,
          status: 'claimed',
          claim: { owner, claimedAt: now, expiresAt: now + this.claimTtlMs },
          attempts: record.attempts + 1,
          updatedAt: now,
        }
        await atomicWriteJson(this.pathFor(record.wakeId), next)
        liveClaimedLoops.add(record.loopId) // one per loop per sweep, too
        claimed.push(next)
      }
      return claimed
    })
  }

  async heartbeat(wakeId: string, now = Date.now()): Promise<void> {
    await withFileLock(this.lockPath(), async () => {
      const record = await readJsonFile<WakeRecord>(this.pathFor(wakeId))
      if (!record || record.status !== 'claimed' || !record.claim) return
      await atomicWriteJson(this.pathFor(wakeId), {
        ...record,
        claim: { ...record.claim, expiresAt: now + this.claimTtlMs },
        updatedAt: now,
      })
    })
  }

  async addAbortedCost(wakeId: string, costUsd: number): Promise<void> {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return
    await withFileLock(this.lockPath(), async () => {
      const record = await readJsonFile<WakeRecord>(this.pathFor(wakeId))
      if (!record) return
      await atomicWriteJson(this.pathFor(wakeId), {
        ...record,
        abortedCostUsd: (record.abortedCostUsd ?? 0) + costUsd,
        updatedAt: Date.now(),
      })
    })
  }

  /** Terminal release: 'done' on success; 'pending' re-queues (retry).
   * `opts.fireAt` (pending only) re-queues with a backoff instead of firing
   * immediately — the runner uses it so a deterministic error cannot hot-loop. */
  async release(
    wakeId: string,
    outcome: 'done' | 'cancelled' | 'pending',
    opts?: { fireAt?: number },
  ): Promise<void> {
    await withFileLock(this.lockPath(), async () => {
      const record = await readJsonFile<WakeRecord>(this.pathFor(wakeId))
      if (!record) return
      await atomicWriteJson(this.pathFor(wakeId), {
        ...record,
        status: outcome,
        claim: outcome === 'pending' ? undefined : record.claim,
        ...(outcome === 'pending' && opts?.fireAt !== undefined ? { fireAt: opts.fireAt } : {}),
        updatedAt: Date.now(),
      })
    })
  }

  /**
   * Move aborted-attempt cost onto the loop's earliest live wake, so releasing
   * a stale wake as done/cancelled cannot silently drop money from the
   * lifetime USD ledger. Returns false when the loop has no live wake to
   * carry the cost (caller should log — the invariant cannot be kept).
   */
  async transferAbortedCost(loopId: LoopInstanceId, costUsd: number): Promise<boolean> {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return true
    return withFileLock(this.lockPath(), async () => {
      const candidates = (await this.listUnlocked()).filter(
        r => r.loopId === loopId && (r.status === 'pending' || r.status === 'claimed'),
      )
      const target = candidates[0]
      if (!target) return false
      await atomicWriteJson(this.pathFor(target.wakeId), {
        ...target,
        abortedCostUsd: (target.abortedCostUsd ?? 0) + costUsd,
        updatedAt: Date.now(),
      })
      return true
    })
  }

  async cancelForLoop(loopId: LoopInstanceId): Promise<number> {
    return withFileLock(this.lockPath(), async () => {
      let n = 0
      for (const record of await this.listUnlocked()) {
        if (record.loopId !== loopId || record.status === 'done' || record.status === 'cancelled') continue
        await atomicWriteJson(this.pathFor(record.wakeId), {
          ...record,
          status: 'cancelled',
          updatedAt: Date.now(),
        })
        n++
      }
      return n
    })
  }

  /** Return expired claims to pending (startup self-heal / RECONCILE). */
  async reconcileOrphans(now = Date.now()): Promise<WakeRecord[]> {
    await ensureDir(this.dir)
    return withFileLock(this.lockPath(), async () => {
      const healed: WakeRecord[] = []
      for (const record of await this.listUnlocked()) {
        if (record.status !== 'claimed') continue
        if ((record.claim?.expiresAt ?? 0) > now) continue
        const next: WakeRecord = { ...record, status: 'pending', claim: undefined, updatedAt: now }
        await atomicWriteJson(this.pathFor(record.wakeId), next)
        healed.push(next)
      }
      return healed
    })
  }

  /** Remove terminal records older than `olderThanMs` (housekeeping). */
  async prune(olderThanMs: number, now = Date.now()): Promise<number> {
    return withFileLock(this.lockPath(), async () => {
      let n = 0
      for (const record of await this.listUnlocked()) {
        if (record.status !== 'done' && record.status !== 'cancelled') continue
        if (now - record.updatedAt < olderThanMs) continue
        await deleteJsonFile(this.pathFor(record.wakeId))
        n++
      }
      return n
    })
  }
}
