import { describe, expect, it } from 'vitest'
import { StdioMcpClient } from '../mcpConfigFile.js'

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
  })

  it('parses a bounded JSON-RPC response normally', async () => {
    const payload = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: 'ok' }] },
    })
    const client = new StdioMcpClient({
      type: 'stdio',
      command: process.execPath,
      args: ['-e', `process.stdin.on('data', () => console.log(${JSON.stringify(payload)}))`],
      timeoutMs: 2_000,
    })

    await expect(client.callTool('ok', {})).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
    })
  })
})
