/**
 * mcpConfigFile — load and register MCP servers from ~/.meta-agent/mcp.json.
 *
 * Config format mirrors Claude Code's mcpServers schema so users can share
 * configs across both tools:
 *
 *   ~/.meta-agent/mcp.json
 *   {
 *     "mcpServers": {
 *       "web-search-prime": {
 *         "type": "http",
 *         "url": "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
 *         "headers": { "Authorization": "Bearer ${ZHIPU_API_KEY}" }
 *       },
 *       "my-local-server": {
 *         "type": "stdio",
 *         "command": "npx",
 *         "args": ["-y", "@my/mcp-server"],
 *         "env": { "API_KEY": "${MY_API_KEY}" }
 *       }
 *     }
 *   }
 *
 * Supported types:
 *   - http  / streamable-http  — Streamable HTTP JSON-RPC (remote server)
 *   - sse                      — SSE transport (remote server, legacy)
 *   - stdio                    — local process via stdin/stdout
 *
 * Environment variable interpolation: any value of the form "${VAR_NAME}"
 * is replaced with process.env[VAR_NAME].  Entries whose required header /
 * env values resolve to empty strings are skipped with a warning.
 */

import { readFileSync } from 'fs'
import { spawn } from 'child_process'
import { join } from 'path'
import { META_AGENT_HOME } from '../../core/metaAgentHome.js'
import { loadModelConfigFile } from '../../core/modelConfigFile.js'
import { HttpMcpClient } from './HttpMcpClient.js'
import { registerMcpClient, mcpClients } from './registry.js'
import type { McpClient } from './registry.js'

// ── Config path ───────────────────────────────────────────────────────────────

export const MCP_CONFIG_PATH = join(META_AGENT_HOME, 'mcp.json')

// ── Schema types ──────────────────────────────────────────────────────────────

interface HttpServerConfig {
  type: 'http' | 'streamable-http' | 'streamableHttp'
  url: string
  headers?: Record<string, string>
}

interface SseServerConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

interface StdioServerConfig {
  type: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

type McpServerConfig = HttpServerConfig | SseServerConfig | StdioServerConfig

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>
}

// ── Variable interpolation ────────────────────────────────────────────────────

/**
 * Lookup order for ${VAR_NAME}:
 *   1. process.env[VAR_NAME]               — standard environment variables
 *   2. config.json apiKey (when VAR_NAME is a known Zhipu/GLM key alias)
 *
 * The config.json apiKey is the canonical place to store the GLM key
 * (users set it there instead of exporting an env var), so we expose it
 * under all three env-var aliases that the provider detection layer accepts.
 */
const GLM_KEY_ALIASES = new Set(['ZHIPU_API_KEY', 'ZAI_API_KEY', 'GLM_API_KEY'])

function resolveVar(varName: string): string {
  const envVal = process.env[varName]
  if (envVal) return envVal
  // Fall back to config.json apiKey for known GLM aliases
  if (GLM_KEY_ALIASES.has(varName)) {
    return loadModelConfigFile().apiKey ?? ''
  }
  return ''
}

/**
 * Replace "${VAR_NAME}" patterns using env + config.json fallback.
 * Returns undefined if a substitution resolves to an empty string
 * (signals that a required credential is missing → skip this server).
 */
function interpolateEnv(value: string): string | undefined {
  const result = value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    return resolveVar(varName)
  })
  // If the original value contained a placeholder and the result is empty,
  // the variable was missing — return undefined to signal "skip".
  return (value.includes('${') && !result.trim()) ? undefined : result
}

function interpolateRecord(
  record?: Record<string, string>,
): Record<string, string> | undefined {
  if (!record) return undefined
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(record)) {
    const resolved = interpolateEnv(v)
    if (resolved === undefined) return undefined   // missing env var → skip whole server
    result[k] = resolved
  }
  return result
}

// ── Stdio MCP client ──────────────────────────────────────────────────────────

/**
 * Minimal stdio MCP client.  Spawns the command and communicates over
 * stdin/stdout using newline-delimited JSON-RPC 2.0.
 */
class StdioMcpClient implements McpClient {
  private readonly _config: StdioServerConfig
  private _idCounter = 1

  constructor(config: StdioServerConfig) {
    this._config = config
  }

  private async _rpc<T>(method: string, params?: unknown): Promise<T> {
    const cfg = this._config
    const mergedEnv = { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: this._idCounter++,
      method,
      ...(params !== undefined ? { params } : {}),
    })

