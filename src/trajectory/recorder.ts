import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { sanitizeTrajectoryItem } from './privacy.js'
import {
  repairAndVerifyTrajectory,
  readTrajectory,
  readTrajectoryPreservingUnknown,
} from './reader.js'
import {
  TRAJECTORY_LINE_SCHEMA_VERSION,
  TrajectoryItemSchema,
  type RecordContext,
  type TrajectoryDescriptor,
  type TrajectoryIndexEntry,
  type TrajectoryItem,
  type TrajectoryLine,
} from './types.js'
import { trajectoryDir, trajectoryFile, trajectoryLeaseFile, type TrajectoryPathsOptions } from './paths.js'
import {
  findIndexedTrajectoryById,
  projectTrajectory,
  projectTrajectoryDelta,
  projectPreservedTrajectory,
  upsertTrajectoryIndex,
} from './indexStore.js'
import {
  DEFAULT_TRAJECTORY_PERSISTENCE_POLICY,
  shouldPersistTrajectoryItem,
  type TrajectoryPersistencePolicy,
} from './persistence.js'
import { readTrajectoryHealth, writeTrajectoryHealth } from './health.js'

export interface TrajectoryRecorderOptions extends TrajectoryPathsOptions {
  trajectoryId?: string
  maxPendingItems?: number
  maxPendingBytes?: number
  maxItemBytes?: number
  now?: () => number
  persistencePolicy?: TrajectoryPersistencePolicy
}

export class TrajectoryItemTooLargeError extends Error {
  constructor(readonly estimatedBytes: number, readonly maxBytes: number) {
    super(`trajectory item is ${estimatedBytes} bytes; maximum is ${maxBytes}`)
    this.name = 'TrajectoryItemTooLargeError'
  }
}

interface PendingRecord {
  item: TrajectoryItem
  context: RecordContext
  estimatedBytes: number
  line?: TrajectoryLine
  encoded?: string
}

interface LeaseRecord {
  token: string
  pid: number
  acquiredAt: number
}

const LEASE_STALE_MS = 30 * 60_000
const LEASE_HEARTBEAT_MS = 60_000

export class TrajectoryWriterLeaseError extends Error {
  constructor(readonly trajectoryId: string) {
    super(`trajectory '${trajectoryId}' already has an active writer`)
    this.name = 'TrajectoryWriterLeaseError'
  }
}

export class TrajectoryRecorder {
  readonly trajectoryId: string
  readonly descriptor: TrajectoryDescriptor
  readonly path: string
  private readonly options: TrajectoryRecorderOptions
  private readonly now: () => number
  private readonly maxPendingItems: number
  private readonly maxPendingBytes: number
  private readonly maxItemBytes: number
  private readonly leaseToken = randomUUID()
  private handle: FileHandle | null = null
  private nextOrdinal = 1
  private queue: PendingRecord[] = []
  private pendingBytes = 0
  private pumping = false
  private drainWaiters: Array<() => void> = []
  private closed = false
  private lastError: unknown
  private unprojectedLines: TrajectoryLine[] = []
  private projectionChain: Promise<void> = Promise.resolve()
  private projectionDegraded = false
  private projectionWarningEmitted = false
  private leaseHeartbeat: ReturnType<typeof setInterval> | undefined
  private canonicalDegraded = false
  /** A rejected fact cannot be recreated by retrying I/O; never auto-clear it. */
  private canonicalDataLoss = false
  private healthChain: Promise<void> = Promise.resolve()
  private healthLastError: string | undefined
  private projectionNeedsFullRebuild = false

  private constructor(descriptor: TrajectoryDescriptor, options: TrajectoryRecorderOptions) {
    this.trajectoryId = options.trajectoryId ?? randomUUID()
    this.descriptor = descriptor
    this.options = options
    this.now = options.now ?? Date.now
    this.maxPendingItems = Math.max(1, options.maxPendingItems ?? 1_000)
    this.maxPendingBytes = Math.max(1_024, options.maxPendingBytes ?? 8 * 1024 * 1024)
    this.maxItemBytes = Math.min(
      this.maxPendingBytes,
      Math.max(1_024, options.maxItemBytes ?? 1024 * 1024),
    )
    this.path = trajectoryFile(this.trajectoryId, options)
  }

