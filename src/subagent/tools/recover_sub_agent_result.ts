import type { MetaAgentTool, ToolResult } from '../../core/types.js'
import { readTask } from '../SubAgentTaskStore.js'
import {
  isValidSubAgentTaskId,
  TERMINAL_STATUSES,
  type SubAgentRecord,
  type SubAgentTaskId,
} from '../types.js'
import {
  DEFAULT_SUB_AGENT_RESULT_PAGE_CHARS,
  MAX_SUB_AGENT_RESULT_PAGE_CHARS,
  renderSubAgentResultPage,
} from './get_sub_agent_result.js'

type TaskReader = (taskId: SubAgentTaskId) => Promise<SubAgentRecord | null>

/**
 * Explicit escape hatch for recovering a terminal output from another parent
 * session. The permission is deliberately sensitive and outside-workspace, so
 * autonomous workspace auto-approval cannot silently bypass the human gate.
 * Only result.output is rendered; config, prompts, credentials and owner id are
 * never returned.
 */
export function makeRecoverSubAgentResultTool(
  readRecord: TaskReader = readTask,
): MetaAgentTool {
  return {
    name: 'recover_sub_agent_result',
    abortSupport: 'bounded',
    permission: {
      category: 'state',
      sensitive: true,
      requiresWorkspace: false,
      planMode: 'ask',
    },
    description: `Recover a terminal sub-agent's structured output across parent sessions.

Use this only when the user explicitly asks to recover a known historical task.
The call requires approval and returns bounded pages of sanitized result.output;
it never exposes the owning session id, raw task record, prompts, config, or API
credentials. Start at offset=0 and continue with next_offset until done=true.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'Exact historical task ID supplied by the user.',
        },
        offset: { type: 'number', description: 'Character offset. Default: 0.' },
        limit: {
          type: 'number',
          description:
            `Maximum characters in this page. Default: ${DEFAULT_SUB_AGENT_RESULT_PAGE_CHARS}, ` +
            `max: ${MAX_SUB_AGENT_RESULT_PAGE_CHARS}.`,
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      const taskId = String(input['task_id'] ?? '').trim() as SubAgentTaskId
      if (!taskId) return { content: 'Error: task_id is required', isError: true }
      if (!isValidSubAgentTaskId(taskId)) {
        return { content: 'Error: task_id has an invalid format', isError: true }
      }
      const record = await readRecord(taskId)
      if (!record) return { content: `Error: No task found with ID "${taskId}".`, isError: true }
      if (!TERMINAL_STATUSES.has(record.status)) {
        return {
          content:
            `Error: Task "${taskId}" is ${record.status}; cross-session recovery is terminal-only. ` +
            'Resume the owning session to monitor or control a live task.',
          isError: true,
        }
      }
      return renderSubAgentResultPage(record, input, true)
    },
  }
}
