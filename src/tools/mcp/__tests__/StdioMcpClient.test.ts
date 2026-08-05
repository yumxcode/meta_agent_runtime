import { describe, expect, it } from 'vitest'
import { StdioMcpClient } from '../mcpConfigFile.js'

/**
 * The fake servers below echo the request `id`, which the previous
 * spawn-per-RPC client never needed (it just took the last parseable line of a
 * fresh process's stdout). The persistent client routes responses by id, so the
 * fixtures now behave like a conforming MCP stdio server: read newline-delimited
 * JSON-RPC from stdin, reply with the matching id.
 */
const ECHO_SERVER = `
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const req = JSON.parse(line)
    if (req.id === undefined) continue          // notification
    if (req.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05' } }) + '\\n')
      continue
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { content: [{ type: 'text', text: 'ok' }] },
    }) + '\\n')
  }
})
process.stdin.resume()
`

describe('StdioMcpClient resource bounds', () => {
  it('times out and kills a server that never responds', async () => {
    const client = new StdioMcpClient({
      type: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'],
      timeoutMs: 50,
    })

    const started = Date.now()
    await expect(client.callTool('hang', {})).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(1_000)
    client.close()
  })

  it('rejects and kills a server whose stdout exceeds the response cap', async () => {
    const client = new StdioMcpClient({
      type: 'stdio',
      command: process.execPath,
      args: ['-e', "process.stdin.on('data', () => process.stdout.write('x'.repeat(4096))); process.stdin.resume()"],
      timeoutMs: 2_000,
      maxResponseBytes: 512,
    })

    await expect(client.callTool('large', {})).rejects.toThrow(/exceeded 512 bytes/)
    client.close()
  })

  it('parses a bounded JSON-RPC response normally', async () => {
    const client = new StdioMcpClient({
      type: 'stdio',
      command: process.execPath,
      args: ['-e', ECHO_SERVER],
      timeoutMs: 5_000,
    })

    await expect(client.callTool('ok', {})).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
    })
    client.close()
  })
})

