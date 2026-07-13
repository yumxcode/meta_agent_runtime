import { createHash, randomUUID } from 'crypto'
import { hostname } from 'os'
import { mkdir, readdir, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { metaAgentPath } from '../../infra/metaAgentHome.js'
import { atomicWriteJson, readJsonFile, withFileLock } from '../../infra/persist/index.js'
import type { ExecutionScope, WorkspaceIdentity } from '../workspace/WorkspaceIdentity.js'
import { canonicalWorkspaceRoot } from '../workspace/WorkspaceIdentity.js'
import { setModelCallAdmissionProvider } from '../../infra/modelCallAdmission.js'

export interface HostCoordinatorOptions {
  rootDir?: string
  maxConcurrentRounds?: number
  maxConcurrentModelCalls?: number
  leaseTtlMs?: number
  pollMs?: number
  now?: () => number
}

export interface WorkspaceSchedulerLease {
  schemaVersion: '1.0'
  workspaceId: string
  workspaceRoot: string
  pid: number
  host: string
  token: string
  startedAt: number
  heartbeatAt: number
  expiresAt: number
  runtimeVersion: string
}

export interface HostAdmissionLease {
  schemaVersion: '1.0'
  leaseId: string
  ticketId: string
  kind: 'round' | 'model_call' | 'resource' | 'adapter_call'
  scope: ExecutionScope
  token: string
  resourceIds?: string[]
  resources?: HostResourceRequirement[]
  startedAt: number
  heartbeatAt: number
  expiresAt: number
}

export interface HostAdmissionHandle {
  lease: HostAdmissionLease
  heartbeat(): Promise<boolean>
  release(): Promise<void>
}

export interface HostResourceRequirement {
  id: string
  mode: 'exclusive' | 'shared'
  maxConcurrent?: number
}

interface AdmissionTicket {
  schemaVersion: '1.0'
  ticketId: string
  kind: HostAdmissionLease['kind']
  scope: ExecutionScope
  resourceIds?: string[]
  resources?: HostResourceRequirement[]
  maxConcurrent?: number
  minIntervalMs?: number
  enqueuedAt: number
  heartbeatAt: number
  expiresAt: number
  /** Durable grant written by any coordinator contender; the owner claims it on its next poll. */
  grant?: HostAdmissionLease
}

interface FairnessState {
  schemaVersion: '1.0'
  grants: Record<string, number>
  modelGrants: Record<string, number>
  adapterLastStartedAt: Record<string, number>
}

export interface HostCoordinatorSnapshot {
  workspaces: WorkspaceSchedulerLease[]
  tickets: AdmissionTicket[]
  leases: HostAdmissionLease[]
  maxConcurrentRounds: number
  maxConcurrentModelCalls: number
}

const DEFAULT_LEASE_TTL_MS = 5 * 60_000
const DEFAULT_POLL_MS = 50
const SAFE_RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@#=+-]{0,511}$/

export class WorkspaceIdentityConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceIdentityConflictError'
  }
}

export class HostSchedulerCoordinator {
  readonly rootDir: string
  readonly maxConcurrentRounds: number
  readonly maxConcurrentModelCalls: number
  private readonly leaseTtlMs: number
  private readonly pollMs: number
  private readonly now: () => number
  readonly heartbeatIntervalMs: number

