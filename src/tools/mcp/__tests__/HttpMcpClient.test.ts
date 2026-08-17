/**
 * HttpMcpClient — Streamable HTTP MCP transport.
 *
 * 3.6% line coverage before this file, on the path every remote MCP tool call
 * takes. Each of the behaviours below has a specific failure mode that only
 * shows up against a live server, which is precisely why they should be pinned
 * against a local one instead:
 *
 *   - SSE framing: Zhipu's web_search_prime answers `text/event-stream`, not
 *     JSON. Parse it wrong and every search silently fails.
 *   - `Mcp-Session-Id`: the server assigns it during initialize and REQUIRES it
 *     on every later request. Drop it and the second call 404s.
 *   - single-flight handshake: without it, N concurrent tool calls each run
 *     their own initialize and the server sees N sessions.
 *   - 404 re-handshake: sessions get evicted; the client must recover once
 *     rather than failing the tool call.
 *   - body cap: a server streaming without end must not exhaust memory.
 *
 * These run against a real `node:http` server on a loopback port — no mocks, so
 * the headers and framing under test are the ones that actually go on the wire.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { HttpMcpClient } from '../HttpMcpClient.js'
import { invalidateToolListCache } from '../registry.js'

interface Recorded { method: string; headers: IncomingMessage['headers']; body: unknown }

let server: Server
let url: string
let recorded: Recorded[]
/** Replaced per-test to shape the response. */
let handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void

beforeEach(async () => {
  recorded = []
  // tools/list is memoised per server URL. The loopback port is reused across
  // tests often enough that a stale entry would leak between them.
  invalidateToolListCache()
  handler = (_req, res, body) => jsonRpc(res, body['id'] as number, { ok: true })
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> } catch { /* notification */ }
      recorded.push({ method: String(body['method'] ?? ''), headers: req.headers, body })
      handler(req, res, body)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
})

afterEach(async () => {
  await new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) })
})

// ── Response helpers ──────────────────────────────────────────────────────────

