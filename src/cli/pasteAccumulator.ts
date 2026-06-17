/**
 * PasteAccumulator — distinguishes a user-pressed Enter from a newline that is
 * merely *embedded inside pasted text*, so a multi-line paste is collected into
 * a single prompt instead of being submitted line-by-line.
 *
 * Primary mechanism — bracketed paste mode (precise):
 *   When the CLI enables bracketed paste (writes ESC[?2004h to the terminal),
 *   the terminal wraps every paste in two control sequences:
 *       ESC[200~   <pasted bytes, newlines intact>   ESC[201~
 *   This is a protocol-level guarantee from the terminal that "these bytes were
 *   pasted, not typed", so any 'line' event that fires while we are between a
 *   200~ and a 201~ marker is unambiguously a pasted line and is accumulated.
 *   The user's eventual Enter to submit arrives AFTER the closing marker as its
 *   own bare chunk, which is what flushes the accumulated block.
 *
 * Fallback mechanism — bare-Enter heuristic:
 *   Terminals/multiplexers that don't support bracketed paste send no markers.
 *   For them we fall back to inspecting the raw stdin chunk that triggered the
 *   'line' event: a chunk that is purely \r / \n can only be a user Enter, so it
 *   submits; a chunk that also contains text means its newline was pasted, so we
 *   accumulate. This is best-effort (a chunk boundary can theoretically split a
 *   paste across packets) but bracketed paste covers the precise case.
 *
 * Why this exists (the bug it fixes):
 *   A terminal delivers pasted text to stdin as data chunks whose internal \n
 *   bytes look identical to the \n from pressing Enter, so readline fires a
 *   'line' event for each. An earlier implementation regrouped these with a
 *   300 ms debounce that auto-submitted a paste ending in \n. That timer raced
 *   the user: pausing >300 ms after a paste then typing more submitted the paste
 *   on its own and the typed tail as a SECOND message — the "it replied before I
 *   hit Enter / it auto-replied twice" symptom, plus garbled streaming over a
 *   half-edited input line. Marker- and Enter-based classification removes the
 *   timing dependency entirely.
 *
 * Usage contract (wired in src/cli/index.ts):
 *   - Enable bracketed paste on the terminal (ESC[?2004h) while interactive and
 *     disable it (ESC[?2004l) on exit.
 *   - Call onData(chunk) from a stdin 'data' listener that is *prepended* so it
 *     runs before readline's own handler — this records the raw chunk (and its
 *     paste markers) before the resulting 'line' event(s) fire.
 *   - Call onLine(rawLine) from readline's 'line' event. A non-null return is a
 *     complete message ready to submit; null means "keep waiting for Enter".
 *   - Call clear() to drop buffered lines (e.g. on Ctrl+C drain).
 *   - Call drain() on readline 'close' to recover any unsubmitted tail.
 */

