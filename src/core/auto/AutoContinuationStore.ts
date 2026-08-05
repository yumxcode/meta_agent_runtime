/**
 * Durable wake queue for plain Auto sessions.
 *
 * File-per-record + one directory lock gives us atomic claim fencing across
 * scheduler processes. Timer requests coalesce per session, claims expire for
 * crash recovery, and terminal records remain briefly as an audit trail.
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

export type AutoContinuationStatus = 'pending' | 'claimed' | 'done' | 'cancelled'

/**
 * Raised when a wake has already been CONSUMED — a turn ran against it and
 * persisted new history — but something failed afterwards (typically arming the
 * follow-up wake).
 *
 * The distinction matters because a consumed wake can never be re-run: its
 * `historyMessageCount` fence was invalidated by its own execution, so a retry
 * is guaranteed to fail that fence and CANCEL the session outright. Before this
 * existed, a transient arming failure therefore destroyed the session:
 *
 *   attempt 1 → turn runs, history grows, arming throws → scheduler retries
 *   attempt 2 → history.length !== record.historyMessageCount → cancelled (terminal)
 *
 * Schedulers must treat this as terminal-but-successful for the wake, and
 * surface the cause instead of retrying.
 */
export class AutoWakeConsumedError extends Error {
  override readonly name = 'AutoWakeConsumedError'
  constructor(readonly sessionId: string, override readonly cause: unknown) {
    super(
      `Auto wake for session ${sessionId} was consumed by a turn that then failed: ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

export interface AutoContinuationRuntime {
  model?: string
  fallbackModel?: string
  baseUrl?: string
  maxTurns?: number
  maxBudgetUsd?: number
  sessionDir?: string
}

export interface AutoContinuationRecord {
  schemaVersion: '1.0'
  wakeId: string
  sessionId: string
  projectDir: string
  fireAt: number
  reason: string
  checkpoint?: Record<string, unknown>
  /** Fences a wake against a later top-level goal in the same session. */
  goal?: string
  checkpointRevision?: number
  historyMessageCount: number
  runtime?: AutoContinuationRuntime
  status: AutoContinuationStatus
  claim?: {
    owner: string
    token: string
    claimedAt: number
    expiresAt: number
  }
  attempts: number
  createdAt: number
  updatedAt: number
}

export interface AutoContinuationStoreOptions {
  dir?: string
  claimTtlMs?: number
}

export interface AutoContinuationScheduleOptions {
  /**
   * Atomically lease the newly scheduled wake to this owner. Attached CLI
   * hosts use this to close the race between publishing a wake and waiting for
   * it; detached scheduling leaves this unset.
   */
  claimOwner?: string
  now?: number
}

const DEFAULT_CLAIM_TTL_MS = 10 * 60_000
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000

export function autoContinuationClaimOwner(): string {
  return `${hostname()}#${process.pid}`
}

export class AutoContinuationStore {
  private readonly projectDir: string
  private readonly dir: string
  private readonly claimTtlMs: number

  constructor(projectDir: string, options: AutoContinuationStoreOptions = {}) {
    this.projectDir = resolve(projectDir)
    this.dir = options.dir ?? join(this.projectDir, '.meta-agent', 'auto', 'wakes')
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS
  }

  async schedule(input: {
    sessionId: string
    fireAt: number
    reason: string
    checkpoint?: Record<string, unknown>
    goal?: string
    checkpointRevision?: number
    historyMessageCount: number
    runtime?: AutoContinuationRuntime
  }, options: AutoContinuationScheduleOptions = {}): Promise<AutoContinuationRecord> {
    await ensureDir(this.dir)
    return withFileLock(this.lockPath(), async () => {
      const now = options.now ?? Date.now()
      const initialClaim = options.claimOwner
        ? {
            owner: options.claimOwner,
            token: randomUUID(),
            claimedAt: now,
            expiresAt: now + this.claimTtlMs,
          }
        : undefined
      // At most one unclaimed timer per session. If the session parks again
      // while its prior wake is claimed, the new pending record is kept beside
      // that in-flight audit record and becomes eligible after release.
      const pending = (await this.listUnlocked()).find(record =>
        record.sessionId === input.sessionId && record.status === 'pending')
      if (pending) {
        const next: AutoContinuationRecord = {
          ...pending,
          ...input,
          projectDir: this.projectDir,
          status: initialClaim ? 'claimed' : 'pending',
          claim: initialClaim,
          attempts: pending.attempts + (initialClaim ? 1 : 0),
          updatedAt: now,
        }
        await atomicWriteJson(this.pathFor(next.wakeId), next)
        return next
      }
      const next: AutoContinuationRecord = {
        schemaVersion: '1.0',
        wakeId: `auto-wake-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        sessionId: input.sessionId,
        projectDir: this.projectDir,
        fireAt: input.fireAt,
        reason: input.reason,
        checkpoint: input.checkpoint,
        goal: input.goal,
        checkpointRevision: input.checkpointRevision,
        historyMessageCount: input.historyMessageCount,
        runtime: input.runtime,
        status: initialClaim ? 'claimed' : 'pending',
        claim: initialClaim,
        attempts: initialClaim ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      }
      await atomicWriteJson(this.pathFor(next.wakeId), next)
      return next
    })
  }

  async list(): Promise<AutoContinuationRecord[]> {
    await ensureDir(this.dir)
    return this.listUnlocked()
  }

  async claimDue(
    now = Date.now(),
    owner = autoContinuationClaimOwner(),
    limit = Number.POSITIVE_INFINITY,
  ): Promise<AutoContinuationRecord[]> {
    await ensureDir(this.dir)
    return withFileLock(this.lockPath(), async () => {
      const all = await this.listUnlocked()
      const liveSessions = new Set(
        all
          .filter(record =>
            record.status === 'claimed' && (record.claim?.expiresAt ?? 0) > now)
          .map(record => record.sessionId),
      )
      const claimed: AutoContinuationRecord[] = []
      for (const record of all) {
        if (claimed.length >= limit) break
        if (record.status !== 'pending' || record.fireAt > now) continue
        if (liveSessions.has(record.sessionId)) continue
        const next: AutoContinuationRecord = {
          ...record,
          status: 'claimed',
          claim: {
            owner,
            token: randomUUID(),
            claimedAt: now,
            expiresAt: now + this.claimTtlMs,
          },
          attempts: record.attempts + 1,
          updatedAt: now,
        }
        await atomicWriteJson(this.pathFor(next.wakeId), next)
        liveSessions.add(next.sessionId)
        claimed.push(next)
      }
      return claimed
    })
  }

  async heartbeat(wakeId: string, claimToken: string, now = Date.now()): Promise<boolean> {
    return withFileLock(this.lockPath(), async () => {
      const record = await readJsonFile<AutoContinuationRecord>(this.pathFor(wakeId))
      if (
        !record ||
        record.status !== 'claimed' ||
        record.claim?.token !== claimToken
      ) return false
      await atomicWriteJson(this.pathFor(wakeId), {
        ...record,
        claim: { ...record.claim, expiresAt: now + this.claimTtlMs },
        updatedAt: now,
      })
      return true
    })
  }

  async release(
    wakeId: string,
    claimToken: string,
    outcome: 'done' | 'cancelled' | 'pending',
    fireAt?: number,
  ): Promise<boolean> {
    return withFileLock(this.lockPath(), async () => {
      const record = await readJsonFile<AutoContinuationRecord>(this.pathFor(wakeId))
      if (!record || record.status !== 'claimed' || record.claim?.token !== claimToken) {
        return false
      }
      await atomicWriteJson(this.pathFor(wakeId), {
        ...record,
        status: outcome,
        ...(outcome === 'pending'
          ? { claim: undefined, fireAt: fireAt ?? record.fireAt }
          : {}),
        updatedAt: Date.now(),
      })
      return true
    })
  }

  async cancelSession(sessionId: string): Promise<number> {
    await ensureDir(this.dir)
    return withFileLock(this.lockPath(), async () => {
      let count = 0
      for (const record of await this.listUnlocked()) {
        if (
          record.sessionId !== sessionId ||
          record.status === 'done' ||
          record.status === 'cancelled'
        ) continue
        await atomicWriteJson(this.pathFor(record.wakeId), {
          ...record,
          status: 'cancelled',
          updatedAt: Date.now(),
        })
        count++
      }
      return count
    })
  }

  /** Cancel one exact wake without disturbing another in-flight wake for the session. */
  async cancel(
    wakeId: string,
    expectedClaimToken?: string,
  ): Promise<boolean> {
    await ensureDir(this.dir)
    return withFileLock(this.lockPath(), async () => {
      const record = await readJsonFile<AutoContinuationRecord>(this.pathFor(wakeId))
      if (
        !record ||
        record.status === 'done' ||
        record.status === 'cancelled' ||
        (
          expectedClaimToken !== undefined &&
          record.claim?.token !== expectedClaimToken
        )
      ) return false
      await atomicWriteJson(this.pathFor(wakeId), {
        ...record,
        status: 'cancelled',
        updatedAt: Date.now(),
      })
      return true
    })
  }

  async reconcileOrphans(now = Date.now()): Promise<AutoContinuationRecord[]> {
    await ensureDir(this.dir)
    return withFileLock(this.lockPath(), async () => {
      const healed: AutoContinuationRecord[] = []
      for (const record of await this.listUnlocked()) {
        if (
          record.status !== 'claimed' ||
          (record.claim?.expiresAt ?? 0) > now
        ) continue
        const next: AutoContinuationRecord = {
          ...record,
          status: 'pending',
          claim: undefined,
          updatedAt: now,
        }
        await atomicWriteJson(this.pathFor(next.wakeId), next)
        healed.push(next)
      }
      return healed
    })
  }

  async prune(olderThanMs = DEFAULT_RETENTION_MS, now = Date.now()): Promise<number> {
    await ensureDir(this.dir)
    return withFileLock(this.lockPath(), async () => {
      let count = 0
      for (const record of await this.listUnlocked()) {
        if (record.status !== 'done' && record.status !== 'cancelled') continue
        if (now - record.updatedAt < olderThanMs) continue
        await deleteJsonFile(this.pathFor(record.wakeId)).catch(() => undefined)
        count++
      }
      return count
    })
  }

  private pathFor(wakeId: string): string {
    return join(this.dir, `${encodeURIComponent(wakeId)}.json`)
  }

  private lockPath(): string {
    return join(this.dir, '.store')
  }

  private async listUnlocked(): Promise<AutoContinuationRecord[]> {
    const ids = await listJsonIds(this.dir)
    const values = await Promise.all(ids.map(id =>
      readJsonFile<AutoContinuationRecord>(join(this.dir, `${id}.json`))))
    return values
      .filter(isAutoContinuationRecord)
      .sort((a, b) => a.fireAt - b.fireAt || a.createdAt - b.createdAt)
  }
}

function isAutoContinuationRecord(
  value: AutoContinuationRecord | null,
): value is AutoContinuationRecord {
  return Boolean(
    value &&
    value.schemaVersion === '1.0' &&
    typeof value.wakeId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.fireAt === 'number' &&
    ['pending', 'claimed', 'done', 'cancelled'].includes(value.status),
  )
}
