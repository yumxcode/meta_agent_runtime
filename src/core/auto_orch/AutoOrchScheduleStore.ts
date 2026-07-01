import { randomUUID } from 'crypto'
import { join } from 'path'
import { atomicWriteJson, listJsonIds, readJsonFile } from '../persist/index.js'
import { META_AGENT_HOME } from '../metaAgentHome.js'
import type { OrchPlan } from './LoopIR.js'

export type AutoOrchScheduleStatus =
  | 'scheduled'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AutoOrchScheduledResume {
  schemaVersion: '1.0'
  scheduleId: string
  orchestrationTaskId: string
  nodeId: string
  subTaskId: string
  agentSessionId: string
  externalRunId?: string
  resumeInstruction?: string
  runAt: number
  status: AutoOrchScheduleStatus
  attempts: number
  plan: OrchPlan
  createdAt: number
  updatedAt: number
  lastError?: string
}

function dir(): string {
  return join(META_AGENT_HOME, 'auto_orch_schedules')
}

function pathFor(scheduleId: string): string {
  return join(dir(), `${scheduleId}.json`)
}

export function makeAutoOrchScheduleId(): string {
  return `auto-orch-schedule-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export async function writeAutoOrchSchedule(record: AutoOrchScheduledResume): Promise<void> {
  await atomicWriteJson(pathFor(record.scheduleId), record)
}

export async function readAutoOrchSchedule(scheduleId: string): Promise<AutoOrchScheduledResume | null> {
  return readJsonFile<AutoOrchScheduledResume>(pathFor(scheduleId))
}

export async function listAutoOrchSchedules(): Promise<AutoOrchScheduledResume[]> {
  const ids = await listJsonIds(dir())
  const records = await Promise.all(ids.map(id => readAutoOrchSchedule(id)))
  return records
    .filter((r): r is AutoOrchScheduledResume => r !== null)
    .sort((a, b) => a.runAt - b.runAt || a.createdAt - b.createdAt)
}

export async function listDueAutoOrchSchedules(now = Date.now()): Promise<AutoOrchScheduledResume[]> {
  return (await listAutoOrchSchedules())
    .filter(r => r.status === 'scheduled' && r.runAt <= now)
}

export async function cancelAutoOrchSchedule(scheduleId: string, reason?: string): Promise<boolean> {
  const record = await readAutoOrchSchedule(scheduleId)
  if (!record || !isCancellable(record.status)) return false
  await writeAutoOrchSchedule({
    ...record,
    status: 'cancelled',
    updatedAt: Date.now(),
    lastError: reason,
  })
  return true
}

export async function cancelAutoOrchSchedulesForAgentSession(
  agentSessionId: string,
  reason?: string,
): Promise<number> {
  return cancelMatching(r => r.agentSessionId === agentSessionId, reason)
}

export async function cancelAutoOrchSchedulesForOrchestration(
  orchestrationTaskId: string,
  reason?: string,
): Promise<number> {
  return cancelMatching(r => r.orchestrationTaskId === orchestrationTaskId, reason)
}

async function cancelMatching(
  pred: (record: AutoOrchScheduledResume) => boolean,
  reason?: string,
): Promise<number> {
  const records = await listAutoOrchSchedules()
  let n = 0
  const now = Date.now()
  await Promise.all(records.map(async record => {
    if (!pred(record) || !isCancellable(record.status)) return
    await writeAutoOrchSchedule({
      ...record,
      status: 'cancelled',
      updatedAt: now,
      lastError: reason,
    })
    n++
  }))
  return n
}

function isCancellable(status: AutoOrchScheduleStatus): boolean {
  return status === 'scheduled' || status === 'running'
}
