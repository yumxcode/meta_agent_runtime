/**
 * HttpMcpClient — McpClient implementation for remote Streamable HTTP MCP servers.
 *
 * Implements the MCP Streamable HTTP transport (2025-03-26 spec) correctly:
 *   - POST to the server URL with Content-Type: application/json
 *   - Accept BOTH application/json and text/event-stream — many servers
 *     (e.g. Zhipu's web_search_prime) reply with an SSE stream, not plain JSON.
 *   - A mandatory `initialize` handshake runs once before any other call. The
 *     server returns an `Mcp-Session-Id` response header that MUST be echoed on
 *     every subsequent request, plus the negotiated `protocolVersion`.
 *   - JSON-RPC 2.0 framing; responses are parsed from either a JSON body or an
 *     SSE `data:` frame.
 *
 * Usage:
 *   const client = new HttpMcpClient('https://open.bigmodel.cn/api/mcp/web_search_prime/mcp', apiKey)
 *   registerMcpClient('web-search-prime', client)
 */

import type { McpClient } from './registry.js'

type JsonRpcResponse<T = unknown> = {
  jsonrpc: '2.0'
  id?: number
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

const DEFAULT_PROTOCOL_VERSION = '2025-03-26'

export class HttpMcpClient implements McpClient {
  private readonly _url: string
  private readonly _baseHeaders: Record<string, string>
  private _idCounter = 1
  private _sessionId: string | undefined
  private _protocolVersion = DEFAULT_PROTOCOL_VERSION
  /** Single-flight handshake — runs once, retried on the next call if it fails. */
  private _initPromise: Promise<void> | undefined

  /**
   * @param url        MCP server endpoint
   * @param apiKey     Convenience shorthand — sets Authorization: Bearer <key>.
   *                   Pass an empty string when supplying headers directly.
   * @param extraHeaders  Merged last, so they override the Authorization header
   *                      when apiKey is empty and Authorization is provided here.
   */
  constructor(url: string, apiKey: string, extraHeaders?: Record<string, string>) {
    this._url = url
    this._baseHeaders = {
      'Content-Type': 'application/json',
      // Streamable HTTP servers commonly respond with an SSE stream. We must
      // advertise text/event-stream or the server returns 406 Not Acceptable.
      'Accept': 'application/json, text/event-stream',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...extraHeaders,
    }
  }

  // ── Request helpers ─────────────────────────────────────────────────────────

  /** Headers for post-handshake requests: base + session id + protocol version. */
  private _requestHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...this._baseHeaders }
    if (this._sessionId) h['Mcp-Session-Id'] = this._sessionId
    if (this._protocolVersion) h['MCP-Protocol-Version'] = this._protocolVersion
    return h
  }

  /**
   * Parse a JSON-RPC response from either a JSON body or an SSE event stream.
   * SSE framing looks like:
   *   id:1
   *   event:message
   *   data:{"jsonrpc":"2.0","id":1,"result":{...}}
   */
  private async _parse<T>(res: Response): Promise<JsonRpcResponse<T>> {
    const contentType = res.headers.get('content-type') ?? ''
    const text = await res.text()

    if (contentType.includes('text/event-stream')) {
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const obj = JSON.parse(payload) as JsonRpcResponse<T>
          if (obj && obj.jsonrpc) return obj
        } catch {
          /* not a complete JSON frame — keep scanning */
        }
      }
      throw new Error('No JSON-RPC data frame found in SSE response')
    }

    return JSON.parse(text) as JsonRpcResponse<T>
  }

  /** Run the one-time MCP initialize handshake. */
  private async _initialize(): Promise<void> {
    const initRes = await fetch(this._url, {
      method: 'POST',
      headers: { ...this._baseHeaders },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this._idCounter++,
        method: 'initialize',
        params: {
          protocolVersion: this._protocolVersion,
          capabilities: {},
          clientInfo: { name: 'meta-agent', version: '0.2.1' },
        },
      }),
    })
    if (!initRes.ok) {
      throw new Error(`HTTP ${initRes.status} ${initRes.statusText} during MCP initialize`)
    }

    // Capture the server-assigned session id (required on subsequent requests).
    const sid = initRes.headers.get('mcp-session-id') ?? initRes.headers.get('Mcp-Session-Id')
    if (sid) this._sessionId = sid

    const json = await this._parse<{ protocolVersion?: string }>(initRes)
    if (json.error) {
      throw new Error(`MCP initialize error ${json.error.code}: ${json.error.message}`)
    }
    const negotiated = json.result?.protocolVersion
    if (negotiated) this._protocolVersion = negotiated

    // Notify the server that initialization is complete (a notification — no id,
    // no response expected). Best-effort: some servers don't require it.
    await fetch(this._url, {
      method: 'POST',
      headers: this._requestHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }).catch(() => undefined)
  }

  private async _ensureInitialized(): Promise<void> {
    if (!this._initPromise) {
      this._initPromise = this._initialize().catch((err) => {
        // Allow a later call to retry the handshake.
        this._initPromise = undefined
        throw err
      })
    }
    return this._initPromise
  }

  private async _rpc<T>(method: string, params?: unknown, _isRetry = false): Promise<T> {
    await this._ensureInitialized()

    const res = await fetch(this._url, {
      method: 'POST',
      headers: this._requestHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this._idCounter++,
        method,
        ...(params !== undefined ? { params } : {}),
      }),
    })

    if (!res.ok) {
      // A 404 typically means the session expired/was evicted — re-handshake once.
      if ((res.status === 404 || res.status === 400) && !_isRetry) {
        this._sessionId = undefined
        this._initPromise = undefined
        return this._rpc<T>(method, params, true)
      }
      throw new Error(`HTTP ${res.status} ${res.statusText} from MCP server`)
    }

    const json = await this._parse<T>(res)
    if (json.error) {
      throw new Error(`MCP error ${json.error.code}: ${json.error.message}`)
    }
    return json.result as T
  }

  // ── McpClient interface ───────────────────────────────────────────────────

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    try {
      const result = await this._rpc<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>('tools/list')
      return result?.tools ?? []
    } catch (err) {
      // Surface the real reason instead of silently reporting "(none)".
      const msg = err instanceof Error ? err.message : String(err)
      try { process.stderr.write(`[mcp] listTools failed for ${this._url}: ${msg}\n`) } catch { /* ignore */ }
      return []
    }
  }

  async callTool(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text?: string }> }> {
    const result = await this._rpc<{ content: Array<{ type: string; text?: string }> }>(
      'tools/call',
      { name: toolName, arguments: toolInput },
    )
    return result ?? { content: [] }
  }
}
