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

export type AutoContinuationStatus =
  | 'pending' | 'claimed' | 'done' | 'cancelled'
  /**
   * The wake came due but nothing ran it for longer than the staleness window,
   * so it was retired UNEXECUTED.
   *
   * Distinct from 'cancelled' on purpose: cancelled means a fence rejected the
   * wake (history moved on, goal changed), expired means nobody was listening.
   * The usual cause is the scheduler for that workspace being gone — a closed
   * terminal, a finished experiment, a machine reboot. Running such a wake days
   * later is worse than dropping it: its whole premise ("check whether CI run
   * 30967536149 finished, ~13 min") has long stopped being true, so it would
   * burn tokens re-deriving a stale situation.
   */
  | 'expired'

/** A wake in one of these states will never run again. */
export function isTerminalWakeStatus(status: AutoContinuationStatus): boolean {
  return status === 'done' || status === 'cancelled' || status === 'expired'
}

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
  /**
   * `$META_AGENT_CONFIG_FILE` at park time — which PROVIDER PROFILE this
   * session belongs to.
   *
   * Everything else here is only set when the operator passed an explicit CLI
   * flag; a session that selects its provider through a config file (which is
   * the normal way) records `runtime: {}` and, on resume, silently inherits
   * whatever profile the resuming process happens to have. So a wake armed by
   * `meta-agent-glm` and resumed by plain `meta-agent` continues the SAME
   * session on a different account and model, with nothing in any log to say
   * so. Recording the profile makes the wake self-describing, which is the
   * precondition for any UI offering a "run this now" button.
   */
  configFile?: string
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
  /**
   * How long past fireAt an unexecuted wake survives before being retired as
   * `expired`. Defaults to DEFAULT_STALE_WAKE_MS (7 days); pass 0 to disable.
   */
  staleWakeMs?: number
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

/**
 * How long past its fireAt a wake may sit unexecuted before it is retired.
 *
 * Measured from `fireAt`, not `createdAt`: a wake legitimately scheduled two
 * weeks out is not stale, one that came due eight days ago and nobody ran is.
 *
 * The failure this guards against is a workspace whose scheduler went away —
 * terminal closed, experiment abandoned, machine rebooted. Its queue keeps the
 * wake forever, and the next time anyone starts a scheduler there it resumes a
 * session whose premise expired long ago ("check whether CI run 30967536149
 * finished, ETA 13 min" — from nine days back), burning tokens to re-derive a
 * dead situation.
 */
const DEFAULT_STALE_WAKE_MS = 7 * 24 * 60 * 60_000

export function autoContinuationClaimOwner(): string {
  return `${hostname()}#${process.pid}`
}

export class AutoContinuationStore {
  private readonly projectDir: string
  private readonly dir: string
  private readonly claimTtlMs: number
  private readonly staleWakeMs: number

