/**
 * The full-screen view must give the terminal back on a SIGNAL, not only on a
 * clean quit or a `process.on('exit')`.
 *
 * `exit` handlers do NOT run for SIGTERM / SIGHUP / SIGQUIT — Node's default
 * action for those is to terminate the process outright. So `kill <pid>`, an
 * SSH session dropping, or closing the terminal emulator used to leave the
 * surviving shell inside the alternate screen with raw mode still enabled: no
 * echo, no cursor, and Ctrl+C dead, recoverable only with `reset`. cli/repl.ts
 * has handled these (SIGHUP included) for a while; this view had not.
 *
 * Registering a handler REPLACES the default action, so the handler must also
 * terminate the process — hence the process.exit assertion below.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskTui } from '../TaskTui.js'

const SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'] as const

function listenerCounts(): Record<string, number> {
  return Object.fromEntries(SIGNALS.map(s => [s, process.listenerCount(s)]))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TaskTui signal handling', () => {
  it('registers and then removes a handler for every fatal signal', async () => {
    const before = listenerCounts()
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })

    const tui = new TaskTui({ workspaces: [], refreshMs: 60_000 })
    const running = tui.run()
    // Let run() get past its first await (manager start + initial refresh).
    await new Promise(resolve => setTimeout(resolve, 20))

    const during = listenerCounts()
    for (const signal of SIGNALS) {
      expect(during[signal], `${signal} handler installed`).toBe((before[signal] ?? 0) + 1)
    }

    // 'q' is the ordinary quit key; it exercises the same teardown path.
    process.stdin.emit('data', Buffer.from('q'))
    await running

    expect(listenerCounts()).toEqual(before)
    // The alternate screen was left behind, not just entered.
    expect(writes.join('')).toContain('\x1b[?1049l')
  })

  it('restores the terminal before exiting on SIGTERM', async () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const tui = new TaskTui({ workspaces: [], refreshMs: 60_000 })
    const running = tui.run()
    await new Promise(resolve => setTimeout(resolve, 20))

    process.emit('SIGTERM')
    await running

    // Ordering is the point: the escape that leaves the alternate screen must
    // already have been written by the time the process is told to go.
    expect(writes.join('')).toContain('\x1b[?1049l')
    expect(exit).toHaveBeenCalledWith(143)
    expect(listenerCounts()['SIGTERM']).toBe(0)
  })
})
