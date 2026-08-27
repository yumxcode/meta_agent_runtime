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
import { loadModelConfig } from '../../core/config/ConfigService.js'
import { HttpMcpClient } from './HttpMcpClient.js'
import {
  cachedListTools,
  collectPaginated,
  invalidateToolListCache,
  isMcpToolVisibleTo,
  mcpAppsClientCapabilities,
  mcpClients,
  registerMcpClient,
} from './registry.js'
import type {
  McpClient,
  McpReadResourceResult,
  McpResource,
  McpToolDefinition,
  McpToolResult,
} from './registry.js'
import { RuntimeEnv } from '../../infra/env/RuntimeEnv.js'
import { buildChildEnv } from '../../infra/env/childProcessEnv.js'
import { timeout } from '../../core/timeouts.js'
import { CLI_VERSION } from '../../cli/version.js'

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

export interface StdioServerConfig {
  type: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** Per-RPC wall-clock limit. Default META_AGENT_MCP_STDIO_TIMEOUT_MS or 60s. */
  timeoutMs?: number
  /** Maximum stdout bytes retained per RPC. Default 10 MiB. */
  maxResponseBytes?: number
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
    return loadModelConfig().apiKey ?? ''
  }
  return ''
}

/**
 * Replace "${VAR_NAME}" patterns using env + config.json fallback.
 *
 * Missing-ness is decided PER PLACEHOLDER, not on the final string. The old
 * rule was `value.includes('${') && !result.trim()` — "skip only if the whole
 * result came out blank" — which silently passed the single most common shape
 * there is, the one in this file's own example:
 *
 *   "Authorization": "Bearer ${ZHIPU_API_KEY}"
 *
 * With the key unset that interpolates to `"Bearer "`, whose `.trim()` is
 * `"Bearer"` — non-empty. So the value was accepted, the server was registered,
 * buildMcpServerInstructions advertised its tools to the model, and every call
 * 401'd at the remote end. The operator saw "MCP is flaky", never "you are
 * missing ZHIPU_API_KEY".
 *
 * Returns the names of every placeholder that resolved empty so the caller can
 * say WHICH variable is missing instead of "missing environment variable".
 *
 * Exported for tests: this is a pure function and the failure mode above is
 * exactly the kind that only a table of input shapes catches.
 */
export function interpolateEnv(
  value: string,
): { ok: true; value: string } | { ok: false; missing: string[] } {
  const missing: string[] = []
  const result = value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const resolved = resolveVar(varName)
    if (!resolved) {
      if (!missing.includes(varName)) missing.push(varName)
      return ''
    }
    return resolved
  })
  return missing.length > 0 ? { ok: false, missing } : { ok: true, value: result }
}

/**
 * Interpolate every value in a record. A single missing placeholder rejects the
 * WHOLE record (and therefore the whole server) — a half-authenticated MCP
 * client is not a useful thing to hand the model.
 *
 * Reports `field` alongside `missing` so the warning can name both the header /
 * env key and the variable behind it.
 */
export function interpolateRecord(
  record?: Record<string, string>,
): { ok: true; value: Record<string, string> } | { ok: false; field: string; missing: string[] } {
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(record ?? {})) {
    const resolved = interpolateEnv(v)
    if (!resolved.ok) return { ok: false, field: k, missing: resolved.missing }
    result[k] = resolved.value
  }
  return { ok: true, value: result }
}

// ── Stdio MCP client ──────────────────────────────────────────────────────────

/**
 * Stdio MCP client — ONE long-lived server process per configured server,
 * speaking newline-delimited JSON-RPC 2.0 over stdin/stdout (the framing the
 * MCP stdio transport specifies).
 *
 * This replaces a spawn-per-RPC implementation that was wrong in three ways:
 *
 *   1. STATE. Every call — `initialize`, `tools/list`, each `tools/call` — got
 *      a brand-new process, whose stdin was then closed. Any server holding a
 *      connection, cache, auth session or subscription was reset between calls,
 *      so the `initialize` handshake could never mean anything. Stateful
 *      servers simply could not work.
 *   2. COST. A process launch (often `npx …`) per tool call, on the latency
 *      path of every model turn.
 *   3. TERMINAL CORRUPTION. stderr was 'inherit', so a chatty server wrote
 *      straight into the CLI's TTY — scrambling the REPL, the thinking meter
 *      and bracketed-paste state. It is piped and prefixed now.
 *
 * Responses are routed by JSON-RPC id, so concurrent in-flight requests are
 * safe. A dead/wedged process is torn down and lazily respawned on the next
 * call, so a crashed server degrades to "this call failed" rather than
 * "this server is gone for the session".
 */
