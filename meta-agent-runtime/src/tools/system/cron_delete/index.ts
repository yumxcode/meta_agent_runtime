import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { deleteCronJob } from '../cronStore.js'

export async function createCronDeleteTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'cron_delete',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job ID returned by cron_create.' },
      },
      required: ['job_id'],
    },
    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const jobId = String(input['job_id'] ?? '').trim()
      if (!jobId) return { content: 'Error: job_id is required', isError: true }

      const deleted = deleteCronJob(jobId)
      if (!deleted) {
        return {
          content: `Error: no cron job found with id "${jobId}". Use cron_list to see active jobs.`,
          isError: true,
        }
      }
      return { content: `Cron job "${jobId}" cancelled successfully.`, isError: false }
    },
  }
}
