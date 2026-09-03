/**
 * Minimal terminal key decoding.
 *
 * Deliberately not readline: readline owns stdin, rewrites the current line,
 * and fights a full-screen renderer for the cursor. A task view needs a handful
 * of keys and its own paint loop, so it decodes the byte stream itself.
 *
 * Pure on purpose — the decode table is where terminal bugs hide, so it is
 * testable without a tty.
 *
 * ## Why an escape sequence may NOT be split into ESC + garbage
 *
 * This module used to say that an unterminated tail was reported as `escape`
 * "because for this UI a stray Escape is harmless and a stuck parser is not".
 * The first half stopped being true the moment Escape started closing the
 * report pane, and macOS made the second half routine rather than theoretical:
 *
 * Terminal.app and iTerm2 translate a trackpad two-finger scroll, in the
 * alternate screen, into a BURST of arrow-key sequences (roughly three per
 * notch). Bursts get split across `read()` boundaries, and a chunk that ends
 * mid-sequence — on the bare `\x1b` of `\x1b[B` — was decoded as:
 *
 *     [escape]                 → the report pane closed
 *     [char '['] [char 'B']    → ignored
 *     [down] [down] [down] …   → arriving in BROWSE mode, so they moved the
 *                                task selection instead of scrolling
 *
 * which is exactly what "scrolling the report jumps to another task" looks
 * like. The parser now carries an incomplete tail to the next chunk. A genuine
 * lone Escape keypress is indistinguishable from the head of a split sequence,
 * so the holder needs a deadline; `createKeyDecoder` exposes `flush()` and the
 * caller arms a short timer (see TaskTui). A real terminal never splits a
 * sequence unless it is under burst load, in which case the next chunk is
 * already on its way.
 *
 * The CSI parser is also a real one now — parameter bytes, intermediates, then
 * a final byte — instead of assuming every sequence is exactly three bytes.
 * The fixed-width assumption desynchronised on anything longer (`\x1b[1;5A`,
 * `\x1b[200~`, an SGR mouse report) and emitted its remainder as typed
 * characters.
 */

export interface Key {
  /** 'up' | 'down' | 'enter' | 'escape' | 'backspace' | 'ctrl-c' | 'char' | … */
  name: string
  /** The literal character, for `name === 'char'`. */
  ch?: string
}

const ESC = '\x1b'
const ETX = '\x03'   // Ctrl+C
const EOT = '\x04'   // Ctrl+D
const DEL = '\x7f'

/** CSI final byte: `@`–`~`. Everything before it is parameters/intermediates. */
function isFinalByte(ch: string | undefined): boolean {
  if (!ch) return false
  const code = ch.charCodeAt(0)
  return code >= 0x40 && code <= 0x7e
}

/** CSI parameter (`0`–`?`) or intermediate (space–`/`) byte. */
function isParamOrIntermediate(ch: string | undefined): boolean {
  if (!ch) return false
  const code = ch.charCodeAt(0)
  return (code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)
}

/** Arrow/home/end finals, shared by CSI and SS3. */
function cursorKey(final: string): Key | null {
  switch (final) {
    case 'A': return { name: 'up' }
    case 'B': return { name: 'down' }
    case 'C': return { name: 'right' }
    case 'D': return { name: 'left' }
    case 'H': return { name: 'home' }
    case 'F': return { name: 'end' }
    default: return null
  }
}

/** `ESC [ <params> ~` — the numeric keypad/navigation family. */
function tildeKey(params: string): Key {
  // Modifiers arrive as `5;2~`; only the first parameter names the key.
  switch (params.split(';')[0]) {
    case '1':
    case '7': return { name: 'home' }
    case '4':
    case '8': return { name: 'end' }
    case '3': return { name: 'delete' }
    case '5': return { name: 'pageup' }
    case '6': return { name: 'pagedown' }
    default: return { name: 'unknown' }
  }
}

interface Decoded {
  keys: Key[]
  /** Trailing bytes that are the start of a sequence we have not seen the end of. */
  pending: string
}

function decode(input: string): Decoded {
  const keys: Key[] = []
  let i = 0
  while (i < input.length) {
    const c = input[i]!

    if (c === ESC) {
      const next = input[i + 1]
      if (next === undefined) return { keys, pending: input.slice(i) }

      if (next === '[') {
        let j = i + 2
        while (j < input.length && isParamOrIntermediate(input[j])) j++
        const final = input[j]
        if (!isFinalByte(final)) return { keys, pending: input.slice(i) }
        const params = input.slice(i + 2, j)
        const cursor = cursorKey(final!)
        keys.push(cursor ?? (final === '~' ? tildeKey(params) : { name: 'unknown' }))
        i = j + 1
        continue
      }

      if (next === 'O') {
        const final = input[i + 2]
        if (final === undefined) return { keys, pending: input.slice(i) }
        keys.push(cursorKey(final) ?? { name: 'unknown' })
        i += 3
        continue
      }

      // ESC followed by an ordinary byte: Alt+key on most terminals. Not bound
      // here, but it must consume BOTH bytes — leaving the second to be decoded
      // as a char is how Alt+d used to arrive as a plain `d`.
      keys.push({ name: 'unknown' })
      i += 2
      continue
    }

    // In raw mode the tty no longer turns ^C into SIGINT — it delivers the
    // byte. A UI that does not handle this is a UI you cannot quit.
    if (c === ETX) { keys.push({ name: 'ctrl-c' }); i++; continue }
    if (c === EOT) { keys.push({ name: 'ctrl-d' }); i++; continue }
    if (c === '\r' || c === '\n') { keys.push({ name: 'enter' }); i++; continue }
    if (c === DEL || c === '\b') { keys.push({ name: 'backspace' }); i++; continue }
    if (c === '\t') { keys.push({ name: 'tab' }); i++; continue }
    if (c < ' ') { keys.push({ name: 'unknown' }); i++; continue }

    keys.push({ name: 'char', ch: c })
    i++
  }
  return { keys, pending: '' }
}

/**
 * Decode one stdin chunk, with no memory between calls.
 *
 * An incomplete trailing sequence is resolved immediately: a bare `\x1b` is
 * Escape, and a truncated CSI is dropped. Correct for a chunk known to be
 * whole; use `createKeyDecoder()` for a live stdin stream, where it is not.
 */
export function decodeKeys(chunk: string): Key[] {
  const { keys, pending } = decode(chunk)
  return pending ? [...keys, ...flushPending(pending)] : keys
}

/** Resolve a held tail once we have decided nothing more is coming. */
function flushPending(pending: string): Key[] {
  // A lone ESC is the Escape key. Anything longer was a real sequence whose
  // end never arrived — emitting its bytes as characters would type `[B` into
  // a filter box, so it is dropped as one unknown key.
  return pending === ESC ? [{ name: 'escape' }] : [{ name: 'unknown' }]
}

/** Stateful decoder for a live stdin stream. See the header for why. */
export interface KeyDecoder {
  /** Decode a chunk; an incomplete trailing sequence is held for the next one. */
  decode(chunk: string): Key[]
  /** True while a partial sequence is held — the caller should arm a deadline. */
  hasPending(): boolean
  /** Resolve the held tail (deadline expired). Empty when nothing is held. */
  flush(): Key[]
}

export function createKeyDecoder(): KeyDecoder {
  let pending = ''
  return {
    decode(chunk: string): Key[] {
      const result = decode(pending + chunk)
      pending = result.pending
      return result.keys
    },
    hasPending: (): boolean => pending !== '',
    flush(): Key[] {
      if (!pending) return []
      const held = pending
      pending = ''
      return flushPending(held)
    },
  }
}