const DEFAULT_STDIO_TIMEOUT_MS = 60_000
const DEFAULT_STDIO_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
/** Bound on a single unterminated stdout line, so a server that never emits a newline can't grow the buffer forever. */
const MAX_PENDING_LINE_BYTES = 64 * 1024 * 1024

/**
 * Bound on a single unterminated STDERR line (P2-5, review 2026-08-27).
 *
 * stdout had both a response-byte cap and an unterminated-line cap; stderr had
 * neither and simply did `stderrLine += chunk`. A server that logs continuously
 * without ever emitting a newline — a progress spinner writing `\r`, or a
 * runaway loop — grew that string until the process died of OOM.
 *
 * Much smaller than the stdout cap on purpose: stdout carries protocol payloads
 * that are legitimately large, stderr carries human-readable log lines. 1 MiB
 * of unbroken diagnostic text is already pathological.
 */
const MAX_STDERR_LINE_BYTES = 1024 * 1024

/** Per-line print cap; the rest of an over-long line is summarised, not echoed. */
const MAX_STDERR_ECHO_CHARS = 8 * 1024

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

export class StdioMcpClient implements McpClient {
  private readonly _config: StdioServerConfig
  private readonly _serverName: string
  private _idCounter = 1
  private _child: ReturnType<typeof spawn> | null = null
  private _pending = new Map<number, PendingRpc>()
  private _stdoutBuffer = ''
  private _bytesSinceLastMessage = 0
  private _handshake: Promise<void> | null = null
  private _closed = false

  constructor(config: StdioServerConfig, serverName = config.command) {
    this._config = config
    this._serverName = serverName
  }

  private get _timeoutMs(): number {
    const cfg = this._config
    return Number.isFinite(cfg.timeoutMs) && (cfg.timeoutMs ?? 0) > 0
      ? cfg.timeoutMs!
      : timeout('mcpStdioMs')
  }

  private get _maxBytes(): number {
    const cfg = this._config
    return Number.isFinite(cfg.maxResponseBytes) && (cfg.maxResponseBytes ?? 0) > 0
      ? cfg.maxResponseBytes!
      : RuntimeEnv.mcpStdioMaxResponseBytes(DEFAULT_STDIO_MAX_RESPONSE_BYTES)
  }

