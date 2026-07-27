/**
 * The stream watchdog is the ONLY thing bounding a streaming LLM call.
 *
 * The vendor SDKs clear their `timeout` timer as soon as response HEADERS
 * arrive, so from the first SSE byte onward a stream has no deadline. The
 * `against a real stalling SDK stream` case below reproduces that end-to-end
 * (SDK client configured with a 2 s timeout, server stalls after three events)
 * and asserts the watchdog — not the SDK — is what cuts it off.
 */
import { describe, it, expect } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import Anthropic from '@anthropic-ai/sdk'
import { withStreamWatchdog, StreamTimeoutError, isStreamTimeoutError } from '../StreamWatchdog.js'
import { isRetryableError } from '../Errors.js'

/** An async iterable that yields `values`, pausing `gapMs` before each. */
async function* paced<T>(values: T[], gapMs: number): AsyncGenerator<T> {
  for (const v of values) {
    await new Promise(r => setTimeout(r, gapMs))
    yield v
  }
}

/** Never yields; used to model a request that produces no first token. */
async function* neverYields(): AsyncGenerator<never> {
  await new Promise(() => { /* forever */ })
}

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

describe('withStreamWatchdog', () => {
  it('passes a healthy stream through untouched', async () => {
    const out = await collect(withStreamWatchdog(paced([1, 2, 3], 5), {
      firstTokenMs: 500, idleMs: 500,
    }))
    expect(out).toEqual([1, 2, 3])
  })

  it('fires a first_token timeout when nothing ever arrives', async () => {
    let aborted: string | undefined
    await expect(collect(withStreamWatchdog(neverYields(), {
      firstTokenMs: 50, idleMs: 10_000,
      onTimeout: phase => { aborted = phase },
    }))).rejects.toThrow(StreamTimeoutError)
    expect(aborted).toBe('first_token')
  })

  it('fires an idle timeout when the stream goes silent mid-flight', async () => {
    let phase: string | undefined
    const source = (async function* () {
      yield 'a'
      yield 'b'
      await new Promise(() => { /* stall forever */ })
    })()

    const seen: string[] = []
    await expect((async () => {
      for await (const v of withStreamWatchdog(source, {
        firstTokenMs: 5_000, idleMs: 60,
        onTimeout: p => { phase = p },
      })) seen.push(v)
    })()).rejects.toThrow(/stalled: no event for 60ms/)

    // Events delivered before the stall are kept — the caller's `yieldedAny`
    // guard depends on knowing output was already rendered.
    expect(seen).toEqual(['a', 'b'])
    expect(phase).toBe('idle')
  })

  it('applies the FIRST-token budget only until the first event', async () => {
    // firstTokenMs is tight, idleMs is generous: a stream whose first event is
    // fast but whose later gaps are long must NOT be killed.
    const source = (async function* () {
      yield 1
      await new Promise(r => setTimeout(r, 120))
      yield 2
    })()
    const out = await collect(withStreamWatchdog(source, { firstTokenMs: 60, idleMs: 5_000 }))
    expect(out).toEqual([1, 2])
  })

  it('tears the source down on timeout so the socket is released', async () => {
    let returned = false
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<number>>(() => { /* stall */ }),
          return: async () => { returned = true; return { done: true, value: undefined } },
        }
      },
    }
    await expect(collect(withStreamWatchdog(source, { firstTokenMs: 30, idleMs: 30 })))
      .rejects.toThrow(StreamTimeoutError)
    expect(returned).toBe(true)
  })

  it('tears the source down when the CONSUMER breaks early', async () => {
    let returned = false
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        let i = 0
        return {
          next: async () => ({ done: false, value: i++ }),
          return: async () => { returned = true; return { done: true, value: undefined } },
        }
      },
    }
    for await (const v of withStreamWatchdog(source, { firstTokenMs: 1_000, idleMs: 1_000 })) {
      if (v >= 2) break
    }
    expect(returned).toBe(true)
  })

  it('never lets a timeout surface as an unhandled rejection', async () => {
    // The deadline is a RESOLVING sentinel, not a rejecting promise: a rejected
    // race loser would be fatal in the CLI (process.once('unhandledRejection')).
    const seen: unknown[] = []
    const onUnhandled = (e: unknown): void => { seen.push(e) }
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(collect(withStreamWatchdog(neverYields(), { firstTokenMs: 20, idleMs: 20 })))
        .rejects.toThrow(StreamTimeoutError)
      await new Promise(r => setTimeout(r, 60))
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('keeps a rejecting orphaned next() from becoming an unhandled rejection', async () => {
    // The realistic shape: onTimeout aborts the request, so the `next()` that
    // LOST the race rejects a moment later with nobody awaiting it. Unhandled,
    // that rejection is fatal in the CLI — on the very stall the watchdog is
    // supposed to survive.
    //
    // Today `Promise.race` already adopts its losers, so this passes with or
    // without the explicit `.catch` in the implementation. It is here as an
    // INVARIANT lock: a future refactor that replaces the race (e.g. with a
    // manual timer + flag) would break it, and this test would catch that.
    const seen: unknown[] = []
    const onUnhandled = (e: unknown): void => { seen.push(e) }
    process.on('unhandledRejection', onUnhandled)
    try {
      let rejectPending: ((e: Error) => void) | undefined
      const source: AsyncIterable<number> = {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<number>>((_res, rej) => { rejectPending = rej }),
        }),
      }

      await expect(collect(withStreamWatchdog(source, {
        firstTokenMs: 30,
        idleMs: 30,
        // Mirrors the clients: abort the in-flight request on timeout.
        onTimeout: () => rejectPending?.(new Error('aborted by watchdog')),
      }))).rejects.toThrow(StreamTimeoutError)

      await new Promise(r => setTimeout(r, 80))
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('retry classification', () => {
  it('marks a stream timeout retryable so the existing recovery path engages', () => {
    expect(isRetryableError(new StreamTimeoutError('first_token', 90_000))).toBe(true)
    expect(isStreamTimeoutError(new StreamTimeoutError('idle', 60_000))).toBe(true)
    expect(isStreamTimeoutError(new Error('nope'))).toBe(false)
  })
})

describe('against a real stalling SDK stream', () => {
  it('cuts off a stream the SDK timeout does NOT bound', async () => {
    // Server: valid SSE headers + three events, then hold the socket open.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const ev = (e: string, d: object): void => { res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`) }
      ev('message_start', {
        type: 'message_start',
        message: {
          id: 'm', type: 'message', role: 'assistant', model: 'x',
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })
      // ...then nothing. No message_stop, no end().
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port

    try {
      // A 2 s SDK timeout demonstrably does NOT stop this (it is cleared once
      // headers arrive) — the watchdog's 250 ms idle budget is what does.
      const client = new Anthropic({
        apiKey: 'test', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0, timeout: 2_000,
      })
      const ctrl = new AbortController()
      const stream = await client.messages.create(
        { model: 'x', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], stream: true },
        { signal: ctrl.signal },
      )

      const started = Date.now()
      let events = 0
      let caught: unknown
      try {
        for await (const _e of withStreamWatchdog(stream, {
          firstTokenMs: 5_000,
          idleMs: 250,
          onTimeout: () => ctrl.abort(new Error('stream watchdog')),
        })) events++
      } catch (err) { caught = err }

      const elapsed = Date.now() - started
      expect(caught).toBeInstanceOf(StreamTimeoutError)
      expect((caught as StreamTimeoutError).phase).toBe('idle')
      expect(events).toBeGreaterThan(0)          // the three real events arrived
      expect(elapsed).toBeLessThan(2_000)        // cut off well before the SDK timeout
    } finally {
      server.close()
    }
  }, 20_000)
})