  constructor(options: HostCoordinatorOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? metaAgentPath('loop-scheduler'))
    this.maxConcurrentRounds = boundedLimit(options.maxConcurrentRounds ?? envLimit('META_AGENT_LOOP_HOST_MAX_ROUNDS', 4))
    this.maxConcurrentModelCalls = boundedLimit(options.maxConcurrentModelCalls ?? envLimit('META_AGENT_LOOP_HOST_MAX_MODEL_CALLS', 4))
    this.leaseTtlMs = Math.max(1_000, options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS)
    this.heartbeatIntervalMs = Math.max(250, Math.floor(this.leaseTtlMs / 3))
    this.pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS)
    this.now = options.now ?? Date.now
  }

  private coordinatorLock(): string { return join(this.rootDir, 'coordinator') }
  private workspaceDir(): string { return join(this.rootDir, 'workspaces') }
  private ticketDir(): string { return join(this.rootDir, 'tickets') }
  private leaseDir(): string { return join(this.rootDir, 'leases') }
  private fairnessPath(): string { return join(this.rootDir, 'fairness.json') }
  private workspacePath(workspaceId: string): string { return join(this.workspaceDir(), `${workspaceId}.lease.json`) }
  private ticketPath(ticketId: string): string { return join(this.ticketDir(), `${ticketId}.json`) }
  private leasePath(leaseId: string): string { return join(this.leaseDir(), `${leaseId}.json`) }

  async acquireWorkspaceLease(
    identity: WorkspaceIdentity,
    projectDir: string,
    runtimeVersion = 'unknown',
  ): Promise<HostAdmissionHandle> {
    await this.ensureLayout()
    const workspaceRoot = await canonicalWorkspaceRoot(projectDir)
    const now = this.now()
    const token = randomUUID()
    const record: WorkspaceSchedulerLease = {
      schemaVersion: '1.0', workspaceId: identity.workspaceId, workspaceRoot,
      pid: process.pid, host: hostname(), token,
      startedAt: now, heartbeatAt: now, expiresAt: now + this.leaseTtlMs,
      runtimeVersion,
    }
    await this.locked(async () => {
      await this.reapExpiredUnlocked(now)
      const existing = await readJsonFile<WorkspaceSchedulerLease>(this.workspacePath(identity.workspaceId))
      if (existing && existing.expiresAt > now) {
        throw new WorkspaceIdentityConflictError(
          existing.workspaceRoot === workspaceRoot
            ? `workspace '${identity.workspaceId}' already has a live scheduler at ${workspaceRoot}`
            : `workspace identity '${identity.workspaceId}' is live at both ${existing.workspaceRoot} and ${workspaceRoot}`,
        )
      }
      await atomicWriteJson(this.workspacePath(identity.workspaceId), record)
    })
    return {
      lease: workspaceAsAdmission(record),
      heartbeat: () => this.refreshWorkspaceLease(identity.workspaceId, token),
      release: () => this.releaseWorkspaceLease(identity.workspaceId, token),
    }
  }

  async hasLiveWorkspaceLease(workspaceId: string): Promise<boolean> {
    const lease = await readJsonFile<WorkspaceSchedulerLease>(this.workspacePath(workspaceId))
    return !!lease && lease.expiresAt > this.now()
  }

  async acquireRound(scope: ExecutionScope, signal: AbortSignal): Promise<HostAdmissionHandle> {
    return this.acquireTicket({ kind: 'round', scope }, signal)
  }

  async acquireModelCall(scope: ExecutionScope, signal: AbortSignal): Promise<HostAdmissionHandle> {
    return this.acquireTicket({ kind: 'model_call', scope }, signal)
  }

  async acquireResources(
    scope: ExecutionScope,
    requirements: readonly HostResourceRequirement[],
    signal: AbortSignal,
  ): Promise<HostAdmissionHandle | null> {
    if (requirements.length === 0) return null
    const normalized = normalizeResources(requirements)
    return this.acquireTicket({
      kind: 'resource', scope, resources: normalized,
      resourceIds: normalized.map(resource => resource.id),
    }, signal)
  }

  async acquireAdapterCall(
    scope: ExecutionScope,
    adapterResourceId: string,
    maxConcurrent: number,
    minIntervalMs: number,
    signal: AbortSignal,
  ): Promise<HostAdmissionHandle> {
    validateResourceId(adapterResourceId)
    return this.acquireTicket({
      kind: 'adapter_call', scope,
      resourceIds: [adapterResourceId],
      maxConcurrent: boundedLimit(maxConcurrent),
      minIntervalMs: Math.max(0, Math.min(60_000, Math.floor(minIntervalMs))),
    }, signal)
  }

  async snapshot(): Promise<HostCoordinatorSnapshot> {
    await this.ensureLayout()
    return this.locked(async () => {
      await this.reapExpiredUnlocked(this.now())
      return {
        workspaces: await this.readRecords<WorkspaceSchedulerLease>(this.workspaceDir()),
        tickets: await this.readRecords<AdmissionTicket>(this.ticketDir()),
        leases: await this.readRecords<HostAdmissionLease>(this.leaseDir()),
        maxConcurrentRounds: this.maxConcurrentRounds,
        maxConcurrentModelCalls: this.maxConcurrentModelCalls,
      }
    })
  }

  private async acquireTicket(
    input: Pick<AdmissionTicket, 'kind' | 'scope'> & Partial<AdmissionTicket>,
    signal: AbortSignal,
  ): Promise<HostAdmissionHandle> {
    await this.ensureLayout()
    const ticketId = `ticket-${randomUUID()}`
    const createdAt = this.now()
    let ticket: AdmissionTicket = {
      schemaVersion: '1.0', ticketId, kind: input.kind, scope: input.scope,
      ...(input.resourceIds ? { resourceIds: input.resourceIds } : {}),
      ...(input.resources ? { resources: input.resources } : {}),
      ...(input.maxConcurrent !== undefined ? { maxConcurrent: input.maxConcurrent } : {}),
      ...(input.minIntervalMs !== undefined ? { minIntervalMs: input.minIntervalMs } : {}),
      enqueuedAt: createdAt, heartbeatAt: createdAt, expiresAt: createdAt + this.leaseTtlMs,
    }
    await atomicWriteJson(this.ticketPath(ticketId), ticket)
    let nextHeartbeatAt = createdAt + Math.floor(this.leaseTtlMs / 3)
    let nextRecoveryPumpAt = createdAt + Math.max(1_000, Math.floor(this.leaseTtlMs / 3))
    try {
      await this.pumpTickets()
      for (;;) {
        if (signal.aborted) throw signal.reason ?? new Error('host admission aborted')
        const onDisk = await readJsonFile<AdmissionTicket>(this.ticketPath(ticketId))
        if (!onDisk) throw new Error(`host admission ticket '${ticketId}' vanished`)
        ticket = onDisk
        if (ticket.grant) {
          const granted = await this.locked(async () => {
            const current = await readJsonFile<AdmissionTicket>(this.ticketPath(ticketId))
            if (!current?.grant || current.grant.token !== ticket.grant!.token) return null
            await rm(this.ticketPath(ticketId), { force: true })
            return current.grant
          })
          if (granted) return this.handle(granted)
        }
        const now = this.now()
        if (now >= nextHeartbeatAt) {
          await this.locked(async () => {
            const current = await readJsonFile<AdmissionTicket>(this.ticketPath(ticketId))
            if (!current || current.grant) return
            ticket = { ...current, heartbeatAt: now, expiresAt: now + this.leaseTtlMs }
            await atomicWriteJson(this.ticketPath(ticketId), ticket)
          })
          nextHeartbeatAt = now + Math.floor(this.leaseTtlMs / 3)
        }
        // Normal progress is release-driven. This slow pump only handles
        // crashed holders and adapter min-interval expiry without a thundering herd.
        const needsTimedPump = ticket.kind === 'adapter_call' || now >= nextRecoveryPumpAt
        if (needsTimedPump) {
          await this.pumpTickets()
          nextRecoveryPumpAt = now + Math.max(1_000, Math.floor(this.leaseTtlMs / 3))
        }
        await abortableDelay(this.pollMs, signal)
      }
    } catch (error) {
      await this.locked(async () => {
        const current = await readJsonFile<AdmissionTicket>(this.ticketPath(ticketId))
        if (current?.ticketId === ticketId) {
          if (current.grant) {
            const lease = await readJsonFile<HostAdmissionLease>(this.leasePath(current.grant.leaseId))
            if (lease?.token === current.grant.token) await rm(this.leasePath(lease.leaseId), { force: true })
          }
          await rm(this.ticketPath(ticketId), { force: true })
        }
      }).catch(() => undefined)
      throw error
    }
  }

  private async pumpTickets(): Promise<void> {
    await this.locked(async () => {
      const now = this.now()
      await this.reapExpiredUnlocked(now)
      const tickets = await this.readRecords<AdmissionTicket>(this.ticketDir())
      const leases = await this.readRecords<HostAdmissionLease>(this.leaseDir())
      const fairness = await this.readFairness()
      await this.grantAvailableUnlocked(tickets, leases, fairness, now)
    })
  }

  private canGrant(
    ticket: AdmissionTicket,
    tickets: AdmissionTicket[],
    leases: HostAdmissionLease[],
    fairness: FairnessState,
    now: number,
  ): boolean {
    const waitingTickets = tickets.filter(value => !value.grant)
    if (ticket.kind === 'round') {
      if (leases.filter(lease => lease.kind === 'round').length >= this.maxConcurrentRounds) return false
      const roundTickets = waitingTickets.filter(value => value.kind === 'round')
      const perWorkspace = new Map<string, AdmissionTicket>()
      for (const candidate of roundTickets.sort(ticketOrder)) {
        if (!perWorkspace.has(candidate.scope.workspaceId)) perWorkspace.set(candidate.scope.workspaceId, candidate)
      }
      const winner = [...perWorkspace.values()].sort((a, b) =>
        (fairness.grants[a.scope.workspaceId] ?? 0) - (fairness.grants[b.scope.workspaceId] ?? 0) || ticketOrder(a, b),
      )[0]
      return winner?.ticketId === ticket.ticketId
    }
    if (ticket.kind === 'model_call') {
      if (leases.filter(lease => lease.kind === 'model_call').length >= this.maxConcurrentModelCalls) return false
      const perWorkspace = new Map<string, AdmissionTicket>()
      for (const candidate of waitingTickets.filter(value => value.kind === 'model_call').sort(ticketOrder)) {
        if (!perWorkspace.has(candidate.scope.workspaceId)) perWorkspace.set(candidate.scope.workspaceId, candidate)
      }
      const winner = [...perWorkspace.values()].sort((a, b) =>
        (fairness.modelGrants[a.scope.workspaceId] ?? 0) - (fairness.modelGrants[b.scope.workspaceId] ?? 0) || ticketOrder(a, b),
      )[0]
      return winner?.ticketId === ticket.ticketId
    }
    if (ticket.kind === 'adapter_call') {
      const resourceId = ticket.resourceIds![0]!
      const active = leases.filter(lease => lease.kind === 'adapter_call' && lease.resourceIds?.includes(resourceId)).length
      if (active >= (ticket.maxConcurrent ?? 1)) return false
      if (now < (fairness.adapterLastStartedAt[resourceId] ?? 0) + (ticket.minIntervalMs ?? 0)) return false
      return waitingTickets.filter(value => value.kind === 'adapter_call' && value.resourceIds?.[0] === resourceId)
        .sort(ticketOrder)[0]?.ticketId === ticket.ticketId
    }
    const firstCompatible = waitingTickets
      .filter(value => value.kind === 'resource')
      .sort(ticketOrder)
      .find(value => resourcesAvailable(value.resources ?? [], leases))
    return firstCompatible?.ticketId === ticket.ticketId
  }

  private async grantAvailableUnlocked(
    tickets: AdmissionTicket[],
    leases: HostAdmissionLease[],
    fairness: FairnessState,
    now: number,
  ): Promise<void> {
    let changed = false
    for (let pass = 0; pass < tickets.length; pass++) {
      const winner = tickets
        .filter(ticket => !ticket.grant)
        .sort(ticketOrder)
        .find(ticket => this.canGrant(ticket, tickets, leases, fairness, now))
      if (!winner) break
      const lease = this.makeLease(winner, now)
      winner.grant = lease
      winner.heartbeatAt = now
      winner.expiresAt = now + this.leaseTtlMs
      leases.push(lease)
      await atomicWriteJson(this.leasePath(lease.leaseId), lease)
      await atomicWriteJson(this.ticketPath(winner.ticketId), winner)
      if (winner.kind === 'round') {
        fairness.grants[winner.scope.workspaceId] = (fairness.grants[winner.scope.workspaceId] ?? 0) + 1
        normalizeGrantCounters(fairness.grants)
      }
      if (winner.kind === 'model_call') {
        fairness.modelGrants[winner.scope.workspaceId] = (fairness.modelGrants[winner.scope.workspaceId] ?? 0) + 1
        normalizeGrantCounters(fairness.modelGrants)
      }
      if (winner.kind === 'adapter_call' && winner.resourceIds?.[0]) {
        fairness.adapterLastStartedAt[winner.resourceIds[0]] = now
      }
      changed = true
    }
    if (changed) await atomicWriteJson(this.fairnessPath(), fairness)
  }

  private makeLease(ticket: AdmissionTicket, now: number): HostAdmissionLease {
    return {
      schemaVersion: '1.0', leaseId: `lease-${randomUUID()}`, ticketId: ticket.ticketId,
      kind: ticket.kind, scope: ticket.scope, token: randomUUID(),
      ...(ticket.resourceIds ? { resourceIds: ticket.resourceIds } : {}),
      ...(ticket.resources ? { resources: ticket.resources } : {}),
      startedAt: now, heartbeatAt: now, expiresAt: now + this.leaseTtlMs,
    }
  }

  private handle(lease: HostAdmissionLease): HostAdmissionHandle {
    return {
      lease,
      heartbeat: () => this.refreshAdmissionLease(lease.leaseId, lease.token),
      release: () => this.releaseAdmissionLease(lease.leaseId, lease.token),
    }
  }

  private async refreshWorkspaceLease(workspaceId: string, token: string): Promise<boolean> {
    return this.locked(async () => {
      const path = this.workspacePath(workspaceId)
      const record = await readJsonFile<WorkspaceSchedulerLease>(path)
      if (!record || record.token !== token) return false
      const now = this.now()
      await atomicWriteJson(path, { ...record, heartbeatAt: now, expiresAt: now + this.leaseTtlMs })
      return true
    })
  }

  private async releaseWorkspaceLease(workspaceId: string, token: string): Promise<void> {
    await this.locked(async () => {
      const path = this.workspacePath(workspaceId)
      const record = await readJsonFile<WorkspaceSchedulerLease>(path)
      if (record?.token === token) await rm(path, { force: true })
    })
  }

  private async refreshAdmissionLease(leaseId: string, token: string): Promise<boolean> {
    return this.locked(async () => {
      const path = this.leasePath(leaseId)
      const record = await readJsonFile<HostAdmissionLease>(path)
      if (!record || record.token !== token) return false
      const now = this.now()
      await atomicWriteJson(path, { ...record, heartbeatAt: now, expiresAt: now + this.leaseTtlMs })
      return true
    })
  }

  private async releaseAdmissionLease(leaseId: string, token: string): Promise<void> {
    await this.locked(async () => {
      const path = this.leasePath(leaseId)
      const record = await readJsonFile<HostAdmissionLease>(path)
      if (record?.token !== token) return
      await rm(path, { force: true })
      const now = this.now()
      await this.reapExpiredUnlocked(now)
      const tickets = await this.readRecords<AdmissionTicket>(this.ticketDir())
      const leases = await this.readRecords<HostAdmissionLease>(this.leaseDir())
      const fairness = await this.readFairness()
      await this.grantAvailableUnlocked(tickets, leases, fairness, now)
    })
  }

  private async ensureLayout(): Promise<void> {
    await Promise.all([
      mkdir(this.workspaceDir(), { recursive: true }),
      mkdir(this.ticketDir(), { recursive: true }),
      mkdir(this.leaseDir(), { recursive: true }),
    ])
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.coordinatorLock(), fn, { staleMs: 60_000, timeoutMs: 60_000 })
  }

  private async readFairness(): Promise<FairnessState> {
    const state = await readJsonFile<Partial<FairnessState>>(this.fairnessPath())
    return {
      schemaVersion: '1.0',
      grants: state?.grants ?? {},
      modelGrants: state?.modelGrants ?? {},
      adapterLastStartedAt: state?.adapterLastStartedAt ?? {},
    }
  }

  private async readRecords<T>(dir: string): Promise<T[]> {
    const names = await readdir(dir).catch(() => [])
    const values = await Promise.all(names.filter(name => name.endsWith('.json'))
      .map(name => readJsonFile<T>(join(dir, name))))
    return values.filter(value => value !== null) as T[]
  }

  private async reapExpiredUnlocked(now: number): Promise<void> {
    for (const [dir, field] of [
      [this.workspaceDir(), 'expiresAt'], [this.ticketDir(), 'expiresAt'], [this.leaseDir(), 'expiresAt'],
    ] as const) {
      const names = await readdir(dir).catch(() => [])
      await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
        const path = join(dir, name)
        const record = await readJsonFile<{ expiresAt?: number }>(path)
        if (record && typeof record[field] === 'number' && record[field]! <= now) await rm(path, { force: true })
      }))
    }
  }
}

