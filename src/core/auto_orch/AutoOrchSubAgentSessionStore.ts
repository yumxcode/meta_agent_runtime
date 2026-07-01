import { join } from 'path'
import { atomicWriteJson, readJsonFile, listJsonIds } from '../persist/index.js'
import { META_AGENT_HOME } from '../metaAgentHome.js'

export type AutoOrchSubAgentSessionStatus =
  | 'running'
  | 'paused_waiting_external'
  | 'resuming'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AutoOrchSubAgentSessionRecord {
  schemaVersion: '1.0'
  orchestrationTaskId: string
  nodeId: string
  subTaskId: string
  agentSessionId: string
  status: AutoOrchSubAgentSessionStatus
  pauseReason?: 'waiting_training_result' | 'waiting_external_event'
  externalRunId?: string
  resumeInstruction?: string
  lastHistoryMessageCount?: number
  createdAt: number
  updatedAt: number
}

function dir(): string {
  return join(META_AGENT_HOME, 'auto_orch_subagents')
}

function pathFor(id: string): string {
  return join(dir(), `${id}.json`)
}

export function autoOrchSubAgentRecordId(orchestrationTaskId: string, nodeId: string): string {
  return encodeURIComponent(`${orchestrationTaskId}::${nodeId}`)
}

export async function writeAutoOrchSubAgentSession(
  record: AutoOrchSubAgentSessionRecord,
): Promise<void> {
  await atomicWriteJson(
    pathFor(autoOrchSubAgentRecordId(record.orchestrationTaskId, record.nodeId)),
    record,
  )
}

export async function readAutoOrchSubAgentSession(
  orchestrationTaskId: string,
  nodeId: string,
): Promise<AutoOrchSubAgentSessionRecord | null> {
  return readJsonFile<AutoOrchSubAgentSessionRecord>(
    pathFor(autoOrchSubAgentRecordId(orchestrationTaskId, nodeId)),
  )
}

export async function findAutoOrchSubAgentSessionByExternalRunId(
  externalRunId: string,
): Promise<AutoOrchSubAgentSessionRecord | null> {
  const ids = await listJsonIds(dir())
  for (const id of ids) {
    const record = await readJsonFile<AutoOrchSubAgentSessionRecord>(pathFor(id))
    if (record?.externalRunId === externalRunId) return record
  }
  return null
}