  /**
   * Tear down the process and fail every in-flight request with `reason`.
   *
   * `source` guards against a STALE generation tearing down a live one. Killing
   * a process makes its own 'close'/'error' handlers fire a tick later, by
   * which time a retry may already have spawned a replacement and queued new
   * requests against it — the late event would then kill the healthy process
   * and reject those requests with the *previous* generation's error. (This
   * showed up immediately as "server exited with code null" surfacing where a
   * timeout error belonged.) Handlers pass the child they belong to; anything
   * that isn't the current child is ignored.
   */
  private _teardown(reason: Error, source?: ReturnType<typeof spawn>): void {
    if (source !== undefined && this._child !== source) return
    const child = this._child
    this._child = null
    this._handshake = null
    this._stdoutBuffer = ''
    this._bytesSinceLastMessage = 0

    const pending = [...this._pending.values()]
    this._pending.clear()
    for (const p of pending) {
      clearTimeout(p.timer)
      p.reject(reason)
    }

    if (child?.pid !== undefined) {
      try {
        // Kill the whole group: MCP servers are commonly `npx <pkg>` wrappers,
        // so signalling only the direct child orphans the real server.
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { /* already exited */ }
    }
  }

  /** Consume complete newline-delimited JSON messages out of the stdout buffer. */
  private _drainStdout(): void {
    for (;;) {
      const newlineAt = this._stdoutBuffer.indexOf('\n')
      if (newlineAt < 0) break
      const line = this._stdoutBuffer.slice(0, newlineAt).trim()
      this._stdoutBuffer = this._stdoutBuffer.slice(newlineAt + 1)
      this._bytesSinceLastMessage = 0
      if (!line) continue

      let parsed: { id?: unknown; result?: unknown; error?: { code: number; message: string } }
      try {
        parsed = JSON.parse(line)
      } catch {
        // Not JSON — some servers print banners to stdout before speaking
        // protocol. Ignore rather than failing the whole session.
        continue
      }

      // Notifications carry no id and need no routing.
      if (typeof parsed.id !== 'number') continue
      const entry = this._pending.get(parsed.id)
      if (!entry) continue
      this._pending.delete(parsed.id)
      clearTimeout(entry.timer)
      if (parsed.error) entry.reject(new Error(`MCP error: ${parsed.error.message}`))
      else entry.resolve(parsed.result)
    }
  }

  /** Start the server process if it isn't running. Idempotent. */
  private _ensureProcess(): ReturnType<typeof spawn> {
    if (this._child && this._child.exitCode === null && !this._child.killed) return this._child
    if (this._closed) throw new Error(`MCP stdio server "${this._serverName}" is closed`)

    const cfg = this._config
    const child = spawn(cfg.command, cfg.args ?? [], {
      cwd: cfg.cwd,
      // Credential hygiene: the server gets the SAME filtered env the bash tool
      // gets, plus exactly the variables its mcp.json entry declares. Previously
      // this was `{...process.env}` — every provider key, GITHUB_TOKEN and AWS
      // secret handed to an arbitrary third-party binary. Declaring `env` in
      // mcp.json is now the audit point for "which server sees which secret".
      env: buildChildEnv('filtered', cfg.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this._child = child

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (this._child !== child) return          // stale generation
      this._bytesSinceLastMessage += Buffer.byteLength(chunk, 'utf8')
      if (this._bytesSinceLastMessage > this._maxBytes) {
        this._teardown(new Error(`MCP stdio response exceeded ${this._maxBytes} bytes`), child)
        return
      }
      this._stdoutBuffer += chunk
      if (this._stdoutBuffer.length > MAX_PENDING_LINE_BYTES) {
        this._teardown(new Error('MCP stdio server produced an unterminated line larger than the buffer cap'), child)
        return
      }
      this._drainStdout()
    })

    // stderr is PIPED (not inherited) and prefixed, so server logs are
    // attributable and cannot corrupt the CLI's terminal rendering.
    //
    // P2-5: bounded on both axes. The accumulator is capped so an unterminated
    // line cannot grow without limit (OOM), and each echoed line is truncated
    // so one enormous log entry cannot flood the user's terminal. Neither cap
    // tears down the server — stderr is diagnostics, and losing log text is a
    // far better outcome than killing a working MCP connection over it.
    child.stderr?.setEncoding('utf8')
    let stderrLine = ''
    let stderrOverflowed = false
    child.stderr?.on('data', (chunk: string) => {
      if (this._child !== child) return          // stale generation
      stderrLine += chunk
      const lines = stderrLine.split('\n')
      stderrLine = lines.pop() ?? ''

      if (stderrLine.length > MAX_STDERR_LINE_BYTES) {
        // Drop the unterminated remainder and keep draining. Announce once per
        // overflow episode so the truncation is visible but not itself spammy.
        if (!stderrOverflowed) {
          stderrOverflowed = true
          process.stderr.write(
            `[mcp:${this._serverName}] stderr line exceeded ${MAX_STDERR_LINE_BYTES} bytes; ` +
            'discarding until the next newline\n',
          )
        }
        stderrLine = ''
      } else if (stderrLine.length === 0) {
        stderrOverflowed = false
      }

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const echo = trimmed.length > MAX_STDERR_ECHO_CHARS
          ? `${trimmed.slice(0, MAX_STDERR_ECHO_CHARS)}… [truncated ${trimmed.length - MAX_STDERR_ECHO_CHARS} chars]`
          : trimmed
        process.stderr.write(`[mcp:${this._serverName}] ${echo}\n`)
      }
    })

    child.on('error', err => this._teardown(err instanceof Error ? err : new Error(String(err)), child))
    child.on('close', code => {
      // Only meaningful if requests are still outstanding; an idle exit is fine.
      this._teardown(new Error(`MCP stdio server "${this._serverName}" exited with code ${code}`), child)
    })
    child.stdin?.on('error', err => this._teardown(err instanceof Error ? err : new Error(String(err)), child))

    return child
  }

  /** Send a request and await its id-matched response. */
  private _request<T>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = this._ensureProcess()
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }

      const id = this._idCounter++
      const timeoutMs = this._timeoutMs
      const timer = setTimeout(() => {
        // A server that missed a response is assumed wedged: tear the process
        // down (killing the group) so the next call gets a clean one, rather
        // than queueing behind a hung server forever.
        this._teardown(new Error(`MCP stdio RPC "${method}" timed out after ${timeoutMs}ms`), child)
      }, timeoutMs)

