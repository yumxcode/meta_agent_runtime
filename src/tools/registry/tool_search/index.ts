import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { dynamicDescription } from '../../util.js'
import {
  toolVisibility,
  searchTools,
  namespaceOf,
  type NamespaceSummary,
} from '../../../kernel/tools/ToolVisibility.js'

export interface ToolSearchOptions {
  /**
   * How to reach the session's full tool list.
   *
   * A getter, not an array: tools are registered incrementally (MCP servers
   * connect after the session starts, modes add their own), and a snapshot
   * taken at construction would describe a registry that no longer exists.
   */
  allTools: () => readonly MetaAgentTool[]
}

/** Render the namespace inventory the model sees in place of the hidden schemas. */
function renderInventory(summaries: readonly NamespaceSummary[]): string {
  if (summaries.length === 0) return ''
  const lines = summaries
    .filter(s => s.hidden > 0)
    .map(s => `- ${s.namespace}: ${s.hidden} tool(s) not loaded (e.g. ${s.sample.join(', ')})`)
  if (lines.length === 0) return '\n\nAll available tools are currently loaded.'
  return `\n\nCurrently not loaded:\n${lines.join('\n')}`
}

export async function createToolSearchTool(
  options: ToolSearchOptions,
): Promise<MetaAgentTool> {
  // The description carries the live inventory. That inventory IS the model's
  // only signal that hidden capability exists — without it, deferral would look
  // exactly like "this runtime cannot do that", and the model would confidently
  // report a capability as missing.
  const description = dynamicDescription(import.meta.url, (base, ctx) => {
    const summaries = toolVisibility().summarise(ctx.sessionId, options.allTools())
    return `${base}${renderInventory(summaries)}`
  })

  return {
    name: 'tool_search',
    abortSupport: 'bounded',
    description,
    isConcurrencySafe: true,
    permission: { category: 'read', requiresWorkspace: false, sensitive: false, planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you need the tool to do, or its name.' },
        namespace: { type: 'string', description: 'Restrict the search to one namespace.' },
        limit: { type: 'number', description: 'Max tools to load. Default: 10' },
      },
      required: ['query'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const query = input['query']
      if (typeof query !== 'string') {
        return { content: 'Error: query is required', isError: true }
      }
      const namespaceFilter =
        typeof input['namespace'] === 'string' ? input['namespace'] : undefined
      const limit =
        typeof input['limit'] === 'number' && Number.isFinite(input['limit'])
          ? Math.max(1, Math.min(25, Math.floor(input['limit'])))
          : 10

      const registry = toolVisibility()
      const all = options.allTools()
      let candidates = registry.hidden(ctx.sessionId, all)
      if (namespaceFilter) {
        candidates = candidates.filter(t => namespaceOf(t) === namespaceFilter)
      }

      if (candidates.length === 0) {
        const summaries = registry.summarise(ctx.sessionId, all)
        const anyHidden = summaries.some(s => s.hidden > 0)
        return {
          content: namespaceFilter && anyHidden
            ? `No unloaded tools in namespace "${namespaceFilter}". ` +
              `Namespaces with unloaded tools: ${summaries.filter(s => s.hidden > 0).map(s => s.namespace).join(', ')}.`
            : 'All available tools are already loaded — nothing further to search. ' +
              'If the capability you need is not among them, it is not connected to this session.',
          isError: false,
        }
      }

      const hits = searchTools(query, candidates, limit)
      if (hits.length === 0) {
        return {
          content:
            `No tool matched "${query}" among ${candidates.length} unloaded tool(s). ` +
            `Namespaces available: ${[...new Set(candidates.map(namespaceOf))].join(', ')}. ` +
            `Try a different wording once, then treat the capability as unavailable.`,
          isError: false,
        }
      }

      registry.reveal(ctx.sessionId, hits.map(h => h.tool.name))

      // Return the descriptions inline as well as revealing the schemas. The
      // revealed schemas only reach the model on the NEXT request; without this
      // the model would have to burn a turn discovering what it just loaded.
      const rendered = hits
        .map(h => {
          const desc =
            typeof h.tool.description === 'string'
              ? h.tool.description.split('\n')[0] ?? ''
              : '(description resolved at load time)'
          return `- ${h.tool.name} [${namespaceOf(h.tool)}]: ${truncate(desc, 200)}`
        })
        .join('\n')

      return {
        content:
          `Loaded ${hits.length} tool(s); their full schemas are available from your next message onward:\n${rendered}`,
        isError: false,
      }
    },
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