describe('StdioMcpClient persistent process', () => {
  it('reuses ONE server process across calls instead of respawning per RPC', async () => {
    // The server reports its own pid in the response text. A spawn-per-RPC
    // client returns a different pid every call; a persistent one returns the
    // same pid — which is the whole point of the fix (stateful servers were
    // reset between every tool call).
    const PID_SERVER = `
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const req = JSON.parse(line)
    if (req.id === undefined) continue
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { content: [{ type: 'text', text: String(process.pid) }] },
    }) + '\\n')
  }
})
process.stdin.resume()
`
    const client = new StdioMcpClient({
      type: 'stdio',
      command: process.execPath,
      args: ['-e', PID_SERVER],
      timeoutMs: 5_000,
    })

    const a = await client.callTool('who', {})
    const b = await client.callTool('who', {})
    const c = await client.callTool('who', {})

    expect(a.content[0]?.text).toBeTruthy()
    expect(b.content[0]?.text).toBe(a.content[0]?.text)
    expect(c.content[0]?.text).toBe(a.content[0]?.text)
    client.close()
  })

  it('preserves server-side state across calls', async () => {
    // A counter that only increments if the process survives between calls.
    const COUNTER_SERVER = `
let n = 0
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const req = JSON.parse(line)
    if (req.id === undefined) continue
    if (req.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n')
      continue
    }
    n++
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { content: [{ type: 'text', text: String(n) }] },
    }) + '\\n')
  }
})
process.stdin.resume()
`
    const client = new StdioMcpClient({
      type: 'stdio',
      command: process.execPath,
      args: ['-e', COUNTER_SERVER],
      timeoutMs: 5_000,
    })

    expect((await client.callTool('inc', {})).content[0]?.text).toBe('1')
    expect((await client.callTool('inc', {})).content[0]?.text).toBe('2')
    expect((await client.callTool('inc', {})).content[0]?.text).toBe('3')
    client.close()
  })

  it('routes concurrent in-flight requests by id', async () => {
    // Replies out of order (odd ids delayed) — a client that assumed
    // request/response lockstep would mismatch them.
    const REORDER_SERVER = `
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const req = JSON.parse(line)
    if (req.id === undefined) continue
    const reply = () => process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { content: [{ type: 'text', text: (req.params && req.params.arguments && req.params.arguments.tag) || 'init' }] },
    }) + '\\n')
    if (req.id % 2 === 1) setTimeout(reply, 60)
    else reply()
  }
})
process.stdin.resume()
`
    const client = new StdioMcpClient({
      type: 'stdio',
      command: process.execPath,
      args: ['-e', REORDER_SERVER],
      timeoutMs: 5_000,
    })

    const [a, b, c, d] = await Promise.all([
      client.callTool('t', { tag: 'a' }),
      client.callTool('t', { tag: 'b' }),
      client.callTool('t', { tag: 'c' }),
      client.callTool('t', { tag: 'd' }),
    ])
    expect(a.content[0]?.text).toBe('a')
    expect(b.content[0]?.text).toBe('b')
    expect(c.content[0]?.text).toBe('c')
    expect(d.content[0]?.text).toBe('d')
    client.close()
  })

  it('respawns after the server process dies', async () => {
    const SUICIDE_SERVER = `
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const req = JSON.parse(line)
    if (req.id === undefined) continue
    if (req.method === 'tools/call') { process.exit(3) }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n')
  }
})
process.stdin.resume()
`
    const client = new StdioMcpClient({
      type: 'stdio',
      command: process.execPath,
      args: ['-e', SUICIDE_SERVER],
      timeoutMs: 3_000,
    }, 'suicide')

    // First call dies with the process; the failure is scoped to the call.
    await expect(client.callTool('boom', {})).rejects.toThrow(/exited with code|closed/)
    // A second call must be able to start a fresh process rather than hanging
    // forever against a dead one.
    await expect(client.callTool('boom', {})).rejects.toThrow(/exited with code|closed/)
    client.close()
  })
})

describe('StdioMcpClient credential hygiene', () => {
  it('does not forward provider API keys to the server process', async () => {
    const previous = process.env['ANTHROPIC_API_KEY']
    const previousGh = process.env['GITHUB_TOKEN']
    process.env['ANTHROPIC_API_KEY'] = 'sk-should-not-leak'
    process.env['GITHUB_TOKEN'] = 'ghp-git-remote-auth'
    try {
      const ENV_SERVER = `
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const req = JSON.parse(line)
    if (req.id === undefined) continue
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { content: [{ type: 'text', text: JSON.stringify({
        anthropic: process.env.ANTHROPIC_API_KEY ?? null,
        github:    process.env.GITHUB_TOKEN ?? null,
        declared:  process.env.MY_DECLARED_KEY ?? null,
      }) }] },
    }) + '\\n')
  }
})
process.stdin.resume()
`
      const client = new StdioMcpClient({
        type: 'stdio',
        command: process.execPath,
        args: ['-e', ENV_SERVER],
        env: { MY_DECLARED_KEY: 'explicitly-granted' },
        timeoutMs: 5_000,
      })

      const res = await client.callTool('env', {})
      const seen = JSON.parse(res.content[0]?.text ?? '{}')

      // Stripped: a model-provider key the server never asked for.
      expect(seen.anthropic).toBeNull()
      // Granted: only because mcp.json declared it.
      expect(seen.declared).toBe('explicitly-granted')
      // Allowlisted: git remote auth stays, matching the bash tool's policy.
      expect(seen.github).toBe('ghp-git-remote-auth')
      client.close()
    } finally {
      if (previous === undefined) delete process.env['ANTHROPIC_API_KEY']
      else process.env['ANTHROPIC_API_KEY'] = previous
      if (previousGh === undefined) delete process.env['GITHUB_TOKEN']
      else process.env['GITHUB_TOKEN'] = previousGh
    }
  })
})
