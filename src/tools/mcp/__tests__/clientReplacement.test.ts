/**
 * Regression tests for P2-6 (review 2026-08-27): replacing a registered MCP
 * client must close the one it displaces and invalidate its cached tool list.
 *
 * The original defect had two halves that reinforced each other:
 *   - `registerMcpClient()` was a bare `Map.set`, so a displaced stdio client's
 *     child process kept running, holding its ports and file locks;
 *   - the tool-list cache was keyed by server name and never invalidated, so
 *     `mcp_call` resolved tools against the OLD server's definitions for up to
 *     the cache TTL after the swap.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  registerMcpClient,
  unregisterMcpClient,
  disposeMcpClients,
  cachedListTools,
  mcpClients,
} from '../registry.js'
import type { McpClient, McpToolDefinition } from '../registry.js'

const getMcpClient = (name: string): McpClient | undefined => mcpClients.get(name)

/** Minimal client that records whether it was closed. */
function makeClient(tag: string): McpClient & { closed: boolean; tag: string } {
  const client = {
    tag,
    closed: false,
    async listTools(): Promise<McpToolDefinition[]> {
      return [{ name: `${tag}_tool`, description: tag, inputSchema: { type: 'object' } }]
    },
    async callTool(): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
      return { content: [{ type: 'text', text: tag }] }
    },
    close(): void {
      client.closed = true
    },
  }
  return client as McpClient & { closed: boolean; tag: string }
}

const SERVER = 'replacement-test-server'

beforeEach(() => {
  disposeMcpClients()
})

afterEach(() => {
  disposeMcpClients()
})

describe('registerMcpClient replacement (P2-6)', () => {
  it('closes the client it displaces', () => {
    const first = makeClient('first')
    const second = makeClient('second')

    registerMcpClient(SERVER, first)
    expect(first.closed).toBe(false)

    registerMcpClient(SERVER, second)

    // With the bug, `first` stayed alive — for a stdio client that means an
    // orphaned child process for the rest of the session.
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(false)
    expect(getMcpClient(SERVER)).toBe(second)
  })

  it('invalidates the displaced client\'s cached tool list', async () => {
    const first = makeClient('first')
    const second = makeClient('second')

    registerMcpClient(SERVER, first)
    const before = await cachedListTools(SERVER, () => first.listTools())
    expect(before[0]?.name).toBe('first_tool')

    registerMcpClient(SERVER, second)

    // Within the TTL, the old entry would still be served — so a tool call
    // after a config reload could resolve against a server that is gone.
    const after = await cachedListTools(SERVER, () => second.listTools())
    expect(after[0]?.name).toBe('second_tool')
  })

  it('is a no-op when the same client instance is re-registered', () => {
    const only = makeClient('only')
    registerMcpClient(SERVER, only)
    registerMcpClient(SERVER, only)

    // Re-registering the same object must not close the live client.
    expect(only.closed).toBe(false)
    expect(getMcpClient(SERVER)).toBe(only)
  })

  it('closes and un-caches on explicit unregister', async () => {
    const client = makeClient('only')
    registerMcpClient(SERVER, client)
    await cachedListTools(SERVER, () => client.listTools())

    unregisterMcpClient(SERVER)

    expect(client.closed).toBe(true)
    expect(getMcpClient(SERVER)).toBeUndefined()

    const refetched = await cachedListTools(SERVER, async () => [
      { name: 'fresh_tool', description: 'fresh', inputSchema: { type: 'object' } },
    ])
    expect(refetched[0]?.name).toBe('fresh_tool')
  })

  it('closes every client and clears the cache on dispose', async () => {
    const a = makeClient('a')
    const b = makeClient('b')
    registerMcpClient('server-a', a)
    registerMcpClient('server-b', b)
    await cachedListTools('server-a', () => a.listTools())

    disposeMcpClients()

    expect(a.closed).toBe(true)
    expect(b.closed).toBe(true)

    const refetched = await cachedListTools('server-a', async () => [
      { name: 'after_dispose', description: 'x', inputSchema: { type: 'object' } },
    ])
    expect(refetched[0]?.name).toBe('after_dispose')
  })
})
