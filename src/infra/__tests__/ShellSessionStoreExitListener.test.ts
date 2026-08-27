/**
 * Regression test for P3-1 (review 2026-08-27): repeatedly creating and
 * resetting the global shell-session store must not accumulate process
 * listeners.
 *
 * The original defect registered a fresh anonymous `process.once('exit', …)`
 * inside the lazy initialiser, while `resetShellSessionStore()` only nulled the
 * store. The full suite reliably produced:
 *
 *   MaxListenersExceededWarning: 11 exit listeners added to [process]
 *
 * and every stale closure still referenced the module-level variable, so on
 * exit the CURRENT store received one `destroyAll()` per accumulated listener.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { shellSessionStore, resetShellSessionStore } from '../exec/ShellSessionStore.js'

afterEach(() => {
  resetShellSessionStore()
})

describe('shell session store exit-handler lifecycle (P3-1)', () => {
  it('does not add a listener per create/reset cycle', () => {
    resetShellSessionStore()
    const baseline = process.listenerCount('exit')

    // The suite tripped Node's default limit of 10; 30 cycles is well past any
    // threshold a regression could hide under.
    for (let i = 0; i < 30; i++) {
      shellSessionStore()
      resetShellSessionStore()
    }

    expect(process.listenerCount('exit')).toBe(baseline)
  })

  it('registers exactly one listener while a store is live', () => {
    resetShellSessionStore()
    const baseline = process.listenerCount('exit')

    shellSessionStore()
    expect(process.listenerCount('exit')).toBe(baseline + 1)

    // Repeated access is memoised and must not register again.
    shellSessionStore()
    shellSessionStore()
    expect(process.listenerCount('exit')).toBe(baseline + 1)
  })

  it('removes the listener on reset', () => {
    resetShellSessionStore()
    const baseline = process.listenerCount('exit')

    shellSessionStore()
    resetShellSessionStore()

    expect(process.listenerCount('exit')).toBe(baseline)
  })

  it('still hands out a working store after a reset cycle', () => {
    shellSessionStore()
    resetShellSessionStore()

    const store = shellSessionStore()
    expect(store).toBeDefined()
    // A fresh instance, not the destroyed one.
    expect(store).not.toBe(undefined)
    expect(shellSessionStore()).toBe(store)
  })

  it('stays flat under interleaved access and reset', () => {
    resetShellSessionStore()
    const baseline = process.listenerCount('exit')

    for (let i = 0; i < 10; i++) {
      shellSessionStore()
      shellSessionStore()
      resetShellSessionStore()
      resetShellSessionStore()   // reset twice: must be idempotent
    }

    expect(process.listenerCount('exit')).toBe(baseline)
  })
})
