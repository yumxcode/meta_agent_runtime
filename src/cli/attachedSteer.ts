/**
 * cli/attachedSteer — keyboard steering (Ctrl+G) for `--attached` auto runs.
 *
 * The REPL gets Ctrl+G for free because readline already owns stdin in raw mode
 * and `repl.ts` sniffs the BEL byte off the data stream. `--attached` has no
 * readline: it runs a one-shot turn in the foreground and then waits on the
 * attached scheduler. So it needs its own minimal stdin owner.
 *
 * ⚠️ RAW MODE BREAKS Ctrl+C. In canonical mode the tty driver turns ^C into
 * SIGINT; in raw mode it delivers byte 0x03 to the process instead and no signal
 * is ever raised. `runAttachedAuto` cancels on SIGINT, so taking raw mode
 * without re-emitting the signal would silently make Ctrl+C stop working — the
 * user would be stuck in an unattended run with no way out. This module
 * therefore forwards 0x03 as SIGINT itself, and restores the previous stdin
 * state on dispose so the shell is never left in raw mode.
 */
import * as readline from 'node:readline'
import { cyan, dim, isTTY } from './term.js'
import type { SteerHooks } from './stream.js'

const BEL = 0x07     // Ctrl+G
const ETX = 0x03     // Ctrl+C
const EOT = 0x04     // Ctrl+D

export interface AttachedSteerController {
  hooks: SteerHooks
  /** Restore stdin to its prior state. Safe to call more than once. */
  dispose(): void
}

/**
 * Install a Ctrl+G listener on stdin for the lifetime of an attached run.
 *
 * Returns null when steering is impossible (no TTY, or JSON output where a
 * `steer ›` prompt would corrupt the stream), so callers can simply pass the
 * result through to streamPrompt.
 */
export function createAttachedSteerHooks(opts: { json: boolean }): AttachedSteerController | null {
  if (!isTTY || opts.json || !process.stdin.isTTY) return null

  let armed = false
  let notify: (() => void) | null = null
  let inputActive = false
  let disposed = false

  const onData = (buf: Buffer): void => {
    if (disposed) return
    // While the correction line is being typed, readline owns stdin — do not
    // also interpret those bytes here or a `g` in the text would re-arm.
    if (inputActive) return

    if (buf.includes(ETX)) {
      // Raw mode swallowed the signal; re-raise it so the existing SIGINT-based
      // cancel path keeps working exactly as it does without steering.
      process.emit('SIGINT')
      return
    }
    if (buf.includes(EOT)) {
      process.emit('SIGINT')
      return
    }
    if (buf.includes(BEL)) {
      armed = true
      const fire = notify
      notify = null
      fire?.()
    }
  }

  const hadRawMode = process.stdin.isRaw === true
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.on('data', onData)

  process.stderr.write(
    `${dim('提示：本次为 attached auto 运行，按 ')}${cyan('Ctrl+G')}${dim(' 可中途注入纠偏（不打断生成）。')}\n`,
  )

  const hooks: SteerHooks = {
    isArmed: () => armed,
    waitArmed: () =>
      armed ? Promise.resolve() : new Promise<void>(resolve => { notify = resolve }),
    consume: () => { armed = false },

    beginInput: () => {
      inputActive = true
      // Hand the terminal back to line-discipline so the user gets echo and
      // line editing while typing the correction.
      process.stdin.setRawMode?.(false)
      process.stderr.write(`\n${cyan('steer ›')} `)
    },

    read: () =>
      new Promise<string | null>(resolve => {
        const rl = readline.createInterface({ input: process.stdin, terminal: true })
        let settled = false
        const finish = (value: string | null): void => {
          if (settled) return
          settled = true
          rl.removeAllListeners()
          rl.close()
          resolve(value)
        }
        rl.once('line', line => finish(line))
        rl.once('close', () => finish(null))
      }),

    endInput: () => {
      inputActive = false
      if (!disposed) process.stdin.setRawMode?.(true)
    },
  }

  return {
    hooks,
    dispose: () => {
      if (disposed) return
      disposed = true
      process.stdin.off('data', onData)
      // Restore whatever mode we found stdin in; leaving a terminal raw makes
      // the user's shell unusable after we exit.
      process.stdin.setRawMode?.(hadRawMode)
      process.stdin.pause()
    },
  }
}
