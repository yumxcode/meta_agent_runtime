import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../subagent/types.js'
import { readTask } from '../../subagent/SubAgentTaskStore.js'
import { SessionStore } from '../SessionStore.js'
import {
  readAutoOrchSubAgentSession,
  writeAutoOrchSubAgentSession,
  type AutoOrchSubAgentSessionRecord,
} from './AutoOrchSubAgentSessionStore.js'

export interface ResumeAutoOrchSubAgentInput {
  dispatcher: ISubAgentDispatcher
  orchestrationTaskId: string
  nodeId: string
  observationPrompt: string
}

export interface ResumeAutoOrchSubAgentResult {
  record: AutoOrchSubAgentSessionRecord
  task: SubAgentRecord
}

export async function resumeAutoOrchSubAgentSession(
  input: ResumeAutoOrchSubAgentInput,
): Promise<ResumeAutoOrchSubAgentResult> {
  const record = await readAutoOrchSubAgentSession(input.orchestrationTaskId, input.nodeId)
  if (!record) {
    throw new Error(`No paused auto_orch sub-agent session for ${input.orchestrationTaskId}/${input.nodeId}`)
  }
  if (record.status !== 'paused_waiting_external') {
    throw new Error(`auto_orch sub-agent session is not paused: ${record.status}`)
  }

  const previousTask = await readTask(record.subTaskId)
  if (!previousTask?.config.autoOrch?.resumable) {
    throw new Error(`Paused auto_orch sub-agent task is missing resumable config: ${record.subTaskId}`)
  }

  const history = await SessionStore.loadHistory(record.agentSessionId)
  const updated: AutoOrchSubAgentSessionRecord = {
    ...record,
    status: 'resuming',
    updatedAt: Date.now(),
  }
  await writeAutoOrchSubAgentSession(updated)

  const task = await input.dispatcher.spawnSubAgent({
    config: {
      ...previousTask.config,
      taskDescription: input.observationPrompt,
      initialMessages: history,
      retryCount: 0,
      autoOrch: {
        ...previousTask.config.autoOrch,
        agentSessionId: record.agentSessionId,
      },
    },
  })

  return { record: updated, task }
}
