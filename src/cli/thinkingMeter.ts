/**
 * thinkingMeter — a live "the model is reasoning" indicator for the REPL.
 *
 * Why this exists:
 *   Reasoning models (DeepSeek-R1, Qwen-thinking, …) stream their chain of
 *   thought as reasoning_content BEFORE any visible answer. When the full
 *   thinking text is hidden, the terminal shows nothing during that phase, so a
 *   long reasoning turn looks like the CLI has frozen ("很久没回应"). This meter
 *   renders an in-place status line — a spinner, elapsed time, and an estimated
 *   reasoning-token count — so the user can see the model is actively working.
 *
 * The indicator owns ONLY a single status line drawn with a carriage return and
 * an erase-to-end-of-line escape; it never prints a trailing newline, so the
 * caller wipes it (hide()) before writing real content.
 */

/** Spinner frames (Braille dots) cycled by tick(). */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** Carriage return + erase to end of line — clears the current status line. */
const CLEAR_LINE = '\r\x1b[2K'

/**
 * Estimate reasoning tokens from a raw character count. DeepSeek/Qwen reasoning
 * traces mix CJK and ASCII; a blended ~3.2 chars/token ratio tracks observed
 * `reasoning_tokens` closely enough for a live gauge. Always shown with a `~`
 * prefix in the UI to signal it is approximate.
 */
export function estimateThinkingTokens(charCount: number): number {
  if (charCount <= 0) return 0
  return Math.max(1, Math.round(charCount / 3.2))
}

export interface ThinkingMeterOptions {
  /** Synchronous sink for the status line (defaults to process.stdout.write). */
  write?: (s: string) => void
  /** Clock injection for tests. */
  now?: () => number
  /** Master switch — when false every method is a no-op (non-TTY / JSON mode). */
  enabled?: boolean
  /** Whether to wrap the line in ANSI color codes. */
  color?: boolean
}

/**
 * Renders a single mutable status line. Lifecycle:
 *   show()            → start displaying (waiting state)
 *   note(deltaText)   → accumulate reasoning characters (updates the count)
 *   tick()            → advance the spinner; re-renders if visible
 *   hide()            → erase the line (call before writing real output)
 */
export class ThinkingMeter {
  private chars = 0
  private frame = 0
  private visible = false
  private startMs: number
  private readonly write: (s: string) => void
  private readonly now: () => number
  private readonly enabled: boolean
  private readonly color: boolean

  constructor(opts: ThinkingMeterOptions = {}) {
    this.write = opts.write ?? ((s: string) => void process.stdout.write(s))
    this.now = opts.now ?? (() => Date.now())
    this.enabled = opts.enabled ?? true
    this.color = opts.color ?? true
    this.startMs = this.now()
  }

  /** Total reasoning characters seen this turn. */
  get charCount(): number {
    return this.chars
  }

  /** Estimated reasoning tokens this turn. */
  get tokenEstimate(): number {
    return estimateThinkingTokens(this.chars)
  }

  /** Accumulate reasoning text (counting only — does not change visibility). */
  note(deltaText: string): void {
    if (!this.enabled || !deltaText) return
    this.chars += deltaText.length
    if (this.visible) this.render()
  }

  /** Begin showing the status line. */
  show(): void {
    if (!this.enabled) return
    this.visible = true
    this.render()
  }

  /** Advance the spinner one frame; re-render if currently visible. */
  tick(): void {
    if (!this.enabled || !this.visible) return
    this.frame = (this.frame + 1) % SPINNER_FRAMES.length
    this.render()
  }

  /** Erase the status line. Safe to call when already hidden. */
  hide(): void {
    if (!this.enabled || !this.visible) return
    this.visible = false
    this.write(CLEAR_LINE)
  }

  /** Build the status line string (no trailing newline). Exposed for tests. */
  render(): string {
    const spinner = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]!
    const secs = ((this.now() - this.startMs) / 1000).toFixed(1)
    const label =
      this.chars > 0
        ? `推理中 · ~${this.tokenEstimate} tokens · ${secs}s`
        : `等待模型响应… · ${secs}s`
    const dim = (s: string): string => (this.color ? `\x1b[2m${s}\x1b[0m` : s)
    const magenta = (s: string): string => (this.color ? `\x1b[35m${s}\x1b[0m` : s)
    const line = `${CLEAR_LINE}${magenta(spinner)} ${dim(label)}`
    if (this.enabled && this.visible) this.write(line)
    return line
  }
}
