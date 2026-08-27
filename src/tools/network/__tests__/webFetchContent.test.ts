/**
 * web_fetch — what comes back, and what it costs to get it.
 *
 * The SSRF guard refuses loopback by design, so these cannot stand up a local
 * server and drive the tool end to end. They pin the four decisions that used to
 * have no coverage at all, at the seams where each one is made.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { LookupAddress } from 'node:dns'
import {
  callDeadline,
  classifyBody,
  clearWebFetchCache,
  createWebFetchTool,
  primeWebFetchCache,
  renderPage,
  tryAddresses,
} from '../web_fetch/index.js'
import type { ToolCallContext } from '../../../core/types.js'

function makeCtx(): ToolCallContext {
  return {
    sessionId: 'test',
    agentId: 'test',
    abortSignal: new AbortController().signal,
    workspaceRoot: process.cwd(),
  } as unknown as ToolCallContext
}

afterEach(() => {
  clearWebFetchCache()
  vi.useRealTimers()
})

describe('web_fetch — content-type gate', () => {
  const text = Buffer.from('hello world')

  it('classifies the textual families it can actually render', () => {
    expect(classifyBody('text/html; charset=utf-8', text)).toBe('html')
    expect(classifyBody('application/xhtml+xml', text)).toBe('html')
    expect(classifyBody('application/json', text)).toBe('json')
    expect(classifyBody('application/vnd.api+json', text)).toBe('json')
    expect(classifyBody('text/plain', text)).toBe('text')
    expect(classifyBody('application/xml', text)).toBe('text')
    expect(classifyBody('text/csv', text)).toBe('text')
  })

  it('classifies binary payloads as binary rather than decoding them', () => {
    // The whole point: these used to come back as UTF-8 mojibake with
    // isError:false, so the model treated the noise as page content.
    expect(classifyBody('application/pdf', text)).toBe('binary')
    expect(classifyBody('image/png', text)).toBe('binary')
    expect(classifyBody('application/octet-stream', text)).toBe('binary')
    expect(classifyBody('application/zip', text)).toBe('binary')
  })

  it('sniffs when the server declares no type at all', () => {
    expect(classifyBody('', text)).toBe('text')
    expect(classifyBody('', Buffer.from([0x50, 0x4b, 0x03, 0x00, 0x04]))).toBe('binary')
  })
})

describe('web_fetch — the cache holds the body, not the prompt', () => {
  it('renders a cached page with the CURRENT call prompt', async () => {
    clearWebFetchCache()
    const url = 'https://example.invalid/doc'
    primeWebFetchCache(url, {
      finalUrl: url,
      text: 'the page body',
      expiresAt: Date.now() + 60_000,
    })

    const tool = await createWebFetchTool()
    const second = await tool.call({ url, prompt: 'what changed in v2?' }, makeCtx())

    expect(second.isError).toBe(false)
    expect(String(second.content)).toContain('Prompt: what changed in v2?')
    expect(String(second.content)).toContain('the page body')
    // A stale instruction presented as the current one is the regression.
    expect(String(second.content)).not.toContain('why the first caller asked')
  })

  it('keeps an advisory note attached to the body', () => {
    const rendered = renderPage(
      { finalUrl: 'https://x.invalid/', text: 'body', note: '[SPA shell]' },
      'extract the price',
    )
    expect(rendered).toContain('Prompt: extract the price')
    expect(rendered.indexOf('[SPA shell]')).toBeLessThan(rendered.indexOf('body'))
  })
})

describe('web_fetch — address failover', () => {
  const addr = (address: string): LookupAddress => ({ address, family: 4 })
  const live = new AbortController().signal

  it('moves to the next validated address when one refuses to connect', async () => {
    const tried: string[] = []
    const result = await tryAddresses([addr('1.1.1.1'), addr('2.2.2.2')], live, async a => {
      tried.push(a.address)
      if (a.address === '1.1.1.1') throw new Error('ECONNREFUSED')
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(tried).toEqual(['1.1.1.1', '2.2.2.2'])
  })

  it('stops after three attempts rather than walking a long DNS answer', async () => {
    const tried: string[] = []
    await expect(tryAddresses(
      [addr('1.1.1.1'), addr('2.2.2.2'), addr('3.3.3.3'), addr('4.4.4.4')],
      live,
      async a => { tried.push(a.address); throw new Error('down') },
    )).rejects.toThrow('down')
    expect(tried).toHaveLength(3)
  })

  it('treats an abort as final instead of retrying the next address', async () => {
    const aborted = AbortSignal.abort()
    const tried: string[] = []
    await expect(tryAddresses([addr('1.1.1.1'), addr('2.2.2.2')], aborted, async a => {
      tried.push(a.address)
      throw new Error('cancelled')
    })).rejects.toThrow('cancelled')
    expect(tried).toEqual(['1.1.1.1'])
  })
})

describe('web_fetch — the call has a deadline of its own', () => {
  it('expires on its own timer, not only when the caller aborts', async () => {
    vi.useFakeTimers()
    const deadline = callDeadline(undefined, 1_000)
    expect(deadline.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.expired()).toBe(true)
    deadline.dispose()
  })

  it('still follows the caller when the caller aborts first', () => {
    const parent = new AbortController()
    const deadline = callDeadline(parent.signal, 60_000)
    parent.abort()
    expect(deadline.signal.aborted).toBe(true)
    // Not a timeout — the message must not blame a deadline that never fired.
    expect(deadline.expired()).toBe(false)
    deadline.dispose()
  })

  it('inherits an already-aborted caller signal', () => {
    const deadline = callDeadline(AbortSignal.abort(), 60_000)
    expect(deadline.signal.aborted).toBe(true)
    deadline.dispose()
  })
})
