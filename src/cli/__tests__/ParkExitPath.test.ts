/**
 * After a durable park, the CLI must hand the terminal back.
 *
 * Reported from real use: a `self_timer` park armed its wake, printed the
 * confirmation, and then the process just sat there — no prompt, no output,
 * nothing to interrupt.
 *
 * The cause was a flag doing two jobs. The park path set `exiting = true` BEFORE
 * calling `rl.close()`, intending to skip the goodbye summary. But the close
 * handler opens with `if (exiting) return`, and that handler is the only thing on
 * this route that calls `process.exit(0)` — so the flag skipped the exit along
 * with the message. Control fell out of the loop and off the end of `runRepl`
 * with nothing left to terminate the process, leaving exit to depend on the event
 * loop draining by itself.
 *
 * It usually did, which is exactly why this survived: the hang only appears when
 * something keeps a handle open. Stdio MCP servers do — they are long-lived child
 * processes that outlive the CLI unless explicitly killed — so the bug reproduced
 * only for users with one configured.
 *
 * These are source-level assertions rather than a spawned CLI because the
 * failure is the ABSENCE of a call: a behavioural test would have to wait for a
 * hang that does not occur on a machine with no MCP servers configured, which is
 * precisely the blind spot that let this ship.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..')
const repl = readFileSync(join(SRC, 'repl.ts'), 'utf-8')
const index = readFileSync(join(SRC, 'index.ts'), 'utf-8')

/**
 * Drop comments before asserting.
 *
 * Without this every assertion below is satisfiable by PROSE: this file's own
 * explanations mention `process.exit(0)` and `disposeMcpClients()`, so a
 * `toContain` check would pass against a commented-out fix. Stripping comments
 * is what makes these assertions about the code rather than about the story told
 * around it — the first draft of this test proved the point by matching its own
 * comment and reporting the wrong ordering.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** The park branch: from the parked-subtype check to the end of its block. */
function parkBranch(): string {
  const start = repl.indexOf("turnStream?.result?.subtype === 'parked'")
  expect(start).toBeGreaterThan(-1)
  const end = repl.indexOf('maybeGenerateSessionTitle', start)
  expect(end).toBeGreaterThan(start)
  return code(repl.slice(start, end))
}

describe('durable park exit path', () => {
  it('terminates the process explicitly instead of relying on rl.close()', () => {
    // The close handler cannot do it: this path sets `exiting`, which that
    // handler treats as "someone else owns teardown".
    expect(parkBranch()).toContain('process.exit(0)')
  })

  it('kills stdio MCP children before exiting', () => {
    // Without this the child processes outlive the CLI, holding the event loop
    // (and, per disposeAndExit, ports and locks) open.
    expect(parkBranch()).toContain('disposeMcpClients()')
  })

  it('sets the exiting flag only alongside a real exit', () => {
    const branch = parkBranch()
    const flagAt = branch.indexOf('exiting = true')
    const exitAt = branch.indexOf('process.exit(0)')
    expect(flagAt).toBeGreaterThan(-1)
    // The flag disables the close handler's exit, so it must never be raised
    // before this path has committed to exiting on its own.
    expect(exitAt).toBeGreaterThan(flagAt)
  })

  it('closes MCP clients on every normal CLI exit, not just the REPL signal path', () => {
    // The one-shot and scheduler routes return normally through main()'s finally
    // and were exposed to the same orphaned-child hang.
    const finallyBlock = code(index.slice(index.indexOf('} finally {')))
    expect(finallyBlock).toContain('disposeMcpClients()')
  })
})

describe('park confirmation honesty', () => {
  it('does not promise a resume without checking a scheduler is running', () => {
    // A pending wake in a workspace with no scheduler sits until staleWakeMs
    // (7 days) retires it unexecuted — the failure SchedulerRegistry exists to
    // detect, which nothing was asking it about.
    const branch = parkBranch()
    expect(branch).toContain('listSchedulers')
    expect(branch).toContain('isSchedulerAlive')
  })

  it('prints the command to start one when none is alive', () => {
    expect(parkBranch()).toContain('auto-scheduler')
  })
})
