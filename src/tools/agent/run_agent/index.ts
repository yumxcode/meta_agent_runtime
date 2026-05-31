import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'

export async function createRunAgentTool(bridge: ISubAgentDispatcher): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'run_agent',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        task_description: { type: 'string', description: 'Full description of the sub-task. Include all context needed — the sub-agent starts with an empty conversation.' },
        system_prompt: { type: 'string', description: '(Optional) System prompt for the sub-agent.' },
        allowed_tools: { type: 'array', items: { type: 'string' }, description: '(Optional) Tools the sub-agent may use.' },
        max_turns: { type: 'number', description: 'Max turns before force-stop. Default: 10.' },
        max_budget_usd: { type: 'number', description: 'Max cost in USD. Default: 0.5.' },
      },
      required: ['task_description'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const taskDescription = String(input['task_description'] ?? '').trim()
      if (!taskDescription) return { content: 'Error: task_description is required', isError: true }
      const maxTurns = typeof input['max_turns'] === 'number' ? input['max_turns'] : 10
      const maxBudgetUsd = typeof input['max_budget_usd'] === 'number' ? input['max_budget_usd'] : 0.5
      const MAX_WAIT_MS = maxTurns * 2 * 60 * 1000  // 2 min per turn upper bound

      try {
        const record = await bridge.spawnSubAgent({
          config: {
            taskDescription,
            systemPrompt: input['system_prompt'] as string | undefined,
            allowedTools: input['allowed_tools'] as string[] | undefined,
            maxTurns,
            maxBudgetUsd,
            requireHumanApproval: false,
            useEventDriven: false,
            pollIntervalMs: 500,
            checkpointEveryNTurns: 0,
          },
          abortSignal: ctx.abortSignal,
        })

        /**
         * Abort-aware sleep: resolves after `ms` OR immediately when the
         * AbortSignal fires — whichever comes first.  Clears the timer in
         * both branches so no timer leaks under Bun or Node.
         */
        const abortableSleep = (ms: number): Promise<void> =>
          new Promise<void>((resolve) => {
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
            // Resolve immediately on abort — the timer is cleared to prevent
            // the orphaned callback from firing 500ms later (memory + CPU leak
            // when many agents are running concurrently under Bun).
            if (ctx.abortSignal.aborted) {
              onAbort()
              return
            }
            ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
          })

        const startMs = Date.now()
        while (Date.now() - startMs < MAX_WAIT_MS) {
          if (ctx.abortSignal.aborted) {
            await bridge.cancelTask(record.taskId, 'run_agent aborted').catch(() => {})
            return { content: 'Sub-agent cancelled (aborted by caller)', isError: true }
          }
          await abortableSleep(500)
          // Re-check abort immediately after waking (may have been abort-triggered)
          if (ctx.abortSignal.aborted) {
            await bridge.cancelTask(record.taskId, 'run_agent aborted').catch(() => {})
            return { content: 'Sub-agent cancelled (aborted by caller)', isError: true }
          }
          const status = await bridge.getStatus(record.taskId)
          if (!status) return { content: `Internal error: task ${record.taskId} not found`, isError: true }

          if (status.status === 'completed') {
            return {
              content: JSON.stringify({
                success: status.result?.success ?? true,
                summary: status.result?.summary ?? '',
                turns_used: status.result?.turnsUsed,
                cost_usd: status.result?.costUsd,
                duration_ms: status.result?.durationMs,
              }, null, 2),
              isError: false,
            }
          }
          if (status.status === 'failed') return { content: `Sub-agent failed: ${status.result?.error ?? 'unknown error'}`, isError: true }
          if (status.status === 'cancelled') return { content: 'Sub-agent was cancelled', isError: true }
        }

        await bridge.cancelTask(record.taskId, 'run_agent timeout').catch(() => {})
        return { content: `Sub-agent timed out after ${Math.round(MAX_WAIT_MS / 1000)}s`, isError: true }
      } catch (err) {
        return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}