      this._pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
        method,
      })

      const body = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      })
      try {
        child.stdin?.write(body + '\n')
      } catch (err) {
        this._teardown(err instanceof Error ? err : new Error(String(err)), child)
      }
    })
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response expected). */
  private _notify(method: string, params?: unknown): void {
    try {
      const child = this._ensureProcess()
      child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }) + '\n')
    } catch { /* best-effort */ }
  }

  /**
   * Run the MCP `initialize` handshake once per process lifetime.
   *
   * Best-effort by design: the previous implementation never sent `initialize`
   * at all, so servers that tolerate its absence are already in the wild and
   * must keep working. A handshake failure is therefore logged-and-ignored
   * rather than fatal — but for a spec-conforming stateful server it is what
   * makes the persistent connection usable.
   */
  private _ensureHandshake(): Promise<void> {
    this._handshake ??= (async () => {
      try {
        await this._request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: mcpAppsClientCapabilities(),
          clientInfo: { name: 'meta-agent', version: CLI_VERSION },
        })
        this._notify('notifications/initialized')
      } catch {
        // Server does not implement initialize, or it failed. Continue anyway.
      }
    })()
    return this._handshake
  }

  private async _rpc<T>(method: string, params?: unknown): Promise<T> {
    await this._ensureHandshake()
    return this._request<T>(method, params)
  }

  /** Stop the server process. Safe to call more than once. */
  close(): void {
    this._closed = true
    this._teardown(new Error(`MCP stdio server "${this._serverName}" was closed`))
  }

  async listTools(): Promise<McpToolDefinition[]> {
    // Cached: mcp_call needs the tool's _meta before every invocation, which
    // would otherwise be a second stdio round-trip per tool call. The catch is
    // outside the cached function so a transient failure evicts the entry
    // instead of pinning an empty tool list for the whole TTL.
    try {
      return await cachedListTools(`stdio:${this._serverName}`, async () => {
        const result = await this._rpc<{ tools: McpToolDefinition[] }>('tools/list')
        return result?.tools ?? []
      })
    } catch { return [] }
  }

  async callTool(toolName: string, toolInput: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this._rpc<McpToolResult>(
      'tools/call',
      { name: toolName, arguments: toolInput },
    )
    return result ? { ...result, content: Array.isArray(result.content) ? result.content : [] } : { content: [] }
  }

  async listResources(): Promise<McpResource[]> {
    // Bounded — see collectPaginated. A stdio server that returns a constant
    // nextCursor would otherwise spin this loop forever.
    return collectPaginated<McpResource>(this._serverName, 'resources/list', async cursor => {
      const result = await this._rpc<{ resources?: McpResource[]; nextCursor?: string }>(
        'resources/list',
        cursor ? { cursor } : undefined,
      )
      return {
        items: result?.resources ?? [],
        ...(result?.nextCursor ? { nextCursor: result.nextCursor } : {}),
      }
    })
  }

  async readResource(uri: string): Promise<McpReadResourceResult> {
    const result = await this._rpc<McpReadResourceResult>('resources/read', { uri })
    return result ?? { contents: [] }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Name the variable, not just the category. "missing environment variable in
 * headers" makes the operator go read mcp.json and diff it against their shell;
 * "headers.Authorization needs ZHIPU_API_KEY" ends the investigation.
 */
function warnSkipped(
  name: string,
  section: 'headers' | 'env',
  failure: { field: string; missing: string[] },
): null {
  console.warn(
    `[mcp] Skipping server "${name}": ${section}.${failure.field} needs ` +
    `${failure.missing.map(v => `\${${v}}`).join(', ')}, which resolved empty. ` +
    `Set the variable (or config.json apiKey for GLM aliases) and restart.`,
  )
  return null
}

function buildClient(name: string, cfg: McpServerConfig): McpClient | null {
  const type = cfg.type

  if (
    type === 'http' || type === 'streamable-http' || type === 'streamableHttp' ||
    // SSE servers share the same JSON-RPC over HTTP POST path; the SSE stream
    // is only used for server-push notifications which we don't need here.
    type === 'sse'
  ) {
    const resolvedHeaders = interpolateRecord(cfg.headers)
    if (!resolvedHeaders.ok) return warnSkipped(name, 'headers', resolvedHeaders)
    return new HttpMcpClient(cfg.url, '', resolvedHeaders.value)
  }

  if (type === 'stdio') {
    const resolvedEnv = interpolateRecord(cfg.env)
    if (!resolvedEnv.ok) return warnSkipped(name, 'env', resolvedEnv)
    // Preserve the "no env block at all" shape: an empty override record and an
    // absent one mean the same thing to buildChildEnv, but keeping undefined
    // avoids churning the StdioServerConfig the client stores for diagnostics.
    const env = cfg.env ? resolvedEnv.value : undefined
    return new StdioMcpClient({ ...cfg, env }, name)
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
    const client = buildClient(name, cfg)
    if (!client) continue
    // P2-6: replacement is registerMcpClient's job now. The old `delete()` here
    // dropped the map entry without closing the displaced client (leaking its
    // child process) and without invalidating its cached tool list — and it ran
    // *before* buildClient, so a config entry that failed to build tore down a
    // working server and put nothing in its place.
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
      const tools = (await client.listTools()).filter(tool => isMcpToolVisibleTo(tool, 'model'))

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
