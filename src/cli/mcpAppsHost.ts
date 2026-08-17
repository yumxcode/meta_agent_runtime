/**
 * Local browser sidecar for MCP Apps.
 *
 * The agent remains a terminal process. This host binds to loopback, renders
 * server-provided HTML in a sandboxed iframe, and brokers the MCP Apps
 * postMessage protocol back to the originating MCP connection.
 */
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  getMcpAppPresenter,
  isMcpToolVisibleTo,
  MCP_APP_HTML_MIME_TYPE,
  setMcpAppPresenter,
  type McpAppPresentation,
  type McpAppPresenter,
  type McpClient,
  type McpResourceContent,
  type McpToolDefinition,
  type McpToolResult,
} from '../tools/mcp/registry.js'
import { CLI_VERSION } from './version.js'

const MCP_APPS_PROTOCOL_VERSION = '2026-01-26'
const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_APP_HTML_BYTES = 5 * 1024 * 1024
const MAX_PRESENTATIONS = 20

interface StoredPresentation {
  id: string
  serverName: string
  toolName: string
  resourceUri: string
  toolInput: Record<string, unknown>
  toolResult: McpToolResult
  tool: McpToolDefinition
  client: McpClient
  resource: McpResourceContent
  html: string
  createdAt: string
}

interface PublicPresentation {
  id: string
  serverName: string
  toolName: string
  resourceUri: string
  toolInput: Record<string, unknown>
  toolResult: McpToolResult
  appPath: string
  createdAt: string
}

interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

export interface McpAppsBrowserHostOptions {
  port?: number
  openBrowser?: boolean
}

export interface McpAppsBrowserHostInfo {
  url: string
  port: number
  browserOpened: boolean
}

export class McpAppsBrowserHost implements McpAppPresenter {
  private readonly requestedPort: number
  private readonly shouldOpenBrowser: boolean
  private readonly token = randomBytes(24).toString('hex')
  private readonly presentations = new Map<string, StoredPresentation>()
  private readonly eventStreams = new Set<ServerResponse>()
  private server: Server | undefined
  private latestId: string | undefined
  private boundPort: number | undefined

  constructor(options: McpAppsBrowserHostOptions = {}) {
    this.requestedPort = options.port ?? 0
    this.shouldOpenBrowser = options.openBrowser ?? true
  }

  get url(): string | undefined {
    return this.boundPort === undefined
      ? undefined
      : `http://127.0.0.1:${this.boundPort}/#token=${this.token}`
  }

