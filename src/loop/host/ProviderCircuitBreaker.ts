import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ExecutionFailure } from '../../infra/failures/ExecutionFailure.js'
import { atomicWriteJson, readJsonFile, withFileLock } from '../../infra/persist/index.js'
import type { ProviderId } from '../../providers/registry.js'

export interface ProviderCircuitBreakerOptions {
  rootDir: string
  now?: () => number
  transientCooldownMs?: number
  blockedCooldownMs?: number
}

export interface ProviderCircuitPermit {
  providerId: ProviderId
  token: string
  startedAt: number
  probe: boolean
}

export interface ProviderCircuitRecord {
  schemaVersion: 'provider-circuit-1.0'
  providerId: ProviderId
  state: 'open' | 'half_open'
  category: ExecutionFailure['category']
  reason: string
  openedAt: number
  retryAt: number
  updatedAt: number
  failureCount: number
  probeToken?: string
}

export class ProviderCircuitOpenError extends Error {
  readonly failure: ExecutionFailure

  constructor(readonly record: ProviderCircuitRecord, now = Date.now()) {
    const retryAfterMs = Math.max(0, record.retryAt - now)
    super(`provider circuit '${record.providerId}' is ${record.state}; retry after ${retryAfterMs}ms: ${record.reason}`)
    this.name = 'ProviderCircuitOpenError'
    this.failure = {
      category: record.category === 'provider_blocked' ? 'provider_blocked' : 'provider_transient',
      message: this.message,
      retryable: record.category !== 'provider_blocked',
      providerId: record.providerId,
      retryAfterMs,
      details: [record.reason],
    }
  }
}

export class ProviderCircuitBreaker {
  private readonly rootDir: string
  private readonly now: () => number
  private readonly transientCooldownMs: number
  private readonly blockedCooldownMs: number

  constructor(options: ProviderCircuitBreakerOptions) {
    this.rootDir = resolve(options.rootDir)
    this.now = options.now ?? Date.now
    this.transientCooldownMs = Math.max(1_000, options.transientCooldownMs ?? 30_000)
    this.blockedCooldownMs = Math.max(this.transientCooldownMs, options.blockedCooldownMs ?? 5 * 60_000)
  }

  async beforeCall(providerId: ProviderId): Promise<ProviderCircuitPermit> {
    await this.ensureLayout()
    const token = randomUUID()
    const startedAt = this.now()
    return this.locked(async () => {
      const record = await readJsonFile<ProviderCircuitRecord>(this.path(providerId))
      if (!record) return { providerId, token, startedAt, probe: false }
      if (record.state === 'half_open') throw new ProviderCircuitOpenError(record, startedAt)
      if (record.retryAt > startedAt) throw new ProviderCircuitOpenError(record, startedAt)
      const probe: ProviderCircuitRecord = {
        ...record,
        state: 'half_open',
        probeToken: token,
        updatedAt: startedAt,
      }
      await atomicWriteJson(this.path(providerId), probe)
      return { providerId, token, startedAt, probe: true }
    })
  }

  async recordSuccess(permit: ProviderCircuitPermit): Promise<void> {
    await this.ensureLayout()
    await this.locked(async () => {
      const path = this.path(permit.providerId)
      const record = await readJsonFile<ProviderCircuitRecord>(path)
      if (!record) return
      // A success from work admitted before another call opened the circuit
      // must not erase the newer failure. Only the half-open probe may close it.
      if (permit.probe && record.state === 'half_open' && record.probeToken === permit.token) {
        await rm(path, { force: true })
      }
    })
  }

  async recordFailure(permit: ProviderCircuitPermit, failure: ExecutionFailure): Promise<void> {
    if (!isCircuitFailure(failure)) return
    await this.ensureLayout()
    const now = this.now()
    await this.locked(async () => {
      const path = this.path(permit.providerId)
      const existing = await readJsonFile<ProviderCircuitRecord>(path)
      const cooldown = failure.category === 'provider_blocked'
        ? this.blockedCooldownMs
        : Math.max(this.transientCooldownMs, failure.retryAfterMs ?? 0)
      const record: ProviderCircuitRecord = {
        schemaVersion: 'provider-circuit-1.0',
        providerId: permit.providerId,
        state: 'open',
        category: failure.category,
        reason: failure.message.slice(0, 1_000),
        openedAt: existing?.openedAt ?? now,
        retryAt: now + cooldown,
        updatedAt: now,
        failureCount: (existing?.failureCount ?? 0) + 1,
      }
      await atomicWriteJson(path, record)
    })
  }

  async abandon(permit: ProviderCircuitPermit): Promise<void> {
    if (!permit.probe) return
    await this.ensureLayout()
    await this.locked(async () => {
      const path = this.path(permit.providerId)
      const record = await readJsonFile<ProviderCircuitRecord>(path)
      if (record?.state !== 'half_open' || record.probeToken !== permit.token) return
      await atomicWriteJson(path, {
        ...record,
        state: 'open',
        retryAt: this.now(),
        updatedAt: this.now(),
        probeToken: undefined,
      } satisfies ProviderCircuitRecord)
    })
  }

  async reset(providerId?: ProviderId): Promise<number> {
    await this.ensureLayout()
    return this.locked(async () => {
      if (providerId) {
        const existed = await readJsonFile<ProviderCircuitRecord>(this.path(providerId))
        await rm(this.path(providerId), { force: true })
        return existed ? 1 : 0
      }
      const names = (await readdir(this.circuitsDir())).filter(name => name.endsWith('.json'))
      await Promise.all(names.map(name => rm(join(this.circuitsDir(), name), { force: true })))
      return names.length
    })
  }

  async snapshot(): Promise<ProviderCircuitRecord[]> {
    await this.ensureLayout()
    const names = (await readdir(this.circuitsDir())).filter(name => name.endsWith('.json'))
    const records = await Promise.all(names.map(name => readJsonFile<ProviderCircuitRecord>(join(this.circuitsDir(), name))))
    return records.filter((record): record is ProviderCircuitRecord => record !== null)
      .sort((a, b) => a.providerId.localeCompare(b.providerId))
  }

  private circuitsDir(): string { return join(this.rootDir, 'provider-circuits') }
  private lockPath(): string { return join(this.rootDir, 'provider-circuits-lock') }
  private path(providerId: ProviderId): string { return join(this.circuitsDir(), `${providerId}.json`) }
  private async ensureLayout(): Promise<void> { await mkdir(this.circuitsDir(), { recursive: true }) }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.lockPath(), fn, { staleMs: 60_000, timeoutMs: 60_000 })
  }
}

function isCircuitFailure(failure: ExecutionFailure): boolean {
  return failure.category === 'provider_blocked' ||
    failure.category === 'provider_transient'
}
