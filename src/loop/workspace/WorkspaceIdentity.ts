import { randomUUID } from 'crypto'
import { mkdir, realpath, readdir, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { atomicWriteJson, readJsonFile, withFileLock } from '../../infra/persist/index.js'

export interface WorkspaceIdentity {
  schemaVersion: '1.0'
  workspaceId: string
  createdAt: number
  forkedFrom?: string
  forkedAt?: number
}

export interface ExecutionScope {
  workspaceId: string
  instanceId: string
  round?: number
  wakeId?: string
}

const WORKSPACE_ID_RE = /^ws-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function workspaceIdentityPath(projectDir: string): string {
  return join(resolve(projectDir), '.loop', 'workspace.json')
}

export function isWorkspaceIdentity(value: unknown): value is WorkspaceIdentity {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<WorkspaceIdentity>
  return record.schemaVersion === '1.0' &&
    typeof record.workspaceId === 'string' && WORKSPACE_ID_RE.test(record.workspaceId) &&
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
}

/** Read an existing identity. Invalid identity files fail closed. */
export async function readWorkspaceIdentity(projectDir: string): Promise<WorkspaceIdentity | null> {
  const path = workspaceIdentityPath(projectDir)
  const value = await readJsonFile<unknown>(path)
  if (value === null) return null
  if (!isWorkspaceIdentity(value)) throw new Error(`invalid workspace identity at ${path}`)
  return value
}

/** Atomically create the stable identity on first use. */
export async function ensureWorkspaceIdentity(projectDir: string): Promise<WorkspaceIdentity> {
  const root = resolve(projectDir)
  await mkdir(join(root, '.loop'), { recursive: true })
  const path = workspaceIdentityPath(root)
  return withFileLock(path, async () => {
    const recovered = await completePendingFork(root)
    if (recovered) return recovered
    const existing = await readWorkspaceIdentity(root)
    if (existing) return existing
    const created: WorkspaceIdentity = {
      schemaVersion: '1.0',
      workspaceId: `ws-${randomUUID()}`,
      createdAt: Date.now(),
    }
    await atomicWriteJson(path, created)
    return created
  }, { staleMs: 5 * 60_000, timeoutMs: 60_000 })
}

/** Explicitly assign a copied workspace a new identity; ledgers remain untouched. */
export async function forkWorkspaceIdentity(projectDir: string): Promise<WorkspaceIdentity> {
  const root = resolve(projectDir)
  await mkdir(join(root, '.loop'), { recursive: true })
  const path = workspaceIdentityPath(root)
  return withWorkspaceOperationLock(root, () => withFileLock(path, async () => {
    const recovered = await completePendingFork(root)
    if (recovered) return recovered
    const previous = await readWorkspaceIdentity(root)
    const now = Date.now()
    const next: WorkspaceIdentity = {
      schemaVersion: '1.0',
      workspaceId: `ws-${randomUUID()}`,
      createdAt: now,
      ...(previous ? { forkedFrom: previous.workspaceId, forkedAt: now } : {}),
    }
    await atomicWriteJson(join(root, '.loop', 'workspace-fork.pending.json'), {
      schemaVersion: '1.0', from: previous?.workspaceId, identity: next,
    })
    await rebindInstanceRecords(root, previous?.workspaceId, next.workspaceId)
    await atomicWriteJson(path, next)
    await rm(join(root, '.loop', 'workspace-fork.pending.json'), { force: true })
    return next
  }, { staleMs: 5 * 60_000, timeoutMs: 60_000 }))
}

export function withWorkspaceOperationLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(join(resolve(projectDir), '.loop', 'workspace-operation'), fn, {
    staleMs: 5 * 60_000, timeoutMs: 60_000,
  })
}

async function completePendingFork(root: string): Promise<WorkspaceIdentity | null> {
  const markerPath = join(root, '.loop', 'workspace-fork.pending.json')
  const marker = await readJsonFile<{ from?: string; identity?: unknown }>(markerPath)
  if (!marker) return null
  if (!isWorkspaceIdentity(marker.identity)) throw new Error(`invalid pending workspace fork at ${markerPath}`)
  await rebindInstanceRecords(root, marker.from, marker.identity.workspaceId)
  await atomicWriteJson(workspaceIdentityPath(root), marker.identity)
  await rm(markerPath, { force: true })
  return marker.identity
}

async function rebindInstanceRecords(root: string, from: string | undefined, to: string): Promise<void> {
  const loopRoot = join(root, '.loop')
  const entries = await readdir(loopRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'wakes' || entry.name === 'charters') continue
    const recordPath = join(loopRoot, entry.name, 'instance.json')
    const record = await readJsonFile<Record<string, unknown>>(recordPath)
    if (!record) continue
    const current = record['workspaceId']
    if (current !== undefined && current !== from && current !== to) {
      throw new Error(`instance '${entry.name}' belongs to unexpected workspace '${String(current)}'`)
    }
    if (current !== to) await atomicWriteJson(recordPath, { ...record, workspaceId: to, updatedAt: Date.now() })
  }
}

export async function canonicalWorkspaceRoot(projectDir: string): Promise<string> {
  const root = resolve(projectDir)
  return realpath(root).catch(() => root)
}

export function workspaceScopedLineage(
  identity: Pick<WorkspaceIdentity, 'workspaceId'>,
  instanceId: string,
  suffix: string,
): string {
  const safeInstance = instanceId.replace(/[^A-Za-z0-9._-]/g, '-')
  const safeSuffix = suffix.replace(/[^A-Za-z0-9._-]/g, '-')
  return `loop-${identity.workspaceId}-${safeInstance}-${safeSuffix}`
}
