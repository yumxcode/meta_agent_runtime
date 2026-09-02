/**
 * `timeoutMs` has to actually bound the call, including when `close` never
 * arrives.
 *
 * The promise settled only on `'close'`, which fires after every stdio stream
 * has ended — i.e. after every holder of the inherited fds is gone. A
 * grandchild that escaped the process group (its own session, a daemonising
 * installer, `nohup`) survives the group SIGKILL and keeps the pipe open, so
 * `close` never came and the timer, having fired once, had nothing left to do.
 * The bash tool hung, and with it the kernel loop.
 *
 * `exit` does not have that problem — it reports the direct child terminating
 * regardless of who still holds the pipes — so it feeds a second fuse.
 */
import { describe, expect, it } from 'vitest'
import { runShellCommand } from '../runShellCommand.js'
import { tmpdir } from 'node:os'

const onWindows = process.platform === 'win32'

/**
 * A child that leaves behind a DETACHED grandchild holding stdout/stderr.
 * `detached: true` puts it in its own process group, so `kill(-pid)` misses it.
 *
 * It holds the pipes for 20 s and then exits on its own, which is what keeps
 * this test honest in both directions: WITH the fuse the call returns in about
 * 3.4 s (400 ms deadline + the 3 s grace); WITHOUT it, `close` cannot arrive
 * until the orphan is gone, so the call blows the 12 s test timeout. An orphan
 * that exited quickly would let the broken version pass too.
 */
const ORPHAN_HOLD_MS = 20_000
const ORPHAN_HOLDING_STDOUT =
  `${JSON.stringify(process.execPath)} -e ` +
  JSON.stringify(
    "const cp=require('child_process');" +
    `cp.spawn(process.execPath,['-e','setTimeout(()=>{},${ORPHAN_HOLD_MS})'],` +
    "{detached:true,stdio:['ignore',1,2]}).unref();" +
    `setTimeout(()=>{},${ORPHAN_HOLD_MS})`,
  )

describe('runShellCommand timeout fuse', () => {
  it.skipIf(onWindows)('settles even when a detached grandchild holds the pipes', async () => {
    const started = Date.now()
    const result = await runShellCommand({
      command: ORPHAN_HOLDING_STDOUT,
      cwd: tmpdir(),
      timeoutMs: 400,
      signal: new AbortController().signal,
      captureLimit: 4096,
    })
    const elapsed = Date.now() - started

    expect(result.timedOut).toBe(true)
    // 400ms deadline + the 3s post-kill grace, with headroom for a loaded box —
    // and far below the 20s the orphan holds the pipes for.
    expect(elapsed).toBeLessThan(9_000)
  }, 12_000)

  it('reports a normal command through the ordinary close path', async () => {
    const result = await runShellCommand({
      command: 'echo hello',
      cwd: tmpdir(),
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      captureLimit: 4096,
    })
    expect(result.stdout.trim()).toBe('hello')
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
  }, 20_000)

  it.skipIf(onWindows)('still times out an ordinary long command', async () => {
    const result = await runShellCommand({
      command: 'sleep 10',
      cwd: tmpdir(),
      timeoutMs: 300,
      signal: new AbortController().signal,
      captureLimit: 4096,
    })
    expect(result.timedOut).toBe(true)
  }, 20_000)

  it.skipIf(onWindows)('settles promptly on abort', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const result = await runShellCommand({
      command: 'sleep 10',
      cwd: tmpdir(),
      timeoutMs: 30_000,
      signal: controller.signal,
      captureLimit: 4096,
    })
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
  }, 20_000)
})
