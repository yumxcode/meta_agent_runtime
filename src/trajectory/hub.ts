import { randomUUID } from 'node:crypto'
import {
  findIndexedTrajectory,
  findTrajectoryByScanning,
  reserveTrajectoryIndex,
} from './indexStore.js'
import { TrajectoryRecorder, TrajectoryWriterLeaseError } from './recorder.js'
import type {
  RecordContext,
  TrajectoryDescriptor,
  TrajectoryItem,
  TrajectorySubject,
} from './types.js'
import type { TrajectoryPathsOptions } from './paths.js'
import { RuntimeEnv } from '../infra/env/RuntimeEnv.js'

export interface OpenTrajectoryOptions extends TrajectoryPathsOptions {
  enabled?: boolean
}

export interface RecordTrajectoryOptions extends OpenTrajectoryOptions {
  durability?: 'enqueue' | 'canonical' | 'projected'
}

const activeBySubject = new Map<string, Promise<TrajectoryRecorder | null>>()
const warnedFailures = new Set<string>()

function warnOnce(key: string, message: string): void {
  if (warnedFailures.has(key)) return
  warnedFailures.add(key)
  console.warn(message)
}

function subjectKey(subject: TrajectorySubject, rootDir?: string): string {
  const root = rootDir ?? '<default>'
  switch (subject.kind) {
    case 'session': return `${root}:session:${subject.sessionId}`
    case 'graph_instance': return `${root}:graph:${subject.workspaceId}:${subject.instanceId}`
    case 'subagent': return `${root}:subagent:${subject.taskId}:${subject.sessionId}`
  }
}

export function trajectoryEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit
  const override = RuntimeEnv.trajectoryEnabledOverride()
  if (override !== undefined) return override
  return process.env['NODE_ENV'] !== 'test'
}

export async function openTrajectory(
  descriptor: TrajectoryDescriptor,
  options: OpenTrajectoryOptions = {},
): Promise<TrajectoryRecorder | null> {
  if (!trajectoryEnabled(options.enabled)) return null
  const key = subjectKey(descriptor.subject, options.rootDir)
  const existing = activeBySubject.get(key)
  if (existing) return existing
  const opening = (async (): Promise<TrajectoryRecorder | null> => {
    try {
      const indexed = await findIndexedTrajectory(descriptor.subject, options)
        ?? await findTrajectoryByScanning(descriptor.subject, options)
      const now = Date.now()
      const reserved = indexed ?? await reserveTrajectoryIndex({
        trajectoryId: randomUUID(),
        subject: descriptor.subject,
        mode: descriptor.mode,
        createdAt: now,
        lastActivity: now,
        lastOrdinal: 0,
        workspace: descriptor.workspace,
        workspaceId: descriptor.workspaceId,
        rootTrajectoryId: descriptor.rootTrajectoryId,
        parentTrajectoryId: descriptor.parentTrajectoryId,
        toolCalls: 0,
        toolErrors: 0,
        runs: 0,
        totalCostUsd: 0,
      }, options)
      const trajectoryId = reserved.trajectoryId
      const recorder = await TrajectoryRecorder.open(descriptor, { ...options, trajectoryId })
      return recorder
    } catch (error) {
      // Another live process owns the subject. That is a deliberate fence, not
      // a reason to interrupt the existing meta-agent execution path.
      if (!(error instanceof TrajectoryWriterLeaseError)) {
        warnOnce(
          `open:${key}`,
          `[meta-agent/trajectory] persistence degraded: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return null
    }
  })()
  activeBySubject.set(key, opening)
  const recorder = await opening
  if (!recorder) activeBySubject.delete(key)
  return recorder
}

export async function recordTrajectoryItem(
  descriptor: TrajectoryDescriptor,
  item: TrajectoryItem,
  context: RecordContext = {},
  options: RecordTrajectoryOptions = {},
): Promise<string | null> {
  const { durability = 'enqueue', ...openOptions } = options
  const recorder = await openTrajectory(descriptor, openOptions)
  if (!recorder) return null
  try {
    await recorder.record(item, context)
    if (durability === 'canonical') await recorder.barrier(`item:${item.type}`)
    else if (durability === 'projected') await recorder.flushProjection(`item:${item.type}`)
    return recorder.trajectoryId
  } catch (error) {
    warnOnce(
      `record:${subjectKey(descriptor.subject, options.rootDir)}`,
      `[meta-agent/trajectory] record failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

export async function flushTrajectory(
  subject: TrajectorySubject,
  options: TrajectoryPathsOptions & { projection?: boolean } = {},
): Promise<void> {
  const key = subjectKey(subject, options.rootDir)
  const recorder = await activeBySubject.get(key)
  if (!recorder) return
  if (options.projection) await recorder.flushProjection('hub_flush')
  else await recorder.barrier('hub_flush')
}

export async function closeTrajectory(
  subject: TrajectorySubject,
  options: TrajectoryPathsOptions = {},
): Promise<void> {
  const key = subjectKey(subject, options.rootDir)
  const promise = activeBySubject.get(key)
  activeBySubject.delete(key)
  const recorder = await promise
  await recorder?.close().catch(() => undefined)
}

export function clearTrajectoryHubForTests(): void {
  activeBySubject.clear()
  warnedFailures.clear()
}
