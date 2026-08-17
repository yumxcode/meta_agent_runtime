/**
 * Minimal terminal key decoding.
 *
 * Deliberately not readline: readline owns stdin, rewrites the current line,
 * and fights a full-screen renderer for the cursor. A task view needs a handful
 * of keys and its own paint loop, so it decodes the byte stream itself.
 *
 * Pure on purpose — the decode table is where terminal bugs hide, so it is
 * testable without a tty.
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

/**
 * Decode one stdin chunk into keys.
 *
 * A chunk can hold several keypresses (fast typing, or a paste), and an escape
 * sequence can straddle chunk boundaries — an unterminated tail is reported as
 * 'escape' rather than being buffered, because for this UI a stray Escape is
 * harmless and a stuck parser is not.
 */
export function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = []
  let i = 0
  while (i < chunk.length) {
    const c = chunk[i]!

    if (c === ESC) {
      const next = chunk[i + 1]
      if (next === '[' || next === 'O') {
        const final = chunk[i + 2]
        i += 3
        switch (final) {
          case 'A': keys.push({ name: 'up' }); continue
          case 'B': keys.push({ name: 'down' }); continue
          case 'C': keys.push({ name: 'right' }); continue
          case 'D': keys.push({ name: 'left' }); continue
          case 'H': keys.push({ name: 'home' }); continue
          case 'F': keys.push({ name: 'end' }); continue
          // ESC [ 5 ~ / ESC [ 6 ~ — consume the trailing tilde too.
          case '5': i++; keys.push({ name: 'pageup' }); continue
          case '6': i++; keys.push({ name: 'pagedown' }); continue
          default: keys.push({ name: 'unknown' }); continue
        }
      }
      i++
      keys.push({ name: 'escape' })
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
  return keys
}
