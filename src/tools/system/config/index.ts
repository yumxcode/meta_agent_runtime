import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import {
  getValue,
  setValue,
  deleteValue,
  listValues,
  type ConfigScope,
} from '../../../core/config/ConfigService.js'

// ─────────────────────────────────────────────────────────────────────────────
// Tool
// ─────────────────────────────────────────────────────────────────────────────

const VALID_SCOPES: ConfigScope[] = ['global', 'project', 'session']

function parseScope(input: unknown): ConfigScope | undefined {
  if (input === undefined) return undefined
  const s = String(input).trim().toLowerCase()
  return (VALID_SCOPES as string[]).includes(s) ? (s as ConfigScope) : undefined
}

export async function createConfigTool(cwd?: string): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  const projectDir = cwd ?? process.cwd()

  return {
    name: 'config',
    description,
    permission: { category: 'config', pathFields: [], requiresWorkspace: false, sensitive: true, planMode: 'ask' },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'list', 'delete'],
          description: 'Operation to perform.',
        },
        key: {
          type: 'string',
          description: 'Config key (dot-notation, e.g. LLM.mainModel). Required for get / set / delete.',
        },
        value: {
          description: 'Value to set (any JSON-serialisable type). Required for action="set".',
        },
        scope: {
          type: 'string',
          enum: ['global', 'project', 'session'],
          description:
            'Layer to operate on. set/delete default to "project". For get/list, omit to see the merged effective value across all layers.',
        },
      },
      required: ['action'],
    },
    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const action = String(input['action'] ?? '').trim()
      const key = input['key'] ? String(input['key']).trim() : undefined
      const value = input['value']

      if (input['scope'] !== undefined && parseScope(input['scope']) === undefined) {
        return { content: `Error: unknown scope "${String(input['scope'])}". Use global / project / session.`, isError: true }
      }
      const scope = parseScope(input['scope'])

      try {
        if (action === 'list') {
          const obj = listValues({ projectDir, scope })
          const label = scope ? `${scope} layer` : 'merged (effective)'
          return {
            content: Object.keys(obj).length === 0
              ? `Config is empty (${label}).`
              : `# ${label}\n${JSON.stringify(obj, null, 2)}`,
            isError: false,
          }
        }

        if (action === 'get') {
          if (!key) return { content: 'Error: key is required for action="get"', isError: true }
          const val = getValue(key, { projectDir, scope })
          if (val === undefined) return { content: `Key "${key}" not found${scope ? ` in ${scope} layer` : ''}.`, isError: false }
          return { content: JSON.stringify(val, null, 2), isError: false }
        }

        if (action === 'set') {
          if (!key) return { content: 'Error: key is required for action="set"', isError: true }
          if (value === undefined) return { content: 'Error: value is required for action="set"', isError: true }
          const effectiveScope = scope ?? 'project'
          setValue(key, value, { projectDir, scope: effectiveScope })
          const note = key.startsWith('LLM.') || key.startsWith('web_search.')
            ? ' (model/provider keys take effect on the NEXT session — the current one is already resolved)'
            : ''
          return {
            content: `Set "${key}" = ${JSON.stringify(value)} in the ${effectiveScope} layer.${note}`,
            isError: false,
          }
        }

        if (action === 'delete') {
          if (!key) return { content: 'Error: key is required for action="delete"', isError: true }
          const effectiveScope = scope ?? 'project'
          const found = deleteValue(key, { projectDir, scope: effectiveScope })
          return {
            content: found
              ? `Deleted "${key}" from the ${effectiveScope} layer.`
              : `Key "${key}" not found in the ${effectiveScope} layer; nothing deleted.`,
            isError: false,
          }
        }

        return { content: `Error: unknown action "${action}". Use get / set / list / delete.`, isError: true }
      } catch (err) {
        return {
          content: `Config error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  }
}
