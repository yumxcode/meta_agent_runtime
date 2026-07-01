import type { MetaAgentTool, ToolResult } from '../types.js'

export const AUTO_ORCH_PAUSE_OUTPUT_KIND = 'auto_orch_pause_external'

export interface AutoOrchPausePayload {
  kind: typeof AUTO_ORCH_PAUSE_OUTPUT_KIND
  reason: 'waiting_training_result' | 'waiting_external_event'
  externalRunId?: string
  nextCheckAfterMs?: number
  resumeInstruction?: string
  data?: unknown
}

export interface AutoOrchPauseOutput {
  auto_orch_pause: AutoOrchPausePayload
}

export function isAutoOrchPauseOutput(value: unknown): value is AutoOrchPauseOutput {
  if (!value || typeof value !== 'object') return false
  const payload = (value as Record<string, unknown>)['auto_orch_pause']
  return !!payload &&
    typeof payload === 'object' &&
    (payload as Record<string, unknown>)['kind'] === AUTO_ORCH_PAUSE_OUTPUT_KIND
}

export function makeAutoOrchPauseExternalTool(
  sink: (payload: AutoOrchPausePayload) => void,
): MetaAgentTool {
  return {
    name: 'auto_orch_pause_external',
    isConcurrencySafe: false,
    description: `Pause this auto_orch sub-agent because it is waiting for an external event such as a training run result.

Use this only after you have launched or identified the external work to wait on.
The orchestration run will stop with status "paused"; a scheduler can later
resume this same sub-agent session with the external observation.`,
    inputSchema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: {
          type: 'string',
          enum: ['waiting_training_result', 'waiting_external_event'],
          description: 'Why this sub-agent is pausing.',
        },
        externalRunId: {
          type: 'string',
          description: 'External job/run id, for example a training run id.',
        },
        nextCheckAfterMs: {
          type: 'number',
          description: 'Suggested delay before the scheduler checks again.',
        },
        resumeInstruction: {
          type: 'string',
          description: 'Instruction to use when resuming after the external result arrives.',
        },
        data: {
          type: 'object',
          description: 'Optional structured metadata for the scheduler/resume path.',
        },
      },
    },
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      const rawReason = String(input['reason'] ?? '').trim()
      if (rawReason !== 'waiting_training_result' && rawReason !== 'waiting_external_event') {
        return {
          content: 'Error: reason must be "waiting_training_result" or "waiting_external_event".',
          isError: true,
        }
      }

      const payload: AutoOrchPausePayload = {
        kind: AUTO_ORCH_PAUSE_OUTPUT_KIND,
        reason: rawReason,
      }
      const externalRunId = String(input['externalRunId'] ?? '').trim()
      if (externalRunId) payload.externalRunId = externalRunId
      const nextCheckAfterMs = input['nextCheckAfterMs']
      if (typeof nextCheckAfterMs === 'number' && Number.isFinite(nextCheckAfterMs) && nextCheckAfterMs >= 0) {
        payload.nextCheckAfterMs = nextCheckAfterMs
      }
      const resumeInstruction = String(input['resumeInstruction'] ?? '').trim()
      if (resumeInstruction) payload.resumeInstruction = resumeInstruction
      if (input['data'] !== undefined) payload.data = input['data']

      sink(payload)
      return {
        content: 'auto_orch pause recorded. Stop now; the scheduler will resume this session later.',
        isError: false,
      }
    },
  }
}