  async start(): Promise<McpAppsBrowserHostInfo> {
    if (this.server && this.boundPort !== undefined && this.url) {
      return { url: this.url, port: this.boundPort, browserOpened: false }
    }

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch(error => {
        // Log the detail locally; return a generic body. Echoing the exception
        // message put internal paths and implementation details into an HTTP
        // response served to server-provided app HTML.
        process.stderr.write(
          `[meta-agent/mcp-apps] request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
        )
        if (res.headersSent) {
          res.end()
          return
        }
        this.sendJson(res, 500, { error: 'internal error' })
      })
    })
    this.server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))

    await new Promise<void>((resolve, reject) => {
      const server = this.server!
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(this.requestedPort, '127.0.0.1', () => {
        server.off('error', onError)
        resolve()
      })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('MCP Apps host did not bind a TCP port')
    this.boundPort = address.port
    setMcpAppPresenter(this)

    const browserOpened = this.shouldOpenBrowser && this.url
      ? await openBrowser(this.url)
      : false
    return { url: this.url!, port: this.boundPort, browserOpened }
  }

  /**
   * Synchronous teardown — safe to call from a `process.on('exit')` handler,
   * where the event loop is already done and no promise will ever settle.
   *
   * `server.close()` alone is not enough here: it stops accepting NEW
   * connections but waits for existing ones to end, and this host's whole
   * purpose is to hold long-lived SSE streams open. Without
   * `closeAllConnections()` the listener survives until the process is killed.
   */
  closeSync(): void {
    if (getMcpAppPresenter() === this) setMcpAppPresenter(undefined)
    for (const stream of this.eventStreams) {
      try { stream.end() } catch { /* already torn down */ }
    }
    this.eventStreams.clear()
    const server = this.server
    this.server = undefined
    this.boundPort = undefined
    if (!server) return
    server.closeAllConnections?.()
    server.close()
    server.unref()
  }

  async close(): Promise<void> {
    const server = this.server
    this.closeSync()
    if (!server) return
    // closeSync already asked it to stop; this just waits for the 'close' event.
    await new Promise<void>(resolve => {
      if (!server.listening) { resolve(); return }
      server.close(() => resolve())
    })
  }

  async present(presentation: McpAppPresentation): Promise<void> {
    if (!this.server || this.boundPort === undefined) throw new Error('browser host is not running')
    if (!presentation.client.readResource) {
      throw new Error(`MCP server "${presentation.serverName}" does not implement resources/read`)
    }
    const resourceResult = await presentation.client.readResource(presentation.resourceUri)
    const resource = resourceResult.contents.find(item => item.uri === presentation.resourceUri)
      ?? resourceResult.contents[0]
    if (!resource) throw new Error(`UI resource "${presentation.resourceUri}" was empty`)
    if (resource.mimeType !== MCP_APP_HTML_MIME_TYPE && resource.mimeType !== 'text/html+skybridge') {
      throw new Error(
        `UI resource "${presentation.resourceUri}" has unsupported MIME type ` +
        `"${resource.mimeType ?? '(missing)'}"`,
      )
    }
    const html = resource.text ?? (resource.blob ? Buffer.from(resource.blob, 'base64').toString('utf8') : '')
    if (!html) throw new Error(`UI resource "${presentation.resourceUri}" contained no HTML`)
    if (Buffer.byteLength(html, 'utf8') > MAX_APP_HTML_BYTES) {
      throw new Error(`UI resource exceeds the ${MAX_APP_HTML_BYTES}-byte host limit`)
    }

    const id = randomBytes(16).toString('hex')
    const stored: StoredPresentation = {
      id,
      serverName: presentation.serverName,
      toolName: presentation.tool.name,
      resourceUri: presentation.resourceUri,
      toolInput: presentation.toolInput,
      toolResult: presentation.toolResult,
      tool: presentation.tool,
      client: presentation.client,
      resource,
      html,
      createdAt: new Date().toISOString(),
    }
    this.presentations.set(id, stored)
    this.latestId = id
    while (this.presentations.size > MAX_PRESENTATIONS) {
      const oldest = this.presentations.keys().next().value as string | undefined
      if (!oldest) break
      this.presentations.delete(oldest)
    }
    this.broadcast('presentation', this.toPublic(stored))
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const base = `http://127.0.0.1:${this.boundPort ?? this.requestedPort}`
    const url = new URL(req.url ?? '/', base)
    if (!this.validHost(req)) {
      this.sendJson(res, 403, { error: 'invalid Host header' })
      return
    }

    if (req.method === 'GET' && url.pathname === '/') {
      this.sendHtml(res, browserShell())
      return
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      this.sendJson(res, 200, { ok: true, protocolVersion: MCP_APPS_PROTOCOL_VERSION })
      return
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      if (!this.authorized(req, url)) return this.sendUnauthorized(res)
      this.openEventStream(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      if (!this.authorized(req, url)) return this.sendUnauthorized(res)
      const latest = this.latestId ? this.presentations.get(this.latestId) : undefined
      this.sendJson(res, 200, { presentation: latest ? this.toPublic(latest) : null })
      return
    }
    const appMatch = /^\/app\/([a-f0-9]{32})$/.exec(url.pathname)
    if (req.method === 'GET' && appMatch) {
      const presentation = this.presentations.get(appMatch[1]!)
      if (!presentation) return this.sendJson(res, 404, { error: 'app presentation not found' })
      this.sendAppHtml(res, presentation)
      return
    }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      if (!this.authorized(req, url)) return this.sendUnauthorized(res)
      const body = await readJsonBody(req)
      const presentationId = typeof body['presentationId'] === 'string' ? body['presentationId'] : ''
      const presentation = this.presentations.get(presentationId)
      if (!presentation) return this.sendJson(res, 404, { error: 'app presentation not found' })
      const message = body['message'] as JsonRpcMessage | undefined
      const response = await this.handleBridgeRpc(presentation, message)
      this.sendJson(res, 200, response)
      return
    }
    this.sendJson(res, 404, { error: 'not found' })
  }

  private validHost(req: IncomingMessage): boolean {
    if (this.boundPort === undefined) return false
    const host = req.headers.host?.toLowerCase()
    return host === `127.0.0.1:${this.boundPort}` || host === `localhost:${this.boundPort}`
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice('Bearer '.length)
      : undefined
    return (url.searchParams.get('token') ?? bearer) === this.token
  }

  private sendUnauthorized(res: ServerResponse): void {
    this.sendJson(res, 401, { error: 'missing or invalid browser-host token' })
  }

  private openEventStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    })
    res.write(': connected\n\n')
    this.eventStreams.add(res)
    const latest = this.latestId ? this.presentations.get(this.latestId) : undefined
    if (latest) this.writeEvent(res, 'presentation', this.toPublic(latest))
    req.once('close', () => this.eventStreams.delete(res))
  }

