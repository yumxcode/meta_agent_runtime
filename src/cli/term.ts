/**
 * cli/term — terminal primitives shared by every CLI surface.
 *
 * Colour helpers, sanitised output, backpressure-aware stdout writes, and the
 * process-wide "active thinking meter" registry. Extracted from cli/index.ts,
 * which had grown past 6,000 lines; keeping these here means a command module
 * can render output without pulling in the REPL.
 *
 * Everything in this module is leaf-level: it imports no other CLI module, so
 * it can never participate in an import cycle.
 */
import { once } from 'node:events'
import { sanitizeTerminalText } from './terminalSanitizer.js'
import type { ThinkingMeter } from './thinkingMeter.js'

// ── ANSI colour helpers ───────────────────────────────────────────────────────

export const isTTY = process.stdout.isTTY

export const c = {
  reset:    isTTY ? '\x1b[0m'  : '',
  bold:     isTTY ? '\x1b[1m'  : '',
  dim:      isTTY ? '\x1b[2m'  : '',
  cyan:     isTTY ? '\x1b[36m' : '',
  green:    isTTY ? '\x1b[32m' : '',
  yellow:   isTTY ? '\x1b[33m' : '',
  blue:     isTTY ? '\x1b[34m' : '',
  magenta:  isTTY ? '\x1b[35m' : '',
  red:      isTTY ? '\x1b[31m' : '',
  gray:     isTTY ? '\x1b[90m' : '',
}

export const dim    = (s: string): string => `${c.dim}${s}${c.reset}`
export const bold   = (s: string): string => `${c.bold}${s}${c.reset}`
export const cyan   = (s: string): string => `${c.cyan}${s}${c.reset}`
export const green  = (s: string): string => `${c.green}${s}${c.reset}`
export const gray   = (s: string): string => `${c.gray}${s}${c.reset}`
export const red    = (s: string): string => `${c.red}${s}${c.reset}`
export const yellow = (s: string): string => `${c.yellow}${s}${c.reset}`

/** Strip control sequences from untrusted text before it reaches the terminal. */
export const terminalText = (input: unknown): string => sanitizeTerminalText(input)

// ── Output ────────────────────────────────────────────────────────────────────

/**
 * Make a closed output pipe a clean exit instead of a crash.
 *
 * T3: `meta-agent … | head` (or `| less` and pressing q) closes the read end.
 * Every subsequent write raises EPIPE — delivered as an `'error'` EVENT on the
 * stream, and an unhandled `'error'` is thrown by EventEmitter. Nothing in this
 * codebase listened for it, so the REPL's `process.once('uncaughtException')`
 * caught it and printed `Fatal: write EPIPE` for what is a completely ordinary
 * shell idiom. It also broke `safeStdoutWrite` differently: `once(stdout,
 * 'drain')` REJECTS on 'error', surfacing EPIPE as a turn error.
 *
 * Exiting silently on EPIPE is the standard CLI convention (grep, cat, git all
 * do it). Any other stream error is still reported — a full disk writing to a
 * redirected file must not vanish.
 *
 * Idempotent, so the CLI entry point and tests can both call it.
 */
let _pipeGuardsInstalled = false
export function installBrokenPipeGuards(): void {
  if (_pipeGuardsInstalled) return
  _pipeGuardsInstalled = true
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') {
        // The reader is gone; there is nowhere left to report anything.
        process.exit(0)
      }
      // Not a broken pipe — let the normal fatal path handle it.
      throw err
    })
  }
}

/** Write to stdout, awaiting 'drain' when the pipe applies backpressure. */
export async function safeStdoutWrite(text: string): Promise<void> {
  if (!text) return
  if (process.stdout.write(text)) return
  try {
    await once(process.stdout, 'drain')
  } catch (err) {
    // `once` rejects if the stream emits 'error' while we wait. A broken pipe
    // is not this turn's problem to report — installBrokenPipeGuards() is
    // already exiting the process — so swallow it rather than turning a
    // `| head` into a turn-level error message.
    if ((err as NodeJS.ErrnoException)?.code !== 'EPIPE') throw err
  }
}

// ── Active thinking-meter registry ────────────────────────────────────────────
//
// streamPrompt owns a ThinkingMeter that redraws an in-place status line on a
// 120ms timer. When an interactive prompt must appear mid-turn (e.g. the
// multi-agent escalation confirmation), that timer erases the prompt on its next
// tick — the user is left staring at the "等待模型响应…" spinner with no visible
// question, and a blind <Enter> silently declines. streamPrompt registers its
// meter here so any mid-turn prompt reader can pause the spinner first; the
// stream's own event handlers re-show it when the next model event arrives.

let _activeThinkingMeter: ThinkingMeter | null = null
let _suppressActiveThinkingMeter = false

/** Register the meter owned by the in-flight turn (null to clear). */
export function setActiveThinkingMeter(meter: ThinkingMeter | null): void {
  _activeThinkingMeter = meter
}

export function pauseActiveThinkingMeter(): void {
  _activeThinkingMeter?.hide()
}

export function setActiveThinkingMeterSuppressed(suppressed: boolean): void {
  _suppressActiveThinkingMeter = suppressed
  if (suppressed) pauseActiveThinkingMeter()
}

export function canShowActiveThinkingMeter(): boolean {
  return !_suppressActiveThinkingMeter
}

// ── Errors ────────────────────────────────────────────────────────────────────

/** Build an AbortError with an optional operator-supplied reason. */
export function abortError(reason?: unknown): Error {
  const error = new Error(
    typeof reason === 'string' && reason ? reason : 'Operation aborted.',
  )
  error.name = 'AbortError'
  return error
}