  static async open(
    descriptor: TrajectoryDescriptor,
    options: TrajectoryRecorderOptions = {},
  ): Promise<TrajectoryRecorder> {
    const recorder = new TrajectoryRecorder(descriptor, options)
    await recorder.initialize()
    return recorder
  }

  private async initialize(): Promise<void> {
    const dir = trajectoryDir(this.trajectoryId, this.options)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    await this.acquireLease()
    try {
      const verification = await repairAndVerifyTrajectory(this.path)
      if (!verification.valid) {
        throw new Error(`trajectory verification failed: ${verification.errors.join('; ')}`)
      }
      const priorHealth = await readTrajectoryHealth(this.trajectoryId, this.options)
      this.canonicalDegraded = priorHealth.canonicalDegraded
      this.canonicalDataLoss = priorHealth.canonicalDegraded
      this.projectionDegraded = priorHealth.projectionDegraded
      this.healthLastError = priorHealth.lastError
      this.nextOrdinal = verification.lastOrdinal + 1
      this.handle = await open(this.path, 'a+', 0o600)
      await chmod(this.path, 0o600)
      this.persistHealth()
      if (verification.lineCount === 0) {
        await this.record({
          type: 'trajectory_meta',
          subject: this.descriptor.subject,
          mode: this.descriptor.mode,
          createdAt: this.now(),
          rootTrajectoryId: this.descriptor.rootTrajectoryId,
          parentTrajectoryId: this.descriptor.parentTrajectoryId,
          workspace: this.descriptor.workspace,
          workspaceId: this.descriptor.workspaceId,
          provider: this.descriptor.provider,
          cliVersion: this.descriptor.cliVersion,
          gitBase: this.descriptor.gitBase,
          source: this.descriptor.source,
        })
        await this.barrier('trajectory_meta')
      } else {
        const indexed = await findIndexedTrajectoryById(this.trajectoryId, this.options).catch(() => null)
        if (priorHealth.projectionDegraded || !indexed || indexed.lastOrdinal < verification.lastOrdinal) {
          this.projectionNeedsFullRebuild = true
          this.scheduleProjection()
        }
      }
    } catch (error) {
      await this.handle?.close().catch(() => undefined)
      this.handle = null
      await this.releaseLease()
      throw error
    }
  }

  async record(item: TrajectoryItem, context: RecordContext = {}): Promise<void> {
    if (this.closed) throw new Error(`trajectory '${this.trajectoryId}' recorder is closed`)
    const parsed = TrajectoryItemSchema.parse(item)
    if (!shouldPersistTrajectoryItem(
      parsed,
      this.options.persistencePolicy ?? DEFAULT_TRAJECTORY_PERSISTENCE_POLICY,
    )) return
    const sanitized = sanitizeTrajectoryItem(parsed)
    const estimatedBytes = Buffer.byteLength(JSON.stringify(sanitized)) + 256
    if (estimatedBytes > this.maxItemBytes) {
      const error = new TrajectoryItemTooLargeError(estimatedBytes, this.maxItemBytes)
      this.canonicalDataLoss = true
      this.setCanonicalDegraded(true, error)
      throw error
    }
    while (
      this.queue.length >= this.maxPendingItems ||
      this.pendingBytes + estimatedBytes > this.maxPendingBytes
    ) {
      await new Promise<void>(resolve => this.drainWaiters.push(resolve))
      if (this.closed) throw new Error(`trajectory '${this.trajectoryId}' recorder closed under backpressure`)
      if (this.lastError) throw this.lastError
    }
    this.queue.push({ item: sanitized, context, estimatedBytes })
    this.pendingBytes += estimatedBytes
    void this.pump()
  }

  async barrier(_reason: string): Promise<void> {
    if (this.closed) return
    let recoveryAttempts = 0
    const recover = async (): Promise<void> => {
      recoveryAttempts++
      if (recoveryAttempts > 3) throw this.lastError
      await this.reopenAfterFailure()
    }
    while (this.queue.length > 0 || this.pumping || this.lastError) {
      if (this.lastError) {
        await recover()
        continue
      }
      if (this.pumping) {
        await new Promise<void>(resolve => this.drainWaiters.push(resolve))
        continue
      }
      await this.pump()
    }
    await this.handle?.sync()
    if (!this.canonicalDataLoss) this.setCanonicalDegraded(false)
    this.scheduleProjection()
  }

