import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { createCronJob } from '../cronStore.js'

export async function createCronCreateTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'cron_create',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'Cron expression (6 fields: second minute hour dom month dow). E.g. "0 */5 * * * *" = every 5 minutes.',
        },
        description: {
          type: 'string',
          description: 'Human-readable description of what this job does.',
        },
        command: {
          type: 'string',
          description: '(Optional) Shell command to run on each tick. Executed via bash -c.',
        },
      },
      required: ['expression', 'description'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const expression = String(input['expression'] ?? '').trim()
      const desc = String(input['description'] ?? '').trim()
      const command = input['command'] ? String(input['command']) : undefined

      if (!expression) return { content: 'Error: expression is required', isError: true }
      if (!desc) return { content: 'Error: description is required', isError: true }

      try {
        let callback: () => void | Promise<void>

        if (command) {
          const { execFile } = await import('child_process')
          const { promisify } = await import('util')
          const execFileAsync = promisify(execFile)
          callback = async () => {
            await execFileAsync('bash', ['-c', command], { timeout: 30_000 })
          }
        } else {
          callback = () => { /* no-op tick */ }
        }

        const job = createCronJob(expression, desc, ctx.sessionId, callback)
        return {
          content: JSON.stringify({
            job_id: job.id,
            expression: job.expression,
            description: job.description,
            created_at: job.createdAt.toISOString(),
            message: `Cron job scheduled. Use cron_delete with id "${job.id}" to cancel.`,
          }, null, 2),
          isError: false,
        }
      } catch (err) {
        return {
          content: `Error creating cron job: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  }
}
