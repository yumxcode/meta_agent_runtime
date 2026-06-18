import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

// Session-scoped progress note store.
const progressNoteStore = new Map<string, string>()

/**
 * Get the progress note for a session.
 */
export function getProgressNoteForSession(sessionId: string): string | undefined {
  return progressNoteStore.get(sessionId)
}

/**
 * Remove the progress note for a session. Call when session ends.
 */
export function deleteProgressNoteForSession(sessionId: string): void {
  progressNoteStore.delete(sessionId)
}

export async function createProgressNoteTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'progress_note',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: '简短的进度摘要，描述当前进展状态、已完成的重要里程碑或下一步计划',
        },
      },
      required: ['note'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const note = input['note']
      if (typeof note !== 'string' || !note.trim()) {
        return { content: 'Error: note must be a non-empty string', isError: true }
      }

      progressNoteStore.set(ctx.sessionId, note.trim())

      return {
        content: `进度摘要已更新: "${note.trim()}"`,
        isError: false,
      }
    },
  }
}