    return new Promise((resolve, reject) => {
      const child = spawn(cfg.command, cfg.args ?? [], {
        cwd: cfg.cwd,
        env: mergedEnv,
        stdio: ['pipe', 'pipe', 'inherit'],
      })

      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
          reject(new Error(`MCP stdio process exited with code ${code}`))
          return
        }
        try {
          // Find last complete JSON object in output
          const lines = stdout.trim().split('\n').filter(Boolean)
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(lines[i]!) as { result?: T; error?: { code: number; message: string } }
              if (parsed.error) reject(new Error(`MCP error: ${parsed.error.message}`))
              else resolve(parsed.result as T)
              return
            } catch { /* try previous line */ }
          }
          reject(new Error('No valid JSON-RPC response from stdio MCP server'))
        } catch (err) {
          reject(err)
        }
      })

      child.stdin.write(body + '\n')
      child.stdin.end()
    })
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    try {
      const result = await this._rpc<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>('tools/list')
      return result?.tools ?? []
    } catch { return [] }
  }

  async callTool(toolName: string, toolInput: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }> }> {
    const result = await this._rpc<{ content: Array<{ type: string; text?: string }> }>(
      'tools/call',
      { name: toolName, arguments: toolInput },
    )
    return result ?? { content: [] }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

function buildClient(name: string, cfg: McpServerConfig): McpClient | null {
  const type = cfg.type

  if (type === 'http' || type === 'streamable-http' || type === 'streamableHttp') {
    const resolvedHeaders = interpolateRecord(cfg.headers)
    if (cfg.headers && resolvedHeaders === undefined) {
      console.warn(`[mcp] Skipping server "${name}": missing environment variable in headers`)
      return null
    }
    return new HttpMcpClient(cfg.url, '', resolvedHeaders ?? {})
  }

  if (type === 'sse') {
    // SSE servers share the same JSON-RPC over HTTP POST path; the SSE stream
    // is only used for server-push notifications which we don't need here.
    const resolvedHeaders = interpolateRecord(cfg.headers)
    if (cfg.headers && resolvedHeaders === undefined) {
      console.warn(`[mcp] Skipping server "${name}": missing environment variable in headers`)
      return null
    }
    // Reuse HttpMcpClient — for tool calls the POST endpoint is the same.
    return new HttpMcpClient(cfg.url, '', resolvedHeaders ?? {})
  }

  if (type === 'stdio') {
    const resolvedEnv = interpolateRecord(cfg.env)
    if (cfg.env && resolvedEnv === undefined) {
      console.warn(`[mcp] Skipping server "${name}": missing environment variable in env`)
      return null
    }
    return new StdioMcpClient({ ...cfg, env: resolvedEnv })
  }

  console.warn(`[mcp] Unknown server type "${(cfg as McpServerConfig & { type: string }).type}" for "${name}", skipping`)
  return null
}

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Load ~/.meta-agent/mcp.json and register all configured servers.
 * Silently skips if the file does not exist.
 * Returns the list of successfully registered server names.
 */
export function loadMcpConfig(configPath: string = MCP_CONFIG_PATH): string[] {
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch {
    return []   // File does not exist — not an error
  }

  let parsed: McpConfigFile
  try {
    parsed = JSON.parse(raw) as McpConfigFile
  } catch (err) {
    console.warn(`[mcp] Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }

  const servers = parsed.mcpServers
  if (!servers || typeof servers !== 'object') return []

  const registered: string[] = []
  for (const [name, cfg] of Object.entries(servers)) {
    if (mcpClients.has(name)) {
      // Already registered (e.g. auto-registered from env) — config file wins, replace it.
      mcpClients.delete(name)
    }
    const client = buildClient(name, cfg)
    if (!client) continue
    registerMcpClient(name, client)
    registered.push(name)
  }

  return registered
}

// ── Progressive disclosure: D5 tool-name summary ──────────────────────────────

/**
 * Build McpServerInstruction[] for D5 injection (progressive disclosure).
 *
 * For each registered MCP server, calls listTools() and produces a summary
 * with tool name + description (no input schemas).  This lets the agent know
 * what each server and tool does without polluting the context with full schemas.
 *
 * The agent can call list_mcp_resources at any time for full parameter details.
 *
 * Example D5 output:
 *   ## web-search-prime
 *   可用工具:
 *   - webSearchPrime: 搜索网络信息，返回网页标题、URL、摘要等
 *   如需完整参数说明，调用 list_mcp_resources。
 */
export async function buildMcpServerInstructions(): Promise<import('../../core/dynamicPrompt.js').McpServerInstruction[]> {
  if (mcpClients.size === 0) return []

  const results = await Promise.allSettled(
    [...mcpClients.entries()].map(async ([name, client]) => {
      const tools = await client.listTools()

      let toolsBlock: string
      if (tools.length === 0) {
        toolsBlock = '可用工具: (无)'
      } else {
        const lines = tools.map(t =>
          t.description
            ? `- ${t.name}: ${t.description}`
            : `- ${t.name}`,
        )
        toolsBlock = `可用工具:\n${lines.join('\n')}`
      }

      const instructions =
        `${toolsBlock}\n如需完整参数说明，调用 list_mcp_resources。`

      return { name, instructions }
    }),
  )

  return results
    .filter((r): r is PromiseFulfilledResult<import('../../core/dynamicPrompt.js').McpServerInstruction> => r.status === 'fulfilled')
    .map(r => r.value)
}
