import { describe, expect, it } from 'vitest'
import { clearWebFetchCache, createPinnedLookup, createWebFetchTool } from '../web_fetch/index.js'
import type { ToolCallContext } from '../../../core/types.js'

function makeCtx(): ToolCallContext {
  return {
    sessionId: 'test',
    agentId: 'test',
    abortSignal: new AbortController().signal,
    workspaceRoot: process.cwd(),
  } as unknown as ToolCallContext
}

describe('web_fetch — SSRF defence (H1)', () => {
  it('rejects file:// scheme', async () => {
    clearWebFetchCache()
    const tool = await createWebFetchTool()
    const result = await tool.call(
      { url: 'file:///etc/passwd', prompt: 'leak' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/Refused|not allowed/)
  })

  it('rejects loopback host via IP literal', async () => {
    clearWebFetchCache()
    const tool = await createWebFetchTool()
    const result = await tool.call(
      { url: 'http://127.0.0.1/admin', prompt: 'leak' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/Refused|loopback/)
  })

  it('rejects AWS IMDS literal 169.254.169.254', async () => {
    clearWebFetchCache()
    const tool = await createWebFetchTool()
    const result = await tool.call(
      { url: 'http://169.254.169.254/latest/meta-data/', prompt: 'leak' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/Refused|link-local|metadata/)
  })

  it('rejects RFC1918 10/8 literal', async () => {
    clearWebFetchCache()
    const tool = await createWebFetchTool()
    const result = await tool.call(
      { url: 'http://10.0.0.1/', prompt: 'leak' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/Refused|private 10/)
  })

  it('rejects IPv6 loopback ::1', async () => {
    clearWebFetchCache()
    const tool = await createWebFetchTool()
    const result = await tool.call(
      { url: 'http://[::1]/', prompt: 'leak' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/Refused|loopback/)
  })

  it('rejects literal "localhost"', async () => {
    clearWebFetchCache()
    const tool = await createWebFetchTool()
    const result = await tool.call(
      { url: 'http://localhost:8080/x', prompt: 'leak' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/Refused|localhost/)
  })
})

describe('web_fetch — pinned DNS lookup', () => {
  it('returns address and family for normal lookup mode', () => {
    const pinnedLookup = createPinnedLookup({ address: '93.184.216.34', family: 4 })

    pinnedLookup('example.com', {}, (err, address, family) => {
      expect(err).toBeNull()
      expect(address).toBe('93.184.216.34')
      expect(family).toBe(4)
    })
  })

  it('returns LookupAddress[] for all:true lookup mode', () => {
    const pinnedLookup = createPinnedLookup({ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 })

    pinnedLookup('example.com', { all: true }, (err, address, family) => {
      expect(err).toBeNull()
      expect(address).toEqual([
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ])
      expect(family).toBeUndefined()
    })
  })

  it('re-validates pinned addresses defensively', () => {
    const pinnedLookup = createPinnedLookup({ address: '127.0.0.1', family: 4 })

    pinnedLookup('example.com', { all: true }, (err, address, family) => {
      expect(err?.message).toContain('pinned address failed re-validation')
      expect(address).toBe('')
      expect(family).toBe(0)
    })
  })
})