  /** Wait for canonical append+fsync and the disposable metadata projection. */
  async flushProjection(reason = 'explicit_projection_flush'): Promise<void> {
    await this.barrier(reason)
    await this.projectionChain
    if (this.unprojectedLines.length > 0) {
      await this.projectPending()
    }
  }

  /**
   * Record a canonical write failure observed by a caller rather than by the
   * recorder itself (a `record()` that rejected before reaching the queue, a
   * barrier a host could not await). Without this the caller would hold a
   * private in-memory flag that dies with the process, leaving `health.json`
   * claiming a trajectory is intact when its host knows otherwise. One durable
   * surface, so a crash cannot lose the fact that audit data is missing.
   */
  markExternalCanonicalFailure(error: unknown): void {
    this.canonicalDataLoss = true
    this.setCanonicalDegraded(true, error)
  }

  isProjectionDegraded(): boolean {
    return this.projectionDegraded
  }

  isCanonicalDegraded(): boolean {
    return this.canonicalDegraded
  }

  async close(): Promise<void> {
    if (this.closed) return
    try {
      await this.barrier('shutdown')
      await this.projectionChain
    } finally {
      this.closed = true
      await this.handle?.close().catch(() => undefined)
      this.handle = null
      await this.healthChain
      await this.releaseLease()
      this.notifyDrain()
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.lastError || this.closed) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const pending = this.queue[0]!
        if (!pending.line) {
          pending.line = {
            schemaVersion: TRAJECTORY_LINE_SCHEMA_VERSION,
            ts: pending.context.ts ?? this.now(),
            ordinal: this.nextOrdinal,
            trajectoryId: this.trajectoryId,
            runId: pending.context.runId,
            turnId: pending.context.turnId,
            item: pending.item,
          }
          pending.encoded = `${JSON.stringify(pending.line)}\n`
        }
        try {
          if (!this.handle) this.handle = await open(this.path, 'a+', 0o600)
          await this.handle.appendFile(pending.encoded!, 'utf8')
          this.unprojectedLines.push(pending.line)
          this.nextOrdinal++
          this.queue.shift()
          this.pendingBytes -= pending.estimatedBytes
          this.notifyDrain()
        } catch (error) {
          this.lastError = error
          this.setCanonicalDegraded(true, error)
          await this.handle?.close().catch(() => undefined)
          this.handle = null
          break
        }
      }
    } finally {
      this.pumping = false
      this.notifyDrain()
    }
  }

  private async reopenAfterFailure(): Promise<void> {
    const handle = await open(this.path, 'a+', 0o600)
    this.handle = handle
    this.lastError = undefined
  }

  private notifyDrain(): void {
    const waiters = this.drainWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  private scheduleProjection(): void {
    this.projectionChain = this.projectionChain
      .then(() => this.projectPending())
      .catch(error => {
        this.projectionDegraded = true
        this.healthLastError = error instanceof Error ? error.message : String(error)
        this.persistHealth()
        if (!this.projectionWarningEmitted) {
          this.projectionWarningEmitted = true
          console.warn(
            `[meta-agent/trajectory:${this.trajectoryId.slice(0, 8)}] metadata projection degraded:`,
            error instanceof Error ? error.message : String(error),
          )
        }
      })
  }

  private async projectPending(): Promise<void> {
    if (this.projectionNeedsFullRebuild) {
      const projected = projectPreservedTrajectory(await readTrajectoryPreservingUnknown(this.path))
      await upsertTrajectoryIndex(projected, this.options)
      this.unprojectedLines = this.unprojectedLines.filter(line => line.ordinal > projected.lastOrdinal)
      this.projectionNeedsFullRebuild = false
      this.projectionDegraded = false
      if (!this.canonicalDegraded) this.healthLastError = undefined
      this.persistHealth()
    }
    if (this.unprojectedLines.length === 0) return
    const snapshot = [...this.unprojectedLines]
    const indexed = await findIndexedTrajectoryById(this.trajectoryId, this.options)
    let projected: TrajectoryIndexEntry
    if (!indexed || indexed.lastOrdinal === 0) {
      const first = snapshot[0]
      if (!first || first.ordinal !== 1) {
        projected = projectTrajectory(await readTrajectory(this.path))
      } else {
        projected = projectTrajectory(snapshot)
      }
    } else {
      projected = projectTrajectoryDelta(indexed, snapshot)
    }
    await upsertTrajectoryIndex(projected, this.options)
    const through = projected.lastOrdinal
    this.unprojectedLines = this.unprojectedLines.filter(line => line.ordinal > through)
    this.projectionDegraded = false
    if (!this.canonicalDegraded) this.healthLastError = undefined
    this.persistHealth()
  }

  private async acquireLease(): Promise<void> {
    const path = trajectoryLeaseFile(this.trajectoryId, this.options)
    const record: LeaseRecord = { token: this.leaseToken, pid: process.pid, acquiredAt: this.now() }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await open(path, 'wx', 0o600)
        try {
          await fh.writeFile(JSON.stringify(record), 'utf8')
          await fh.sync()
        } finally {
          await fh.close()
        }
        this.startLeaseHeartbeat(path)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (attempt === 0 && await this.reclaimDeadLease(path)) continue
        throw new TrajectoryWriterLeaseError(this.trajectoryId)
      }
    }
  }

  private async reclaimDeadLease(path: string): Promise<boolean> {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<LeaseRecord>
      const info = await stat(path)
      const freshHeartbeat = this.now() - info.mtimeMs < LEASE_STALE_MS
      // Both conditions, deliberately. `processAlive` alone is not sound: PIDs
      // are recycled, so an unrelated process can inherit the id of the crashed
      // holder and make a dead lease look live forever. The heartbeat is what
      // actually bounds that — nobody is refreshing the mtime of a lease whose
      // owner is gone, so a recycled pid buys the stale lease at most
      // LEASE_STALE_MS. Removing either check reopens the other's failure mode.
      if (typeof raw.pid === 'number' && processAlive(raw.pid) && freshHeartbeat) return false
      await unlink(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      try {
        const info = await stat(path)
        if (this.now() - info.mtimeMs < LEASE_STALE_MS) return false
        await unlink(path)
        return true
      } catch {
        return false
      }
    }
  }

  private async releaseLease(): Promise<void> {
    if (this.leaseHeartbeat) clearInterval(this.leaseHeartbeat)
    this.leaseHeartbeat = undefined
    const path = trajectoryLeaseFile(this.trajectoryId, this.options)
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<LeaseRecord>
      if (raw.token === this.leaseToken) await unlink(path)
    } catch {
      // The lease may already have been reclaimed after a crash simulation.
    }
  }

  private startLeaseHeartbeat(path: string): void {
    if (this.leaseHeartbeat) clearInterval(this.leaseHeartbeat)
    this.leaseHeartbeat = setInterval(() => {
      const now = new Date(this.now())
      void utimes(path, now, now).catch(() => undefined)
    }, LEASE_HEARTBEAT_MS)
    this.leaseHeartbeat.unref?.()
  }

  private setCanonicalDegraded(value: boolean, error?: unknown): void {
    const message = error === undefined
      ? undefined
      : error instanceof Error ? error.message : String(error)
    if (this.canonicalDegraded === value && (!message || message === this.healthLastError)) return
    this.canonicalDegraded = value
    if (message) this.healthLastError = message
    else if (!value && !this.projectionDegraded) this.healthLastError = undefined
    this.persistHealth()
  }

  private persistHealth(): void {
    const snapshot = {
      canonicalDegraded: this.canonicalDegraded,
      projectionDegraded: this.projectionDegraded,
      lastError: this.healthLastError,
    }
    this.healthChain = this.healthChain
      .then(() => writeTrajectoryHealth(this.trajectoryId, snapshot, this.options))
      .catch(() => undefined)
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function projectedEntryForRecorder(recorder: TrajectoryRecorder): Promise<TrajectoryIndexEntry> {
  return projectTrajectory(await readTrajectory(recorder.path))
}