  private broadcast(event: string, data: unknown): void {
    for (const stream of [...this.eventStreams]) {
      try {
        this.writeEvent(stream, event, data)
      } catch {
        this.eventStreams.delete(stream)
      }
    }
  }

  private writeEvent(res: ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  private toPublic(presentation: StoredPresentation): PublicPresentation {
    return {
      id: presentation.id,
      serverName: presentation.serverName,
      toolName: presentation.toolName,
      resourceUri: presentation.resourceUri,
      toolInput: presentation.toolInput,
      toolResult: presentation.toolResult,
      appPath: `/app/${presentation.id}`,
      createdAt: presentation.createdAt,
    }
  }

  private async handleBridgeRpc(
    presentation: StoredPresentation,
    message: JsonRpcMessage | undefined,
  ): Promise<Record<string, unknown>> {
    const id = message?.id ?? null
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(id, -32600, 'Invalid JSON-RPC request')
    }
    const params = isRecord(message.params) ? message.params : {}
    try {
      if (message.method === 'tools/call') {
        if (message.id === undefined) return rpcError(null, -32600, 'tools/call must be a JSON-RPC request')
        const name = typeof params['name'] === 'string' ? params['name'] : ''
        const args = isRecord(params['arguments']) ? params['arguments'] : {}
        const tool = (await presentation.client.listTools()).find(candidate => candidate.name === name)
        if (!tool) return rpcError(id, -32602, `Unknown MCP tool "${name}"`)
        if (!isMcpToolVisibleTo(tool, 'app')) {
          return rpcError(id, -32603, `MCP tool "${name}" is not visible to apps`)
        }
        const result = await presentation.client.callTool(name, args)
        return rpcResult(id, result)
      }
      if (message.method === 'resources/read') {
        if (message.id === undefined) return rpcError(null, -32600, 'resources/read must be a JSON-RPC request')
        if (!presentation.client.readResource) return rpcError(id, -32601, 'resources/read is unavailable')
        const uri = typeof params['uri'] === 'string' ? params['uri'] : ''
        if (!uri) return rpcError(id, -32602, 'resources/read requires a URI')
        // Constrain reads to what the server actually advertises, plus the app's
        // own UI resource. `tools/call` on this bridge has always been checked
        // against tool visibility; `resources/read` was not checked at all, so
        // the two halves of the same bridge disagreed about whether the app was
        // trusted. It is not — it is server-supplied HTML.
        if (!(await this.isReadableResource(presentation, uri))) {
          return rpcError(id, -32602, `Resource "${uri}" is not advertised by this MCP server`)
        }
        return rpcResult(id, await presentation.client.readResource(uri))
      }
      if (message.method === 'notifications/message') {
        const level = safeLogText(params['level'] ?? 'info', 16)
        const data = safeLogText(params['data'] ?? '', 2_000)
        process.stderr.write(`[mcp-app:${presentation.serverName}:${level}] ${data}\n`)
        return rpcResult(id, {})
      }
      return rpcError(id, -32601, `Unsupported bridge method "${message.method}"`)
    } catch (error) {
      return rpcError(id, -32000, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * May this app read `uri`?
   *
   * Yes for its own UI resource, and for anything the server lists via
   * resources/list. A server that implements no resources/list (the method is
   * optional) gets the permissive answer, because refusing would break every
   * such server — but the app is still confined to ONE server's resource space:
   * `presentation.client` is the connection the tool call came from, so it can
   * never reach a different MCP server's data.
   */
  private async isReadableResource(
    presentation: StoredPresentation,
    uri: string,
  ): Promise<boolean> {
    if (uri === presentation.resourceUri) return true
    if (!presentation.client.listResources) return true
    try {
      const advertised = await presentation.client.listResources()
      if (advertised.length === 0) return true
      return advertised.some(resource => resource.uri === uri)
    } catch {
      // The listing failed — do not turn a transient server error into a hard
      // denial of a legitimate read.
      return true
    }
  }

  private sendHtml(res: ServerResponse, html: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    })
    res.end(html)
  }

  private sendAppHtml(res: ServerResponse, presentation: StoredPresentation): void {
    res.writeHead(200, {
      'Content-Type': `${presentation.resource.mimeType}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': appCsp(presentation.resource),
      'Referrer-Policy': 'no-referrer',
    })
    res.end(presentation.html)
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(JSON.stringify(body))
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_REQUEST_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!isRecord(parsed)) throw new Error('request body must be a JSON object')
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function safeLogText(value: unknown, max: number): string {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, max)
}

/** Hard ceiling on how many origins a server may inject into one directive. */
const MAX_CSP_ORIGINS_PER_DIRECTIVE = 20

/**
 * Validate one server-declared CSP origin.
 *
 * The MCP Apps spec lets a server widen its own app's CSP, so this can never
 * contain the server itself — but it should not hand the server a wildcard by
 * accident either. The previous test was `/^(https:|wss:|data:)/`, which the
 * bare string `"https:"` passes: a server could put `"https:"` in
 * `connectDomains` and get `connect-src https:`, i.e. every HTTPS origin on the
 * internet, from a rule that looked like an allowlist.
 *
 * So: a full origin is required (`https://host[:port]`, `wss://host[:port]`).
 * Bare schemes, paths, wildcards, and anything with CSP delimiters in it are
 * rejected. `data:` is accepted ONLY where it is inert (images, fonts, media) —
 * never in script-src, where it is a code-execution primitive.
 */
function isValidCspOrigin(value: string, allowData: boolean): boolean {
  if (typeof value !== 'string' || value.length > 255) return false
  if (/[\s;,'"]/.test(value)) return false
  if (value === 'data:') return allowData
  const match = /^(https|wss):\/\/([a-z0-9.-]+)(:\d{1,5})?$/i.exec(value)
  if (!match) return false
  const host = match[2]!
  // Reject the wildcard forms a naive allowlist would let through, and any host
  // that is not a plausible DNS name.
  if (host.includes('*') || host.startsWith('.') || host.endsWith('.')) return false
  return host.includes('.') || host === 'localhost'
}

function cspOrigins(
  resource: McpResourceContent,
  key: string,
  opts: { allowData?: boolean } = {},
): string[] {
  const ui = isRecord(resource._meta?.['ui']) ? resource._meta!['ui'] : undefined
  const csp = isRecord(ui?.['csp']) ? ui!['csp'] : undefined
  const values = csp?.[key]
  if (!Array.isArray(values)) return []
  return values
    .filter((value): value is string => isValidCspOrigin(value as string, opts.allowData === true))
    .slice(0, MAX_CSP_ORIGINS_PER_DIRECTIVE)
}

function appCsp(resource: McpResourceContent): string {
  const connect = cspOrigins(resource, 'connectDomains')
  // Script and style sources may NOT include `data:` — a data: URL in script-src
  // is arbitrary code execution with none of the origin restrictions the rest of
  // this policy is trying to impose.
  const scriptAssets = cspOrigins(resource, 'resourceDomains')
  // Passive assets may use data:, which is how apps inline small icons.
  const passiveAssets = cspOrigins(resource, 'resourceDomains', { allowData: true })
  const frames = cspOrigins(resource, 'frameDomains')
  const bases = cspOrigins(resource, 'baseUriDomains')
  const join = (prefix: string, list: string[]): string =>
    list.length ? `${prefix} ${list.join(' ')}` : prefix
  return [
    "default-src 'none'",
    join("script-src 'unsafe-inline'", scriptAssets),
    join("style-src 'unsafe-inline'", passiveAssets),
    join('img-src data: blob:', passiveAssets),
    `font-src ${passiveAssets.length ? passiveAssets.join(' ') : "'none'"}`,
    join('media-src data: blob:', passiveAssets),
    `connect-src ${connect.length ? connect.join(' ') : "'none'"}`,
    `frame-src ${frames.length ? frames.join(' ') : "'none'"}`,
    `base-uri ${bases.length ? bases.join(' ') : "'none'"}`,
    "object-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ')
}

async function openBrowser(url: string): Promise<boolean> {
  const command = process.platform === 'darwin'
    ? { file: 'open', args: [url] }
    : process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '', url] }
      : { file: 'xdg-open', args: [url] }
  return new Promise<boolean>(resolve => {
    try {
      const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore' })
      let settled = false
      child.once('error', () => {
        if (!settled) resolve(false)
        settled = true
      })
      child.once('spawn', () => {
        child.unref()
        if (!settled) resolve(true)
        settled = true
      })
    } catch {
      resolve(false)
    }
  })
}

function browserShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Meta-Agent MCP Apps</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#f4f5f7; color:#16181d; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; }
    header { position:sticky; top:0; z-index:2; display:flex; align-items:center; justify-content:space-between; padding:14px 20px; background:#111318; color:#fff; }
    header strong { letter-spacing:.01em; }
    #status { font-size:12px; color:#aab1bd; }
    main { max-width:1100px; margin:0 auto; padding:24px; }
    #empty { margin:18vh auto 0; max-width:540px; text-align:center; color:#667085; }
    #card { display:none; background:#fff; border:1px solid #dfe3e8; border-radius:16px; overflow:hidden; box-shadow:0 12px 36px rgba(16,24,40,.08); }
    #meta { display:flex; gap:10px; align-items:center; padding:12px 16px; border-bottom:1px solid #e8eaee; font-size:13px; color:#596273; }
    #meta b { color:#1d2430; }
    #frame { display:block; width:100%; height:560px; border:0; background:#fff; }
    #card.fullscreen { position:fixed; inset:0; z-index:10; border:0; border-radius:0; }
    #card.fullscreen #frame { height:calc(100vh - 46px)!important; }
    button { margin-left:auto; border:1px solid #ccd2db; border-radius:8px; background:#fff; padding:6px 10px; cursor:pointer; }
  </style>
</head>
<body>
  <header><strong>Meta-Agent · MCP Apps</strong><span id="status">connecting…</span></header>
  <main>
    <section id="empty"><h2>Waiting for an MCP App</h2><p>Keep using Meta-Agent in the terminal. Interactive tool results will appear here.</p></section>
    <section id="card">
      <div id="meta"><b id="tool"></b><span id="server"></span><span id="uri"></span><button id="close">Close</button></div>
      <iframe id="frame" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"></iframe>
    </section>
  </main>
<script>
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!token) { document.querySelector('#status').textContent = 'missing access token'; return; }
  const status = document.querySelector('#status');
  const empty = document.querySelector('#empty');
  const card = document.querySelector('#card');
  const frame = document.querySelector('#frame');
  let current = null;
  let initialized = false;
  let appCapabilities = {};

  const send = message => frame.contentWindow?.postMessage(message, '*');
  const response = (id, result, error) => send(error
    ? { jsonrpc:'2.0', id, error }
    : { jsonrpc:'2.0', id, result });
  const notifyInitialData = () => {
    if (!initialized || !current) return;
    send({ jsonrpc:'2.0', method:'ui/notifications/tool-input', params:{ arguments: current.toolInput || {} } });
    send({ jsonrpc:'2.0', method:'ui/notifications/tool-result', params: current.toolResult || { content:[] } });
  };
  const mount = presentation => {
    if (!presentation || presentation.id === current?.id) return;
    if (current && initialized) send({ jsonrpc:'2.0', id:'teardown-' + Date.now(), method:'ui/resource-teardown', params:{ reason:'replaced' } });
    current = presentation;
    initialized = false;
    appCapabilities = {};
    document.querySelector('#tool').textContent = presentation.toolName;
    document.querySelector('#server').textContent = presentation.serverName;
    document.querySelector('#uri').textContent = presentation.resourceUri;
    empty.style.display = 'none'; card.style.display = 'block';
    frame.style.height = '560px';
    frame.src = presentation.appPath;
  };
  const bridge = async message => {
    const result = await fetch('/rpc?token=' + encodeURIComponent(token), {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ presentationId:current.id, message })
    });
    if (!result.ok) throw new Error('bridge HTTP ' + result.status);
    return result.json();
  };

  window.addEventListener('message', async event => {
    if (!current || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
    const id = message.id;
    try {
      if (message.method === 'ui/initialize') {
        appCapabilities = message.params?.appCapabilities || {};
        response(id, {
          protocolVersion:'${MCP_APPS_PROTOCOL_VERSION}',
          hostInfo:{ name:'meta-agent-cli', version:'${CLI_VERSION}' },
          hostCapabilities:{ serverTools:{}, serverResources:{}, openLinks:{}, logging:{}, sandbox:{ permissions:{} } },
          hostContext:{
            theme:'light', locale:navigator.language || 'en', timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
            displayMode:'inline', availableDisplayModes:['inline','fullscreen'], platform:'web',
            containerDimensions:{ width:frame.clientWidth, height:frame.clientHeight }
          }
        });
        return;
      }
      if (message.method === 'ui/notifications/initialized') {
        initialized = true; notifyInitialData(); return;
      }
      if (message.method === 'ping') { response(id, {}); return; }
      if (message.method === 'ui/notifications/size-changed') {
        const height = Number(message.params?.height);
        if (Number.isFinite(height)) frame.style.height = Math.max(160, Math.min(1600, height)) + 'px';
        return;
      }
      if (message.method === 'ui/request-display-mode') {
        const requested = message.params?.mode;
        const declared = appCapabilities.availableDisplayModes;
        const allowed = requested === 'fullscreen' && (!Array.isArray(declared) || declared.includes('fullscreen'));
        card.classList.toggle('fullscreen', allowed);
        response(id, { mode:allowed ? 'fullscreen' : 'inline' });
        return;
      }
      if (message.method === 'ui/open-link') {
        const url = String(message.params?.url || '');
        if (!/^https?:\/\//i.test(url)) throw new Error('Only HTTP(S) links are allowed');
        if (!confirm('Open this external link?\n\n' + url)) throw new Error('Link opening denied');
        window.open(url, '_blank', 'noopener,noreferrer'); response(id, {}); return;
      }
      if (message.method === 'tools/call') {
        const name = String(message.params?.name || '');
        if (!confirm('Allow MCP App to call tool?\n\n' + current.serverName + ' / ' + name)) throw new Error('Tool call denied');
        send({ jsonrpc:'2.0', method:'ui/notifications/tool-input', params:{ arguments:message.params?.arguments || {} } });
        const rpc = await bridge(message);
        if (rpc.error) response(id, null, rpc.error);
        else {
          response(id, rpc.result);
          send({ jsonrpc:'2.0', method:'ui/notifications/tool-result', params:rpc.result });
        }
        return;
      }
      if (message.method === 'resources/read' || message.method === 'notifications/message') {
        const rpc = await bridge(message);
        if (id !== undefined) response(id, rpc.result, rpc.error);
        return;
      }
      response(id, null, { code:-32601, message:'Unsupported host method: ' + message.method });
    } catch (error) {
      response(id, null, { code:-32000, message:error instanceof Error ? error.message : String(error) });
    }
  });

  document.querySelector('#close').onclick = () => {
    if (current && initialized) send({ jsonrpc:'2.0', id:'teardown-' + Date.now(), method:'ui/resource-teardown', params:{ reason:'user closed' } });
    current = null; initialized = false; frame.src = 'about:blank'; card.style.display = 'none'; empty.style.display = 'block';
  };
  const events = new EventSource('/events?token=' + encodeURIComponent(token));
  events.onopen = () => { status.textContent = 'connected'; };
  events.onerror = () => { status.textContent = 'reconnecting…'; };
  events.addEventListener('presentation', event => mount(JSON.parse(event.data)));
  fetch('/state?token=' + encodeURIComponent(token)).then(r => r.json()).then(state => mount(state.presentation)).catch(() => {});
})();
</script>
</body>
</html>`
}
