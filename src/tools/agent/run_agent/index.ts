import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import { DEFAULT_SUB_AGENT_MAX_DURATION_MS } from '../../../subagent/types.js'
import { withReturnResultHint } from '../../../subagent/tools/return_result.js'

export async function createRunAgentTool(bridge: ISubAgentDispatcher): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'run_agent',
    abortSupport: 'cooperative',
    description,
    permission: { category: 'state', checkpointBoundary: 'both' },
    inputSchema: {
      type: 'object',
      properties: {
        task_description: { type: 'string', description: 'Full description of the sub-task. Include all context needed — the sub-agent starts with an empty conversation.' },
        system_prompt: { type: 'string', description: '(Optional) System prompt for the sub-agent.' },
        allowed_tools: { type: 'array', items: { type: 'string' }, description: '(Optional) Tools the sub-agent may use.' },
        max_turns: { type: 'number', description: 'Max turns before force-stop. Default: 10.' },
        max_budget_usd: { type: 'number', description: 'Max cost in USD. Default: 0.5.' },
        workspace_mode: {
          type: 'string',
          enum: ['shared_readonly', 'shared_write', 'isolated_write'],
          description:
            'Use isolated_write for code-producing tasks whose branch must be merged. Default: shared_write.',
        },
      },
      required: ['task_description'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const taskDescription = String(input['task_description'] ?? '').trim()
      if (!taskDescription) return { content: 'Error: task_description is required', isError: true }
      const maxTurns = typeof input['max_turns'] === 'number' ? input['max_turns'] : 10
      const maxBudgetUsd = typeof input['max_budget_usd'] === 'number' ? input['max_budget_usd'] : 0.5
      const workspaceMode =
        input['workspace_mode'] === 'isolated_write'
          ? 'isolated_write'
          : input['workspace_mode'] === 'shared_readonly'
            ? 'shared_readonly'
            : 'shared_write'
      const MAX_WAIT_MS = DEFAULT_SUB_AGENT_MAX_DURATION_MS + 60_000
      const abortableSleep = (ms: number): Promise<void> =>
        new Promise(resolve => {
          let settled = false
          let timer: ReturnType<typeof setTimeout>
          const onAbort = () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve()
          }
          timer = setTimeout(() => {
            if (settled) return
            settled = true
            ctx.abortSignal.removeEventListener('abort', onAbort)
            resolve()
          }, ms)
          if (ctx.abortSignal.aborted) onAbort()
          else ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
        })

      try {
        const record = await bridge.spawnSubAgent({
          config: {
            taskDescription: withReturnResultHint(taskDescription),
            systemPrompt: input['system_prompt'] as string | undefined,
            allowedTools: input['allowed_tools'] as string[] | undefined,
            maxTurns,
            maxBudgetUsd,
            requireHumanApproval: false,
            useEventDriven: true,
            pollIntervalMs: 1_800_000,
            checkpointEveryNTurns: 0,
            workspaceMode,
            isolateWorktree: workspaceMode === 'isolated_write',
          },
          abortSignal: ctx.abortSignal,
        })

        const onAbort = () => {
          void bridge.cancelTask(record.taskId, 'run_agent aborted').catch(() => {})
        }
        if (ctx.abortSignal.aborted) onAbort()
        else ctx.abortSignal.addEventListener('abort', onAbort, { once: true })

        let status: Awaited<ReturnType<typeof bridge.getStatus>>
        try {
          if (bridge.waitForTerminal) {
            status = await bridge.waitForTerminal(record.taskId, {
              timeoutMs: MAX_WAIT_MS,
              abortSignal: ctx.abortSignal,
            })
          } else {
            const startMs = Date.now()
            do {
              status = await bridge.getStatus(record.taskId)
              if (status && ['completed', 'failed', 'cancelled'].includes(status.status)) break
              await abortableSleep(500)
            } while (!ctx.abortSignal.aborted && Date.now() - startMs < MAX_WAIT_MS)
          }
        } finally {
          ctx.abortSignal.removeEventListener('abort', onAbort)
        }

        if (ctx.abortSignal.aborted) {
          await bridge.cancelTask(record.taskId, 'run_agent aborted').catch(() => {})
          return { content: 'Sub-agent cancelled (aborted by caller)', isError: true }
        }
        if (!status) return { content: `Internal error: task ${record.taskId} not found`, isError: true }

        if (status.status === 'completed') {
          return {
            content: JSON.stringify({
              task_id: record.taskId,
              success: status.result?.success ?? true,
              summary: status.result?.summary ?? '',
              turns_used: status.result?.turnsUsed,
              cost_usd: status.result?.costUsd,
              duration_ms: status.result?.durationMs,
              workspace_mode: status.config.workspaceMode,
            }, null, 2),
            isError: false,
          }
        }
        if (status.status === 'failed') return { content: `Sub-agent failed: ${status.result?.error ?? 'unknown error'}`, isError: true }
        if (status.status === 'cancelled') return { content: 'Sub-agent was cancelled', isError: true }

        await bridge.cancelTask(record.taskId, 'run_agent timeout').catch(() => {})
        return { content: `Sub-agent timed out after ${Math.round(MAX_WAIT_MS / 1000)}s`, isError: true }
      } catch (err) {
        return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}
