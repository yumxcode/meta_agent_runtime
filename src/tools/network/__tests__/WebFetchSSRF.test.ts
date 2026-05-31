import { describe, expect, it } from 'vitest'
import { clearWebFetchCache, createWebFetchTool } from '../web_fetch/index.js'
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