/** Terminal escape sequences for bracketed paste mode. */
export const BRACKETED_PASTE_ENABLE = '\x1b[?2004h'
export const BRACKETED_PASTE_DISABLE = '\x1b[?2004l'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
/** Matches either bracketed-paste marker, for stripping from raw input. */
const PASTE_MARKER_RE = /\x1b\[20[01]~/g

/**
 * Options for the fallback coalesce window. Only relevant to terminals that do
 * NOT support bracketed paste (no 200~/201~ markers); see onLine() for why.
 */
export interface PasteAccumulatorOptions {
  /**
   * Milliseconds to wait, in MARKERLESS fallback mode only, before honouring a
   * bare-Enter flush — long enough to absorb a paste-internal newline that the
   * terminal happened to deliver as its own stdin chunk (which would otherwise
   * split one paste into two messages). 0 (default) disables the window and
   * keeps onLine() fully synchronous (legacy behaviour). The bracketed-paste
   * and ordinary-typing paths are NEVER deferred regardless of this value.
   */
  coalesceMs?: number
  /**
   * Called when a deferred fallback flush actually fires (after coalesceMs with
   * no further input). Required for the window to do anything — the CLI routes
   * this to the same submit handler as a synchronous onLine() result.
   */
  onDeferredSubmit?: (message: string) => void
  /** Injectable timer (tests). Defaults to setTimeout/clearTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

export interface PasteDataInfo {
  /** True when this raw stdin chunk is paste content, not ordinary typing. */
  isPaste: boolean
  /** Marker-free text content from the chunk, used only for paste display stats. */
  text: string
  /** Classification detail for UI decisions; submission semantics use isPaste. */
  source: 'none' | 'bracketed' | 'markerless-multiline' | 'markerless-bare-newline'
}

export class PasteAccumulator {
  private lines: string[] = []
  private lastChunk = ''
  /** True while the byte stream is between a 200~ and a 201~ marker. */
  private pasteOpen = false
  /** True if the chunk behind the pending 'line' event(s) is pasted content. */
  private chunkIsPaste = false
  /**
   * True once ANY bracketed-paste marker has been seen this session. When true
   * the terminal supports bracketed paste, so paste boundaries are precise and
   * the fallback coalesce window is unnecessary (and never armed).
   */
  private markerSeen = false

  private readonly coalesceMs: number
  private readonly onDeferredSubmit?: (message: string) => void
  private readonly schedule: (fn: () => void, ms: number) => unknown
  private readonly cancel: (handle: unknown) => void
  /** Pending deferred-flush timer handle, or null when none is armed. */
  private pendingTimer: unknown = null

  constructor(options: PasteAccumulatorOptions = {}) {
    this.coalesceMs = options.coalesceMs ?? 0
    this.onDeferredSubmit = options.onDeferredSubmit
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.cancel = options.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }
  /**
   * Trailing bytes held back from the previous chunk because they form the
   * *start* of a paste marker that may complete in the next chunk. A large
   * paste is delivered as several stdin reads, and a 6-byte marker can land on
   * a read boundary (e.g. "\x1b[20" | "1~"). Without re-joining the halves the
   * indexOf() scan never sees the marker, so `pasteOpen` would stick `true`
   * forever and every later line would be silently accumulated — a frozen REPL.
   */
  private carry = ''

  /**
   * Length of the longest suffix of `buf` that is a *partial* (incomplete)
   * paste marker — i.e. the bytes to hold back for the next chunk. Only the
   * region after the last COMPLETE marker is eligible, so a fully-delivered
   * marker is never mistaken for a partial one.
   */
  private static trailingPartialMarkerLen(buf: string): number {
    let afterLastComplete = 0
    for (const marker of [PASTE_START, PASTE_END]) {
      const idx = buf.lastIndexOf(marker)
      if (idx >= 0) afterLastComplete = Math.max(afterLastComplete, idx + marker.length)
    }
    const residual = buf.slice(afterLastComplete)
    const max = Math.min(PASTE_START.length - 1, residual.length)
    for (let len = max; len > 0; len--) {
      const suffix = residual.slice(residual.length - len)
      if (PASTE_START.startsWith(suffix) || PASTE_END.startsWith(suffix)) return len
    }
    return 0
  }

  /** Record the raw stdin chunk preceding the next 'line' event(s). */
  onData(chunk: string): PasteDataInfo {
    // A fresh chunk means the previous bare-Enter (if we deferred it) was really
    // a paste-internal newline split across reads — cancel the pending flush so
    // the buffered lines keep accumulating instead of submitting early.
    this.cancelPendingTimer()
    // Re-attach any partial-marker bytes carried over from the previous chunk so
    // a marker split across a stdin read boundary is still recognised, then hold
    // back a fresh partial-marker tail (if any) for the next chunk.
    const buf = this.carry + chunk
    const carryLen = PasteAccumulator.trailingPartialMarkerLen(buf)
    const scan = carryLen > 0 ? buf.slice(0, buf.length - carryLen) : buf
    this.carry = carryLen > 0 ? buf.slice(buf.length - carryLen) : ''
    // Reassembled buffer reveals markers even when split across reads; once seen,
    // the terminal supports bracketed paste so the coalesce window stays off.
    const markerInBuf = buf.includes(PASTE_START) || buf.includes(PASTE_END)
    if (markerInBuf) this.markerSeen = true

    // A chunk's lines are pasted if a paste was already open OR this chunk opens
    // one (markers and content can arrive together or split across chunks).
    const wasPasteOpen = this.pasteOpen
    this.chunkIsPaste = wasPasteOpen || scan.includes(PASTE_START)
    // Walk the markers in order to compute the open/closed state for the chunks
    // that follow this one.
    let i = 0
    while (i < scan.length) {
      const start = scan.indexOf(PASTE_START, i)
      const end = scan.indexOf(PASTE_END, i)
      if (start === -1 && end === -1) break
      if (end === -1 || (start !== -1 && start < end)) {
        this.pasteOpen = true
        i = start + PASTE_START.length
      } else {
        this.pasteOpen = false
        i = end + PASTE_END.length
      }
    }
    // Keep a marker-free copy so the bare-Enter fallback test isn't fooled by
    // a lone marker sharing the chunk with the newline.
    this.lastChunk = scan.replace(PASTE_MARKER_RE, '')
    const markerlessMultilinePaste =
      !this.markerSeen &&
      /[^\r\n]/.test(this.lastChunk) &&
      /[\r\n]/.test(this.lastChunk)
    const markerlessBareNewlineAfterBufferedPaste =
      !this.markerSeen &&
      this.lines.length > 0 &&
      /^[\r\n]+$/.test(this.lastChunk)
    const source = this.chunkIsPaste
      ? 'bracketed'
      : markerlessMultilinePaste
        ? 'markerless-multiline'
        : markerlessBareNewlineAfterBufferedPaste
          ? 'markerless-bare-newline'
          : 'none'
    return {
      isPaste: source !== 'none',
      text: this.lastChunk,
      source,
    }
  }

  /**
   * Reset only the transient chunk markers — used when an input-drain window
   * (e.g. after SIGINT) swallows a chunk so a later real Enter isn't
   * misclassified against stale chunk data.
   */
  resetChunk(): void {
    this.lastChunk = ''
    this.chunkIsPaste = false
    this.carry = ''
    this.cancelPendingTimer()
  }

  /**
   * Feed a readline 'line'. Returns the combined message to submit, or null to
   * accumulate and keep waiting for the user's Enter.
   */
  onLine(rawLine: string): string | null {
    const line = rawLine.replace(PASTE_MARKER_RE, '')
    // Bracketed paste: this line came from inside a paste region → accumulate.
    if (this.chunkIsPaste) {
      this.lines.push(line)
      return null
    }
    // Fallback: a chunk that is purely \r / \n is a user Enter.
    const isBareEnter = /^[\r\n]+$/.test(this.lastChunk)
    // Count buffered lines BEFORE this one: a bare-Enter flush is only ambiguous
    // (could be a paste-internal newline) when content was already accumulated
    // from earlier chunks. A bare Enter with nothing buffered is an unambiguous
    // single-line/empty submit and is never deferred.
    const priorLines = this.lines.length
    // A bare Enter on an EMPTY line, when content is already buffered, is just
    // the submit keystroke terminating a newline-terminated paste — the empty
    // line is the trigger, not content, so flush without appending it.
    if (isBareEnter && line === '' && priorLines > 0) {
      return this.maybeDeferFlush()
    }
    this.lines.push(line)
    if (!isBareEnter) return null
    // Bare Enter that carried content: defer only when earlier content existed
    // (the split-paste risk); a lone typed line (priorLines === 0) flushes now.
    if (priorLines > 0) return this.maybeDeferFlush()
    return this.flush()
  }

  /**
   * In markerless fallback mode with a coalesce window configured, hold the
   * flush for coalesceMs so a paste-internal newline delivered as its own chunk
   * doesn't split the paste; the next onData() cancels it. Otherwise (bracketed
   * terminal, or window disabled) flush synchronously as before.
   */
  private maybeDeferFlush(): string | null {
    if (this.coalesceMs > 0 && !this.markerSeen && this.onDeferredSubmit) {
      this.armDeferredFlush()
      return null
    }
    return this.flush()
  }

  private armDeferredFlush(): void {
    this.cancelPendingTimer()
    this.pendingTimer = this.schedule(() => {
      this.pendingTimer = null
      const combined = this.flush()
      this.onDeferredSubmit?.(combined)
    }, this.coalesceMs)
  }

  private cancelPendingTimer(): void {
    if (this.pendingTimer !== null) {
      this.cancel(this.pendingTimer)
      this.pendingTimer = null
    }
  }

  /**
   * True while input is still being collected — either lines are buffered, a
   * bracketed-paste region is open, or the chunk behind the pending line(s) is
   * pasted content. The CLI uses this to blank readline's `you ›` prompt so the
   * trailing partial line of a multi-line paste doesn't get the prompt
   * re-prepended on redraw (a purely cosmetic "second prompt" artifact).
   */
  get buffering(): boolean {
    return this.lines.length > 0 || this.pasteOpen || this.chunkIsPaste
  }

  /** Discard all accumulated lines and paste state without submitting. */
  clear(): void {
    this.lines.length = 0
    this.pasteOpen = false
    this.chunkIsPaste = false
    this.carry = ''
    this.cancelPendingTimer()
  }

  /**
   * Return any accumulated-but-unsubmitted lines as a single message, or null
   * when nothing is buffered. Used on readline 'close' so a paste left in the
   * buffer at EOF (Ctrl+D) is not silently lost.
   */
  drain(): string | null {
    this.cancelPendingTimer()
    if (this.lines.length === 0) return null
    return this.flush()
  }

  private flush(): string {
    const combined = this.lines.join('\n')
    this.lines.length = 0
    return combined
  }
}
