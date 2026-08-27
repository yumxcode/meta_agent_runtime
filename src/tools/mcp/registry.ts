/** MCP Apps extension identifier and the HTML profile supported by this host. */
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui'
export const MCP_APP_HTML_MIME_TYPE = 'text/html;profile=mcp-app'

export interface McpContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

export interface McpUiToolMeta {
  resourceUri?: string
  visibility?: Array<'model' | 'app'>
  [key: string]: unknown
}

export interface McpToolDefinition {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
  annotations?: Record<string, unknown>
  _meta?: {
    ui?: McpUiToolMeta
    /** Deprecated MCP Apps spelling retained for compatibility. */
    'ui/resourceUri'?: string
    /** ChatGPT Apps compatibility alias. */
    'openai/outputTemplate'?: string
    [key: string]: unknown
  }
}

export interface McpToolResult {
  content: McpContentBlock[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
  [key: string]: unknown
}

export interface McpResource {
  uri: string
  name?: string
  title?: string
  description?: string
  mimeType?: string
  _meta?: Record<string, unknown>
}

export interface McpResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
  _meta?: Record<string, unknown>
}

export interface McpReadResourceResult {
  contents: McpResourceContent[]
  _meta?: Record<string, unknown>
}

export interface McpClient {
  callTool(toolName: string, toolInput: Record<string, unknown>): Promise<McpToolResult>
  listTools(): Promise<McpToolDefinition[]>
  listResources?(): Promise<McpResource[]>
  readResource?(uri: string): Promise<McpReadResourceResult>
}

export interface McpAppPresentation {
  serverName: string
  tool: McpToolDefinition
  toolInput: Record<string, unknown>
  toolResult: McpToolResult
  resourceUri: string
  client: McpClient
}

/** UI-neutral hook installed by an optional host (the CLI browser sidecar). */
export interface McpAppPresenter {
  present(presentation: McpAppPresentation): Promise<void>
}

let mcpAppPresenter: McpAppPresenter | undefined

export function setMcpAppPresenter(presenter: McpAppPresenter | undefined): void {
  mcpAppPresenter = presenter
}

export function getMcpAppPresenter(): McpAppPresenter | undefined {
  return mcpAppPresenter
}

export function mcpAppsClientCapabilities(): Record<string, unknown> {
  if (!mcpAppPresenter) return {}
  return {
    extensions: {
      [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_HTML_MIME_TYPE] },
    },
  }
}

