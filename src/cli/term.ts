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

/** Write to stdout, awaiting 'drain' when the pipe applies backpressure. */
export async function safeStdoutWrite(text: string): Promise<void> {
  if (!text) return
  if (process.stdout.write(text)) return
  await once(process.stdout, 'drain')
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
