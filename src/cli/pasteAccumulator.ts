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

export class PasteAccumulator {
  private lines: string[] = []
  private lastChunk = ''
  /** True while the byte stream is between a 200~ and a 201~ marker. */
  private pasteOpen = false
  /** True if the chunk behind the pending 'line' event(s) is pasted content. */
  private chunkIsPaste = false
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
  onData(chunk: string): void {
    // Re-attach any partial-marker bytes carried over from the previous chunk so
    // a marker split across a stdin read boundary is still recognised, then hold
    // back a fresh partial-marker tail (if any) for the next chunk.
    const buf = this.carry + chunk
    const carryLen = PasteAccumulator.trailingPartialMarkerLen(buf)
    const scan = carryLen > 0 ? buf.slice(0, buf.length - carryLen) : buf
    this.carry = carryLen > 0 ? buf.slice(buf.length - carryLen) : ''

    // A chunk's lines are pasted if a paste was already open OR this chunk opens
    // one (markers and content can arrive together or split across chunks).
    this.chunkIsPaste = this.pasteOpen || scan.includes(PASTE_START)
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
    // A bare Enter on an EMPTY line, when content is already buffered, is just
    // the submit keystroke terminating a newline-terminated paste — the empty
    // line is the trigger, not content, so flush without appending it. (A bare
    // Enter with nothing buffered is a genuine empty-message submit.)
    if (isBareEnter && line === '' && this.lines.length > 0) {
      return this.flush()
    }
    this.lines.push(line)
    if (!isBareEnter) return null
    return this.flush()
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
  }

  /**
   * Return any accumulated-but-unsubmitted lines as a single message, or null
   * when nothing is buffered. Used on readline 'close' so a paste left in the
   * buffer at EOF (Ctrl+D) is not silently lost.
   */
  drain(): string | null {
    if (this.lines.length === 0) return null
    return this.flush()
  }

  private flush(): string {
    const combined = this.lines.join('\n')
    this.lines.length = 0
    return combined
  }
}