export function getMcpAppResourceUri(tool: McpToolDefinition): string | undefined {
  const value = tool._meta?.ui?.resourceUri
    ?? tool._meta?.['ui/resourceUri']
    ?? tool._meta?.['openai/outputTemplate']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Is this MCP tool exposed to `audience`?
 *
 * Asymmetric on purpose:
 *
 *   'model' — default VISIBLE. The model is the runtime's own principal; every
 *             tool the server advertises is fair game unless the server hides it.
 *
 *   'app'   — default HIDDEN. An MCP App is server-provided HTML running in a
 *             sandboxed iframe. Defaulting it open meant a server's untrusted
 *             markup could invoke every tool on that connection, with nothing
 *             between it and the call but a browser confirm() the user will
 *             click through. A server that wants a tool reachable from its own
 *             UI says so: `_meta.ui.visibility: ['model','app']`.
 */
export function isMcpToolVisibleTo(tool: McpToolDefinition, audience: 'model' | 'app'): boolean {
  const visibility = tool._meta?.ui?.visibility
  if (visibility === undefined) return audience === 'model'
  return visibility.includes(audience)
}

export const mcpClients = new Map<string, McpClient>()

// ── Pagination bounds for server-driven cursors ───────────────────────────────

/**
 * Hard caps for any `nextCursor` pagination loop against an MCP server.
 *
 * A `do { … } while (cursor)` with no bound is a liveness bug when the peer is
 * untrusted, and every MCP server is: one that returns a constant `nextCursor`
 * (malicious, or just buggy) makes the loop run forever while the result array
 * grows without limit. These caps turn that into a truncated result.
 */
export const MCP_PAGINATION_MAX_PAGES = 100
export const MCP_PAGINATION_MAX_ITEMS = 10_000

/**
 * Drive a cursor-paginated MCP list method to completion, bounded.
 *
 * Stops on: no next cursor · page cap · item cap · a REPEATED cursor (the
 * unambiguous signal that the server is not making progress).
 */
export async function collectPaginated<T>(
  serverName: string,
  method: string,
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<T[]> {
  const out: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MCP_PAGINATION_MAX_PAGES; page++) {
    const { items, nextCursor } = await fetchPage(cursor)
    out.push(...items)
    if (out.length >= MCP_PAGINATION_MAX_ITEMS) {
      warnPaginationStop(serverName, method, `item cap ${MCP_PAGINATION_MAX_ITEMS}`)
      return out.slice(0, MCP_PAGINATION_MAX_ITEMS)
    }
    if (!nextCursor) return out
    if (seen.has(nextCursor)) {
      warnPaginationStop(serverName, method, 'server repeated a cursor (no forward progress)')
      return out
    }
    seen.add(nextCursor)
    cursor = nextCursor
  }
  warnPaginationStop(serverName, method, `page cap ${MCP_PAGINATION_MAX_PAGES}`)
  return out
}

function warnPaginationStop(serverName: string, method: string, reason: string): void {
  process.stderr.write(
    `[meta-agent/mcp] "${serverName}" ${method}: stopped paginating — ${reason}. Results are truncated.\n`,
  )
}

// ── tools/list cache ──────────────────────────────────────────────────────────

/**
 * How long a `tools/list` response stays fresh.
 *
 * `mcp_call` has to look up a tool's `_meta` (for app-visibility and the MCP
 * Apps resource URI) before every single invocation. Without a cache that is an
 * extra round-trip per tool call — a second network request for HTTP servers, a
 * second stdio exchange otherwise — doubling both latency and the number of
 * things that can fail mid-call. Tool definitions are effectively static within
 * a session; servers that do change them send
 * `notifications/tools/list_changed`, which invalidates this.
 */
const TOOL_LIST_TTL_MS = 60_000

interface ToolListEntry {
  at: number
  tools: Promise<McpToolDefinition[]>
}
const _toolListCache = new Map<string, ToolListEntry>()

/**
 * Memoise a `tools/list` call for TOOL_LIST_TTL_MS.
 *
 * The PROMISE is cached, not the resolved array, so N concurrent tool calls
 * arriving on a cold cache share one request instead of stampeding the server.
 * A rejected fetch is evicted so the next call retries.
 */
export function cachedListTools(
  key: string,
  fetchTools: () => Promise<McpToolDefinition[]>,
): Promise<McpToolDefinition[]> {
  const hit = _toolListCache.get(key)
  if (hit && Date.now() - hit.at < TOOL_LIST_TTL_MS) return hit.tools
  const entry: ToolListEntry = { at: Date.now(), tools: fetchTools() }
  _toolListCache.set(key, entry)
  entry.tools.catch(() => {
    if (_toolListCache.get(key) === entry) _toolListCache.delete(key)
  })
  return entry.tools
}

/** Drop cached tool lists — one server, or all of them. */
export function invalidateToolListCache(key?: string): void {
  if (key === undefined) _toolListCache.clear()
  else _toolListCache.delete(key)
}

/**
 * Register a client under `serverName`, replacing any existing one.
 *
 * P2-6 (review 2026-08-27): this was a bare `mcpClients.set()`, and the config
 * loader replaced entries with a bare `mcpClients.delete()` followed by a
 * register. Neither closed the client being displaced, so a stdio server's
 * child process — plus its ports, file locks and pipes — outlived the
 * registration that owned it, and neither invalidated the tool-list cache, so
 * `mcp_call` could keep resolving tools against the OLD server's definitions
 * for up to TOOL_LIST_TTL_MS after the swap.
 *
 * Replacement is now a single ordered operation: close the old client, drop its
 * cached tool list, then install the new one. Every replacement path goes
 * through here so the two halves cannot drift apart again.
 */
export function registerMcpClient(serverName: string, client: McpClient): void {
  const previous = mcpClients.get(serverName)
  if (previous === client) return

  mcpClients.set(serverName, client)

  if (previous !== undefined) {
    // Close AFTER the swap: a close handler that re-enters the registry must
    // see the new client, not a half-removed old one.
    closeClient(previous)
    invalidateToolListCache(serverName)
  }
}

export function unregisterMcpClient(serverName: string): void {
  const client = mcpClients.get(serverName)
  mcpClients.delete(serverName)
  invalidateToolListCache(serverName)
  closeClient(client)
}

/**
 * Shut down every registered MCP client.
 *
 * Stdio clients now hold a LONG-LIVED server process (previously one process
 * was spawned and discarded per RPC, so there was nothing to clean up). Without
 * this, `npx …` servers would outlive the CLI as orphans, holding ports and
 * file locks. Call it from process-exit cleanup.
 */
export function disposeMcpClients(): void {
  const clients = [...mcpClients.values()]
  mcpClients.clear()
  // Cached tool lists describe servers that no longer exist.
  invalidateToolListCache()
  for (const client of clients) closeClient(client)
}

function closeClient(client: McpClient | undefined): void {
  const closable = client as { close?: () => void } | undefined
  try { closable?.close?.() } catch { /* shutdown is best-effort */ }
}

export function getRegisteredMcpServers(): string[] {
  return [...mcpClients.keys()]
}