function workspaceAsAdmission(record: WorkspaceSchedulerLease): HostAdmissionLease {
  return {
    schemaVersion: '1.0', leaseId: `workspace:${record.workspaceId}`, ticketId: 'workspace',
    kind: 'resource', scope: { workspaceId: record.workspaceId, instanceId: '$scheduler' },
    token: record.token, startedAt: record.startedAt,
    heartbeatAt: record.heartbeatAt, expiresAt: record.expiresAt,
  }
}

function resourcesAvailable(requirements: HostResourceRequirement[], leases: HostAdmissionLease[]): boolean {
  for (const requirement of requirements) {
    const holders = leases
      .filter(lease => lease.kind === 'resource')
      .flatMap(lease => (lease.resources ?? []).filter(resource => resource.id === requirement.id))
    if (requirement.mode === 'exclusive' && holders.length > 0) return false
    if (requirement.mode === 'shared') {
      if (holders.some(holder => holder.mode === 'exclusive')) return false
      const effectiveLimit = Math.min(
        requirement.maxConcurrent ?? 1,
        ...holders.filter(holder => holder.mode === 'shared').map(holder => holder.maxConcurrent ?? 1),
      )
      if (holders.length >= effectiveLimit) return false
    }
  }
  return true
}

function normalizeResources(requirements: readonly HostResourceRequirement[]): HostResourceRequirement[] {
  const byId = new Map<string, HostResourceRequirement>()
  for (const raw of requirements) {
    validateResourceId(raw.id)
    if (raw.mode !== 'exclusive' && raw.mode !== 'shared') throw new Error(`invalid resource mode for '${raw.id}'`)
    const normalized: HostResourceRequirement = raw.mode === 'exclusive'
      ? { id: raw.id, mode: 'exclusive' }
      : { id: raw.id, mode: 'shared', maxConcurrent: boundedLimit(raw.maxConcurrent ?? 1) }
    const previous = byId.get(raw.id)
    if (previous) {
      if (previous.mode !== normalized.mode || previous.maxConcurrent !== normalized.maxConcurrent) {
        throw new Error(`conflicting duplicate resource requirement '${raw.id}'`)
      }
    } else byId.set(raw.id, normalized)
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function validateResourceId(value: string): void {
  if (!SAFE_RESOURCE_ID.test(value) || /(?:token|secret|password|key)=/i.test(value)) {
    throw new Error(`invalid or secret-bearing host resource id '${value}'`)
  }
}

function ticketOrder(a: AdmissionTicket, b: AdmissionTicket): number {
  return a.enqueuedAt - b.enqueuedAt || a.ticketId.localeCompare(b.ticketId)
}

function normalizeGrantCounters(grants: Record<string, number>): void {
  const values = Object.values(grants)
  if (values.length === 0) return
  const min = Math.min(...values)
  if (min < 10_000) return
  for (const key of Object.keys(grants)) grants[key] = grants[key]! - min
}

function boundedLimit(value: number): number {
  return Number.isInteger(value) ? Math.max(1, Math.min(1_000, value)) : 1
}

function envLimit(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(done, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new Error('aborted'))
    }
    function done(): void {
      signal.removeEventListener('abort', onAbort)
      resolveDelay()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function adapterResourceId(adapterId: string, credentialProfile = 'default'): string {
  const digest = createHash('sha256').update(`${adapterId}\n${credentialProfile}`).digest('hex').slice(0, 24)
  return `adapter:${digest}`
}

setModelCallAdmissionProvider(async (scope, signal) => {
  const coordinator = new HostSchedulerCoordinator({
    ...(scope.coordinatorRoot ? { rootDir: scope.coordinatorRoot } : {}),
    ...(scope.maxConcurrentModelCalls !== undefined
      ? { maxConcurrentModelCalls: scope.maxConcurrentModelCalls }
      : {}),
  })
  const handle = await coordinator.acquireModelCall({
    workspaceId: scope.workspaceId,
    instanceId: scope.instanceId,
  }, signal)
  return {
    heartbeatIntervalMs: coordinator.heartbeatIntervalMs,
    heartbeat: () => handle.heartbeat(),
    release: () => handle.release(),
  }
})
