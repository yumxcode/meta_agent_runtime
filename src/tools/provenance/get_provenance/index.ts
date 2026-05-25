import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import type { ProvenanceTracker } from '../../../provenance/ProvenanceTracker.js'

async function loadPrompt(): Promise<string> {
  const dir = dirname(fileURLToPath(import.meta.url))
  return (await readFile(join(dir, 'prompt.md'), 'utf-8')).trim()
}

export async function createGetProvenanceTool(
  tracker: ProvenanceTracker,
): Promise<MetaAgentTool> {
  const description = await loadPrompt()

  return {
    name: 'get_provenance',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        provenance_id: {
          type: 'string',
          description: 'The provenance ID to retrieve (format: prov-xxxxxxxxxxxx)',
        },
      },
      required: ['provenance_id'],
    },
    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const id = input['provenance_id'] as string
      const record = await tracker.get(id)

      if (!record) {
        return {
          content: `No provenance record found for ID: ${id}`,
          isError: true,
        }
      }

      const summary = tracker.summary(id)
      return { content: await summary, isError: false }
    },
  }
}
