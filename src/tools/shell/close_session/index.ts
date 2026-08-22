import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import {
  ownerOf,
  renderSessionInfo,
  shellSessionStore,
  toToolError,
} from '../sessionSupport.js'

export async function createCloseSessionTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'close_session',
    abortSupport: 'bounded',
    description,
    permission: {
      category: 'execute',
      requiresWorkspace: false,
      // Terminating your own session is not a sensitive operation: it destroys
      // capability rather than exercising it, and prompting for it would make
      // cleanup expensive enough that the model would stop doing it.
      sensitive: false,
      planMode: 'allow',
    },
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session to terminate. Omit to list your open sessions.',
        },
      },
      required: [],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const store = shellSessionStore()
      const owner = ownerOf(ctx)
      const sessionId = input['session_id']

      try {
        if (sessionId === undefined || sessionId === '') {
          const open = store.list(owner)
          return {
            content: open.length
              ? `${open.length} session(s):\n${open.map(renderSessionInfo).join('\n')}`
              : 'No open shell sessions.',
            isError: false,
          }
        }
        if (typeof sessionId !== 'string') {
          return { content: 'Error: session_id must be a string', isError: true }
        }
        const info = store.close(owner, sessionId)
        return {
          content: info.running
            ? `Closed session ${info.id} (process group killed).`
            : `Closed session ${info.id} (had already exited with code ${info.exitCode ?? 'unknown'}).`,
          isError: false,
        }
      } catch (err) {
        return toToolError(err)
      }
    },
  }
}
