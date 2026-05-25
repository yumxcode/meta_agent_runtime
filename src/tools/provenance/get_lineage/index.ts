import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import type { ProvenanceTracker } from '../../../provenance/ProvenanceTracker.js'

async function loadPrompt(): Promise<string> {
  const dir = dirname(fileURLToPath(import.meta.url))
  return (await readFile(join(dir, 'prompt.md'), 'utf-8')).trim()
}

export async function createGetLineageTool(
  tracker: ProvenanceTracker,
): Promise<MetaAgentTool> {
  const description = await loadPrompt()

  return {
    name: 'get_computation_lineage',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        provenance_id: {
          type: 'string',
          description: 'Provenance ID of the result to trace back to its root',
        },
      },
      required: ['provenance_id'],
    },
    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const id = input['provenance_id'] as string
      const chain = await tracker.chain(id)

      if (chain.length === 0) {
        return {
          content: `No provenance record found for ID: ${id}`,
          isError: true,
        }
      }

      const lines = chain.map((r, i) => {
        const ts = new Date(r.timestamp).toISOString()
        const vvOk = r.validationResults.every(v => v.passed)
        const arrow = i === 0 ? '  ROOT' : `  └${'─'.repeat(i * 2)}►`
        return `${arrow}  [${r.id}]  ${ts}  ${r.toolName} (L${r.fidelityLevel})  ${vvOk ? '✓' : '⚠'}`
      })

      return {
        content:
          `Computation lineage (${chain.length} steps, root → most-recent):\n\n` +
          lines.join('\n'),
        isError: false,
      }
    },
  }
}
