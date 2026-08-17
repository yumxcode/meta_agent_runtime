/**
 * Bounds on server-driven pagination.
 *
 * MCP servers are untrusted third-party processes. `do { … } while (cursor)`
 * with no bound means one that returns a constant `nextCursor` — malicious or
 * merely buggy — hangs the agent while the result array grows until OOM.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  collectPaginated,
  cachedListTools,
  invalidateToolListCache,
  isMcpToolVisibleTo,
  MCP_PAGINATION_MAX_PAGES,
  MCP_PAGINATION_MAX_ITEMS,
  type McpToolDefinition,
} from '../registry.js'

describe('collectPaginated', () => {
  it('collects every page of a well-behaved server', async () => {
    const pages = [
      { items: [1, 2], nextCursor: 'a' },
      { items: [3, 4], nextCursor: 'b' },
      { items: [5] },
    ]
    let i = 0
    const out = await collectPaginated<number>('srv', 'resources/list', async () => pages[i++]!)
    expect(out).toEqual([1, 2, 3, 4, 5])
  })

  it('stops when the server repeats a cursor instead of looping forever', async () => {
    let calls = 0
    const out = await collectPaginated<number>('evil', 'resources/list', async () => {
      calls++
      return { items: [calls], nextCursor: 'always-the-same' }
    })
    // Second page sees the repeated cursor and bails.
    expect(calls).toBe(2)
    expect(out).toHaveLength(2)
  })

  it('stops at the page cap when every cursor is unique', async () => {
    let calls = 0
    await collectPaginated<number>('evil', 'resources/list', async () => {
      calls++
      return { items: [calls], nextCursor: `cursor-${calls}` }
    })
    expect(calls).toBe(MCP_PAGINATION_MAX_PAGES)
  })

  it('stops at the item cap', async () => {
    let calls = 0
    const out = await collectPaginated<number>('evil', 'resources/list', async () => {
      calls++
      return { items: Array.from({ length: 5000 }, (_, k) => k), nextCursor: `c-${calls}` }
    })
    expect(out.length).toBe(MCP_PAGINATION_MAX_ITEMS)
  })

  it('handles an empty first page', async () => {
    const out = await collectPaginated<number>('srv', 'resources/list', async () => ({ items: [] }))
    expect(out).toEqual([])
  })
})

describe('cachedListTools', () => {
  it('serves repeat calls from cache — mcp_call must not re-fetch per invocation', async () => {
    invalidateToolListCache()
    const fetchTools = vi.fn(async (): Promise<McpToolDefinition[]> => [{ name: 't' }])
    await cachedListTools('srv-1', fetchTools)
    await cachedListTools('srv-1', fetchTools)
    await cachedListTools('srv-1', fetchTools)
    expect(fetchTools).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight request across concurrent callers', async () => {
    invalidateToolListCache()
    const fetchTools = vi.fn(async (): Promise<McpToolDefinition[]> => {
      await new Promise(r => setTimeout(r, 10))
      return [{ name: 't' }]
    })
    await Promise.all([
      cachedListTools('srv-2', fetchTools),
      cachedListTools('srv-2', fetchTools),
      cachedListTools('srv-2', fetchTools),
    ])
    expect(fetchTools).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failure', async () => {
    invalidateToolListCache()
    const fetchTools = vi.fn(async (): Promise<McpToolDefinition[]> => { throw new Error('down') })
    await expect(cachedListTools('srv-3', fetchTools)).rejects.toThrow('down')
    await expect(cachedListTools('srv-3', fetchTools)).rejects.toThrow('down')
    expect(fetchTools).toHaveBeenCalledTimes(2)
  })
})

describe('isMcpToolVisibleTo', () => {
  it('defaults to visible for the model', () => {
    expect(isMcpToolVisibleTo({ name: 't' }, 'model')).toBe(true)
  })

  it('defaults to HIDDEN for apps — server HTML is untrusted', () => {
    // Previously this defaulted open, so a server's own iframe could invoke
    // every tool on the connection with only a browser confirm() in the way.
    expect(isMcpToolVisibleTo({ name: 't' }, 'app')).toBe(false)
  })

  it('honours an explicit app grant', () => {
    const tool: McpToolDefinition = { name: 't', _meta: { ui: { visibility: ['model', 'app'] } } }
    expect(isMcpToolVisibleTo(tool, 'app')).toBe(true)
  })

  it('honours an explicit model-only declaration', () => {
    const tool: McpToolDefinition = { name: 't', _meta: { ui: { visibility: ['model'] } } }
    expect(isMcpToolVisibleTo(tool, 'app')).toBe(false)
    expect(isMcpToolVisibleTo(tool, 'model')).toBe(true)
  })
})