  constructor(projectDir: string, options: AutoContinuationStoreOptions = {}) {
    this.projectDir = resolve(projectDir)
    this.dir = options.dir ?? join(this.projectDir, '.meta-agent', 'auto', 'wakes')
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS
    // 0 (or negative) disables expiry entirely — useful for a queue that is
    // deliberately parked for a long time.
    this.staleWakeMs = options.staleWakeMs ?? DEFAULT_STALE_WAKE_MS
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
        if (record.status !== 'pending') continue

        // Retire instead of running: a wake this far past due belongs to a
        // workspace whose scheduler went away, and its premise no longer holds.
        // Checked BEFORE the `limit` break so a long backlog cannot hide stale
        // records behind the concurrency cap forever.
        if (this.staleWakeMs > 0 && record.fireAt <= now - this.staleWakeMs) {
          await atomicWriteJson(this.pathFor(record.wakeId), {
            ...record,
            status: 'expired',
            updatedAt: now,
          } satisfies AutoContinuationRecord)
          continue
        }

        if (claimed.length >= limit) break
        if (record.fireAt > now) continue
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

  /**
   * Make a pending wake due immediately. This is how a UI says "run it now".
   *
   * The UI must never start a turn itself: that would be a second execution
   * path next to the scheduler, duplicating the claim/lease protocol, and it
   * would have to know which provider profile the session belongs to. Moving
   * `fireAt` instead keeps execution in exactly one place — the running
   * scheduler picks the wake up within one poll — and needs no API key.
   *
   * Only `pending` records qualify. A claimed wake is already executing, so
   * "run it now" is a no-op rather than an error the caller must special-case;
   * an already-due wake likewise returns true without a pointless write.
   */
  async fireNow(wakeId: string, now = Date.now()): Promise<boolean> {
    return withFileLock(this.lockPath(), async () => {
      const record = await readJsonFile<AutoContinuationRecord>(this.pathFor(wakeId))
      if (!record || record.status !== 'pending') return false
      if (record.fireAt <= now) return true
      await atomicWriteJson(this.pathFor(wakeId), {
        ...record,
        fireAt: now,
        updatedAt: now,
      } satisfies AutoContinuationRecord)
      return true
    })
  }

  /**
   * Physically delete every wake record for a session, terminal ones included.
   *
   * Distinct from `cancelSession`, which MARKS records so the audit trail
   * survives. This is for an operator saying "remove this task entirely"; the
   * audit trail is part of what they are removing.
   */
  async purgeSession(sessionId: string): Promise<number> {
    await ensureDir(this.dir)
    return withFileLock(this.lockPath(), async () => {
      let removed = 0
      for (const record of await this.listUnlocked()) {
        if (record.sessionId !== sessionId) continue
        await deleteJsonFile(this.pathFor(record.wakeId))
        removed++
      }
      return removed
    })
  }

  async cancelSession(sessionId: string): Promise<number> {
    await ensureDir(this.dir)
    return withFileLock(this.lockPath(), async () => {
      let count = 0
      for (const record of await this.listUnlocked()) {
        if (
          record.sessionId !== sessionId ||
          isTerminalWakeStatus(record.status)
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
        isTerminalWakeStatus(record.status) ||
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

  /**
   * Retire every wake that came due more than `staleWakeMs` ago and never ran.
   *
   * `claimDue` applies the same rule lazily, so this exists for the eager sweep
   * a scheduler does at startup: it returns the retired records so the operator
   * is TOLD what was dropped, instead of silently finding a shrunken queue.
   */
  async expireStale(
    staleWakeMs = this.staleWakeMs,
    now = Date.now(),
  ): Promise<AutoContinuationRecord[]> {
    if (staleWakeMs <= 0) return []
    await ensureDir(this.dir)
    return withFileLock(this.lockPath(), async () => {
      const expired: AutoContinuationRecord[] = []
      for (const record of await this.listUnlocked()) {
        // A claimed record is someone else's in-flight work, however old the
        // fireAt looks — reconcileOrphans releases it first if the claim died.
        if (record.status !== 'pending') continue
        if (record.fireAt > now - staleWakeMs) continue
        const next: AutoContinuationRecord = {
          ...record,
          status: 'expired',
          updatedAt: now,
        }
        await atomicWriteJson(this.pathFor(next.wakeId), next)
        expired.push(next)
      }
      return expired
    })
  }

  /**
   * Delete terminal records (done / cancelled / expired) older than the
   * retention window.
   *
   * Age is measured from the moment the record STOPPED being live, not from
   * `updatedAt`. For done/cancelled those are the same instant. For `expired`
   * they are not: expireStale stamps `updatedAt = now` as it retires the
   * record, so an `updatedAt` rule reset the clock on exactly the records the
   * sweep exists to remove — the CLI runs expireStale() and then prune(), and
   * prune could never delete anything expireStale had just marked. The queue
   * whose growth motivated this sweep (28 records, 27 long finished, all
   * re-read under the store lock on every poll) therefore never shrank.
   *
   * `fireAt` is the honest "stopped being live" timestamp for an expired wake:
   * it is the moment nobody serviced.
   */
  async prune(olderThanMs = DEFAULT_RETENTION_MS, now = Date.now()): Promise<number> {
    await ensureDir(this.dir)
    return withFileLock(this.lockPath(), async () => {
      let count = 0
      for (const record of await this.listUnlocked()) {
        if (!isTerminalWakeStatus(record.status)) continue
        const settledAt = record.status === 'expired'
          ? Math.min(record.fireAt, record.updatedAt)
          : record.updatedAt
        if (now - settledAt < olderThanMs) continue
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
    // MUST list every AutoContinuationStatus. A status missing here makes the
    // record unreadable rather than invalid-looking: listUnlocked silently drops
    // it, so the wake becomes invisible to list/prune/claimDue while its file
    // stays on disk forever. Adding 'expired' without this line did exactly
    // that — expireStale wrote records nothing could ever see again.
    (['pending', 'claimed', 'done', 'cancelled', 'expired'] satisfies AutoContinuationStatus[])
      .includes(value.status),
  )
}
