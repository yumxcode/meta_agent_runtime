/**
 * streamPrompt must hand the event generator back when it bails out.
 *
 * The render loop drives `router.submit()` BY HAND rather than with `for await`,
 * so that an armed Ctrl+G steer can pre-empt an event that has already
 * resolved. The cost of that choice is that nothing calls `gen.return()` for
 * us — and the whole runtime is built on the assumption that somebody does:
 *
 *   - KernelSession.submitMessage clears `_submitInFlight` in a `finally`.
 *     Skip it and the session is wedged for good: every later turn throws
 *     "Cannot call submitMessage() concurrently on the same session", and the
 *     REPL just prints that error and loops, so the user sees the same message
 *     for every line they type with no way to connect it to what happened.
 *   - streamMessages releases the host model-call lease in a `finally`. Skip it
 *     and the lease's heartbeat keeps renewing a slot nobody is using, for the
 *     lifetime of the process.
 *   - runKernelLoop clears the auto-runtime watchdog timer in a `finally`.
 *
 * The trigger is not exotic: `pending = gen.next()` is issued BEFORE the event
 * is rendered, so any throw from the render side (a non-EPIPE stdout error) or
 * the ERR_STREAM_PREMATURE_CLOSE early return leaves that next() orphaned.
 */
import { describe, expect, it, vi } from 'vitest'
import { streamPrompt } from '../stream.js'
import type { MetaAgentEvent } from '../../core/types.js'
import type { SessionMode } from '../../core/modes.js'

interface Harness {
  router: Parameters<typeof streamPrompt>[0]
  state: { finallyRan: boolean; interrupted: number; produced: number }
}

function harness(events: MetaAgentEvent[]): Harness {
  const state = { finallyRan: false, interrupted: 0, produced: 0 }
  async function* submit(): AsyncGenerator<MetaAgentEvent> {
    try {
      for (const event of events) {
        state.produced++
        yield event
      }
    } finally {
      // Stands in for every real `finally` in the submit chain.
      state.finallyRan = true
    }
  }
  const router = {
    submit,
    steer: () => false,
    interrupt: () => { state.interrupted++ },
    getEstimatedCost: () => 0,
    mode: 'agentic' as SessionMode | null,
  }
  return { router, state }
}

const textEvent = (text: string): MetaAgentEvent =>
  ({ type: 'text', text } as MetaAgentEvent)

/** Let the queued return() be serviced — it is deliberately not awaited. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('streamPrompt generator ownership', () => {
  it('runs the generator finally when the render loop throws', async () => {
    const { router, state } = harness([textEvent('a'), textEvent('b'), textEvent('c')])
    // jsonMode routes every event through console.log; failing the second call
    // reproduces "a write threw while a next() was already in flight".
    let calls = 0
    const log = vi.spyOn(console, 'log').mockImplementation(() => {
      calls++
      if (calls === 2) throw new Error('stdout exploded')
    })

    await expect(streamPrompt(router, 'go', true)).rejects.toThrow('stdout exploded')
    log.mockRestore()
    await settle()

    expect(state.finallyRan).toBe(true)
    // The in-flight model call is cancelled too — otherwise the queued return()
    // would not be serviced until the current turn finished on its own.
    expect(state.interrupted).toBeGreaterThan(0)
  })

  it('does not interrupt or re-close a stream that drained normally', async () => {
    const { router, state } = harness([textEvent('a'), textEvent('b')])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await streamPrompt(router, 'go', true)
    log.mockRestore()
    await settle()

    expect(state.finallyRan).toBe(true)     // the generator ran to completion
    expect(state.interrupted).toBe(0)       // …so nothing needed cancelling
  })

  it('stops pulling events once it has bailed out', async () => {
    // 50 events, but the render side dies on the second. Without the handback
    // the generator would sit parked on an un-consumed next() forever; with it,
    // it is closed and never advances again.
    const events = Array.from({ length: 50 }, (_, i) => textEvent(String(i)))
    const { router, state } = harness(events)
    let calls = 0
    const log = vi.spyOn(console, 'log').mockImplementation(() => {
      calls++
      if (calls === 2) throw new Error('stdout exploded')
    })

    await expect(streamPrompt(router, 'go', true)).rejects.toThrow('stdout exploded')
    log.mockRestore()
    await settle()
    const producedAtBail = state.produced
    await settle()

    expect(state.finallyRan).toBe(true)
    expect(state.produced).toBe(producedAtBail)
    expect(state.produced).toBeLessThan(events.length)
  })
})
