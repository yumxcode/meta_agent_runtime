import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

// Session-scoped artifacts store.
const artifactsStore = new Map<string, string[]>()

/**
 * Get the artifacts for a session.
 */
export function getArtifactsForSession(sessionId: string): string[] | undefined {
  return artifactsStore.get(sessionId)
}

/**
 * Remove the artifacts for a session. Call when session ends.
 */
export function deleteArtifactsForSession(sessionId: string): void {
  artifactsStore.delete(sessionId)
}

export async function createArtifactsRegisterTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'artifacts_register',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        artifacts: {
          type: 'array',
          description: '关键产出文件路径列表（替换当前列表）',
          items: { type: 'string' },
        },
      },
      required: ['artifacts'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const artifacts = input['artifacts']
      if (!Array.isArray(artifacts)) {
        return { content: 'Error: artifacts must be an array', isError: true }
      }

      // Validate all items are strings
      for (const item of artifacts) {
        if (typeof item !== 'string') {
          return { content: `Error: all artifacts must be strings, found ${typeof item}`, isError: true }
        }
      }

      const artifactsList = artifacts.map(String)
      artifactsStore.set(ctx.sessionId, artifactsList)

      const summary = artifactsList.map((a, i) => `  ${i + 1}. ${a}`).join('\n')
      return {
        content: `已注册 ${artifactsList.length} 个产出文件:\n${summary || '（无）'}`,
        isError: false,
      }
    },
  }
}
