import { createHash } from 'crypto'
import type { MetaAgentTool, ToolResult } from '../../core/types.js'
import type { SubAgentBridge } from '../SubAgentBridge.js'
import { serializeSubAgentOutput } from '../resultArtifact.js'
import { isValidSubAgentTaskId, type SubAgentRecord } from '../types.js'

export const DEFAULT_SUB_AGENT_RESULT_PAGE_CHARS = 16 * 1024
export const MAX_SUB_AGENT_RESULT_PAGE_CHARS = 24 * 1024

/** Render one bounded page without exposing the task record itself. */
export function renderSubAgentResultPage(
  record: SubAgentRecord,
  input: Record<string, unknown>,
  crossSessionRecovery = false,
): ToolResult {
  if (!record.result) {
    return {
      content: `Error: Task "${record.taskId}" has no result yet (status: ${record.status}).`,
      isError: true,
    }
  }
  const serialized = serializeSubAgentOutput(record.result.output)
  if (serialized === undefined) {
    return { content: `Error: Task "${record.taskId}" has no structured output.`, isError: true }
  }
  const requestedOffset = typeof input['offset'] === 'number' && Number.isFinite(input['offset'])
    ? Math.trunc(input['offset'])
    : 0
  const offset = Math.max(0, requestedOffset)
  if (offset > serialized.length) {
    return {
      content: `Error: offset ${offset} exceeds output length ${serialized.length}.`,
      isError: true,
    }
  }
  const requestedLimit = typeof input['limit'] === 'number' && Number.isFinite(input['limit'])
    ? Math.trunc(input['limit'])
    : DEFAULT_SUB_AGENT_RESULT_PAGE_CHARS
  const limit = Math.max(1, Math.min(MAX_SUB_AGENT_RESULT_PAGE_CHARS, requestedLimit))
  const chunk = serialized.slice(offset, offset + limit)
  const nextOffset = offset + chunk.length
  return {
    content: JSON.stringify({
      task_id: record.taskId,
      status: record.status,
      ...(crossSessionRecovery ? { cross_session_recovery: true } : {}),
      offset,
      next_offset: nextOffset < serialized.length ? nextOffset : null,
      total_chars: serialized.length,
      sha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
      done: nextOffset >= serialized.length,
      data: chunk,
    }, null, 2),
    isError: false,
  }
}

export function makeGetSubAgentResultTool(bridge: SubAgentBridge): MetaAgentTool {
  return {
    name: 'get_sub_agent_result',
    description: `Read a completed sub-agent's authoritative structured output in bounded pages.

Use output_path from get_sub_agent_status when file tools are available. Use this
tool when the caller cannot read that artifact directly. Start with offset=0 and
continue with next_offset until done=true.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'The task ID returned by spawn_sub_agent.' },
        offset: { type: 'number', description: 'Character offset. Default: 0.' },
        limit: {
          type: 'number',
          description: `Maximum characters in this page. Default: ${DEFAULT_SUB_AGENT_RESULT_PAGE_CHARS}, max: ${MAX_SUB_AGENT_RESULT_PAGE_CHARS}.`,
        },
      },
      required: ['task_id'],
    },
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      const taskId = String(input['task_id'] ?? '').trim()
      if (!taskId) return { content: 'Error: task_id is required', isError: true }
      if (!isValidSubAgentTaskId(taskId)) {
        return { content: 'Error: task_id has an invalid format', isError: true }
      }
      const lookup = await bridge.lookupStatus(taskId)
      if (lookup.kind === 'foreign') {
        return {
          content:
            `Error: Task "${taskId}" exists but belongs to a different parent session. ` +
            'Resume that session, or use recover_sub_agent_result with explicit user approval. ' +
            'Owner identity and the raw task-record path are intentionally not exposed.',
          isError: true,
        }
      }
      if (lookup.kind === 'not_found') {
        return { content: `Error: No task found with ID "${taskId}".`, isError: true }
      }
      return renderSubAgentResultPage(lookup.record, input)
    },
  }
}