function jsonRpc(res: ServerResponse, id: number, result: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(200, { 'content-type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

function sse(res: ServerResponse, id: number, result: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', ...extraHeaders })
  res.end(`id:${id}\nevent:message\ndata:${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`)
}

/** Default: initialize succeeds, then `then` handles the real call. */
function afterHandshake(
  then: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void,
  initHeaders: Record<string, string> = {},
): typeof handler {
  return (req, res, body) => {
    if (body['method'] === 'initialize') return jsonRpc(res, body['id'] as number, { protocolVersion: '2025-03-26' }, initHeaders)
    if (body['method'] === 'notifications/initialized') { res.writeHead(202).end(); return }
    then(req, res, body)
  }
}

// ── Handshake ─────────────────────────────────────────────────────────────────

describe('initialize handshake', () => {
  it('runs initialize before the first RPC and advertises both accept types', async () => {
    handler = afterHandshake((_r, res, body) => jsonRpc(res, body['id'] as number, { tools: [] }))
    await new HttpMcpClient(url, 'k').listTools()

    expect(recorded[0]!.method).toBe('initialize')
    // Advertising only application/json makes SSE servers answer 406.
    expect(String(recorded[0]!.headers['accept'])).toContain('text/event-stream')
    expect(String(recorded[0]!.headers['accept'])).toContain('application/json')
    expect(String(recorded[0]!.headers['authorization'])).toBe('Bearer k')
  })

  it('sends notifications/initialized after a successful handshake', async () => {
    handler = afterHandshake((_r, res, body) => jsonRpc(res, body['id'] as number, { tools: [] }))
    await new HttpMcpClient(url, 'k').listTools()
    expect(recorded.map(r => r.method)).toContain('notifications/initialized')
  })

  it('echoes the server-assigned Mcp-Session-Id on every later request', async () => {
    handler = afterHandshake(
      (_r, res, body) => jsonRpc(res, body['id'] as number, { tools: [] }),
      { 'mcp-session-id': 'sess-42' },
    )
    const client = new HttpMcpClient(url, 'k')
    await client.listTools()
    // A second listTools() is served from the tool-list cache (mcp_call needs a
    // tool's _meta before every invocation, so an uncached lookup meant a second
    // HTTP round-trip per tool call). Invalidate to force a real request and
    // assert the session header is echoed on BOTH.
    invalidateToolListCache()
    await client.listTools()
    const calls = recorded.filter(r => r.method === 'tools/list')
    expect(calls).toHaveLength(2)
    for (const c of calls) expect(c.headers['mcp-session-id']).toBe('sess-42')
  })

  it('caches tools/list so repeat lookups do not re-hit the server', () => {
    return (async () => {
      handler = afterHandshake((_r, res, body) => jsonRpc(res, body['id'] as number, { tools: [{ name: 't' }] }))
      const client = new HttpMcpClient(url, 'k')
      await client.listTools()
      await client.listTools()
      await client.listTools()
      expect(recorded.filter(r => r.method === 'tools/list')).toHaveLength(1)
    })()
  })

  it('adopts the protocol version the server negotiated', async () => {
    handler = (req, res, body) => {
      if (body['method'] === 'initialize') return jsonRpc(res, body['id'] as number, { protocolVersion: '2099-01-01' })
      if (body['method'] === 'notifications/initialized') { res.writeHead(202).end(); return }
      jsonRpc(res, body['id'] as number, { tools: [] })
    }
    await new HttpMcpClient(url, 'k').listTools()
    expect(recorded.find(r => r.method === 'tools/list')!.headers['mcp-protocol-version']).toBe('2099-01-01')
  })

  it('handshakes only ONCE across concurrent calls', async () => {
    handler = afterHandshake((_r, res, body) => jsonRpc(res, body['id'] as number, { tools: [] }))
    const client = new HttpMcpClient(url, 'k')
    await Promise.all([client.listTools(), client.listTools(), client.listTools()])
    expect(recorded.filter(r => r.method === 'initialize')).toHaveLength(1)
  })

  it('retries the handshake on a later call after it failed', async () => {
    let initCalls = 0
    handler = (_req, res, body) => {
      if (body['method'] === 'initialize') {
        initCalls++
        if (initCalls === 1) { res.writeHead(500).end('boom'); return }
        return jsonRpc(res, body['id'] as number, { protocolVersion: '2025-03-26' })
      }
      if (body['method'] === 'notifications/initialized') { res.writeHead(202).end(); return }
      jsonRpc(res, body['id'] as number, { tools: [{ name: 't' }] })
    }
    const client = new HttpMcpClient(url, 'k')
    // A cached rejected promise would wedge the client permanently.
    expect(await client.listTools()).toEqual([])           // listTools swallows
    expect(await client.listTools()).toEqual([{ name: 't' }])
    expect(initCalls).toBe(2)
  })
})

// ── SSE framing ───────────────────────────────────────────────────────────────

describe('SSE response parsing', () => {
  it('extracts the JSON-RPC frame from a text/event-stream body', async () => {
    handler = afterHandshake((_r, res, body) => sse(res, body['id'] as number, { tools: [{ name: 'webSearchPrime' }] }))
    expect(await new HttpMcpClient(url, 'k').listTools()).toEqual([{ name: 'webSearchPrime' }])
  })

  it('skips comment and non-data lines before the payload', async () => {
    handler = afterHandshake((_r, res, body) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `: keepalive\nevent:ping\ndata:\n\n` +
        `id:${body['id']}\nevent:message\ndata:${JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: { tools: [{ name: 'x' }] } })}\n\n`,
      )
    })
    expect(await new HttpMcpClient(url, 'k').listTools()).toEqual([{ name: 'x' }])
  })

  it('ignores a [DONE] sentinel', async () => {
    handler = afterHandshake((_r, res, body) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data:${JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: { tools: [] } })}\n\ndata:[DONE]\n\n`,
      )
    })
    expect(await new HttpMcpClient(url, 'k').listTools()).toEqual([])
  })

  it('reports an SSE body with no JSON-RPC frame', async () => {
    handler = afterHandshake((_r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('event:ping\ndata:not-json\n\n')
    })
    await expect(new HttpMcpClient(url, 'k').callTool('t', {}))
      .rejects.toThrow(/No JSON-RPC data frame/)
  })
})

// ── Errors and recovery ───────────────────────────────────────────────────────

describe('errors and session recovery', () => {
  it('surfaces a JSON-RPC error object as a thrown error with its code', async () => {
    handler = afterHandshake((_r, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body['id'], error: { code: -32601, message: 'Method not found' } }))
    })
    await expect(new HttpMcpClient(url, 'k').callTool('nope', {}))
      .rejects.toThrow(/-32601.*Method not found/)
  })

  it('re-handshakes ONCE on a 404 (evicted session) and then succeeds', async () => {
    let toolCalls = 0
    handler = afterHandshake((_r, res, body) => {
      toolCalls++
      if (toolCalls === 1) { res.writeHead(404).end(); return }
      jsonRpc(res, body['id'] as number, { content: [{ type: 'text', text: 'ok' }] })
    })
    const result = await new HttpMcpClient(url, 'k').callTool('t', {})
    expect(result.content[0]!.text).toBe('ok')
    expect(recorded.filter(r => r.method === 'initialize')).toHaveLength(2)
  })

  it('does not loop forever when the retry also fails', async () => {
    handler = afterHandshake((_r, res) => { res.writeHead(404).end() })
    await expect(new HttpMcpClient(url, 'k').callTool('t', {})).rejects.toThrow(/404/)
    // initial + exactly one re-handshake
    expect(recorded.filter(r => r.method === 'initialize')).toHaveLength(2)
  })

  it('surfaces a non-recoverable HTTP status directly', async () => {
    handler = afterHandshake((_r, res) => { res.writeHead(503).end() })
    await expect(new HttpMcpClient(url, 'k').callTool('t', {})).rejects.toThrow(/503/)
  })

  it('listTools returns [] rather than throwing, so one bad server cannot break prompt assembly', async () => {
    handler = afterHandshake((_r, res) => { res.writeHead(500).end() })
    expect(await new HttpMcpClient(url, 'k').listTools()).toEqual([])
  })
})

// ── Headers ───────────────────────────────────────────────────────────────────

describe('header composition', () => {
  it('extraHeaders override the apiKey-derived Authorization', async () => {
    handler = afterHandshake((_r, res, body) => jsonRpc(res, body['id'] as number, { tools: [] }))
    await new HttpMcpClient(url, 'shorthand', { Authorization: 'Bearer explicit' }).listTools()
    expect(recorded[0]!.headers['authorization']).toBe('Bearer explicit')
  })

  it('sends no Authorization header when apiKey is empty and none is supplied', async () => {
    handler = afterHandshake((_r, res, body) => jsonRpc(res, body['id'] as number, { tools: [] }))
    await new HttpMcpClient(url, '').listTools()
    expect(recorded[0]!.headers['authorization']).toBeUndefined()
  })

  it('passes custom headers through on every request', async () => {
    handler = afterHandshake((_r, res, body) => jsonRpc(res, body['id'] as number, { tools: [] }))
    await new HttpMcpClient(url, 'k', { 'X-Trace': 'on' }).listTools()
    for (const r of recorded) expect(r.headers['x-trace']).toBe('on')
  })
})

// ── Body cap ──────────────────────────────────────────────────────────────────

describe('response size cap', () => {
  it('aborts a response larger than META_AGENT_MCP_MAX_RESPONSE_BYTES', async () => {
    const previous = process.env['META_AGENT_MCP_MAX_RESPONSE_BYTES']
    process.env['META_AGENT_MCP_MAX_RESPONSE_BYTES'] = '2048'
    try {
      handler = afterHandshake((_r, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { pad: 'x'.repeat(200_000) } }))
      })
      await expect(new HttpMcpClient(url, 'k').callTool('t', {}))
        .rejects.toThrow(/exceeded 2048 bytes/)
    } finally {
      if (previous === undefined) delete process.env['META_AGENT_MCP_MAX_RESPONSE_BYTES']
      else process.env['META_AGENT_MCP_MAX_RESPONSE_BYTES'] = previous
    }
  })
})

// ── Payload shape ─────────────────────────────────────────────────────────────

describe('JSON-RPC payloads', () => {
  it('sends tools/call with name + arguments and monotonically increasing ids', async () => {
    handler = afterHandshake((_r, res, body) => jsonRpc(res, body['id'] as number, { content: [] }))
    const client = new HttpMcpClient(url, 'k')
    await client.callTool('search', { query: 'x' })
    await client.callTool('search', { query: 'y' })
    const calls = recorded.filter(r => r.method === 'tools/call')
    expect((calls[0]!.body as Record<string, Record<string, unknown>>)['params']).toEqual({
      name: 'search', arguments: { query: 'x' },
    })
    const ids = recorded.filter(r => (r.body as Record<string, unknown>)['id'] !== undefined)
      .map(r => (r.body as Record<string, number>)['id']!)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('tolerates a result with no content array', async () => {
    handler = afterHandshake((_r, res, body) => jsonRpc(res, body['id'] as number, {}))
    expect(await new HttpMcpClient(url, 'k').callTool('t', {})).toEqual({ content: [] })
  })

  it('lists paginated resources and reads an MCP App resource', async () => {
    handler = afterHandshake((_r, res, body) => {
      const params = body['params'] as Record<string, unknown> | undefined
      if (body['method'] === 'resources/list') {
        if (!params?.['cursor']) {
          jsonRpc(res, body['id'] as number, {
            resources: [{ uri: 'ui://one', mimeType: 'text/html;profile=mcp-app' }],
            nextCursor: 'page-2',
          })
        } else {
          jsonRpc(res, body['id'] as number, { resources: [{ uri: 'ui://two' }] })
        }
        return
      }
      if (body['method'] === 'resources/read') {
        jsonRpc(res, body['id'] as number, {
          contents: [{ uri: params?.['uri'], mimeType: 'text/html;profile=mcp-app', text: '<html />' }],
        })
      }
    })
    const client = new HttpMcpClient(url, 'k')
    expect(await client.listResources()).toHaveLength(2)
    expect(await client.readResource('ui://one')).toEqual({
      contents: [{ uri: 'ui://one', mimeType: 'text/html;profile=mcp-app', text: '<html />' }],
    })
    const resourceCalls = recorded.filter(r => r.method === 'resources/list')
    expect(resourceCalls).toHaveLength(2)
    expect((resourceCalls[1]!.body as Record<string, unknown>)['params']).toEqual({ cursor: 'page-2' })
  })
})
