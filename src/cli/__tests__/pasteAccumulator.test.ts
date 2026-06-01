import { describe, it, expect } from 'vitest'
import { PasteAccumulator } from '../pasteAccumulator.js'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * Simulate a bracketed paste: the terminal wraps the content in 200~/201~
 * markers and delivers it as one chunk; readline fires a 'line' for each
 * embedded newline and buffers the tail (which holds the closing marker).
 */
function bracketPaste(acc: PasteAccumulator, content: string): Array<string | null> {
  const chunk = PASTE_START + content + PASTE_END
  acc.onData(chunk)
  const completed = chunk.split('\n').slice(0, -1)
  return completed.map(line => acc.onLine(line))
}

/**
 * Helpers model how a terminal + readline feed the accumulator:
 *   - typing a line, then pressing Enter, arrives as a text chunk (no 'line'
 *     event yet) followed by a bare "\r" chunk that DOES fire 'line'.
 *   - a paste arrives as a single chunk whose embedded "\n" bytes each fire a
 *     'line' event, all classified against that same (non-bare) chunk.
 */

/** Simulate the user typing `text` then pressing Enter. Returns submit|null. */
function typeLine(acc: PasteAccumulator, text: string): string | null {
  // Keystrokes (no newline) don't fire 'line'; only record the Enter chunk.
  acc.onData('\r')
  return acc.onLine(text)
}

/**
 * Simulate pasting `chunk` (raw bytes incl. embedded newlines). Mirrors the
 * CLI wiring: onData(chunk) once, then onLine() for each line readline splits
 * out. Returns the array of per-line results (null = accumulated).
 */
function paste(acc: PasteAccumulator, chunk: string): Array<string | null> {
  acc.onData(chunk)
  // readline emits a 'line' for each completed line (text terminated by \n) and
  // buffers any tail after the last \n. Splitting on \n and dropping the final
  // segment yields exactly the completed lines for both "a\nb\n" → ["a","b"]
  // and "a\nb\nc" → ["a","b"] (with "c" left buffered).
  const completed = chunk.split('\n').slice(0, -1)
  return completed.map(line => acc.onLine(line))
}

describe('PasteAccumulator', () => {
  it('submits a single typed line on Enter', () => {
    const acc = new PasteAccumulator()
    expect(typeLine(acc, 'hello world')).toBe('hello world')
  })

  it('submits an empty line on a bare Enter', () => {
    const acc = new PasteAccumulator()
    expect(typeLine(acc, '')).toBe('')
  })

  it('does NOT auto-submit a single-line paste that ends in a newline', () => {
    const acc = new PasteAccumulator()
    // "deploy now\n" — the trailing \n is pasted, not a user Enter.
    const results = paste(acc, 'deploy now\n')
    expect(results).toEqual([null])
    // Nothing fired; only the user's explicit Enter submits it.
    expect(typeLine(acc, '')).toBe('deploy now')
  })

  it('does NOT auto-submit a multi-line paste ending in newline', () => {
    const acc = new PasteAccumulator()
    const results = paste(acc, 'a\nb\nc\n')
    expect(results).toEqual([null, null, null])
    // Explicit Enter flushes the whole block as ONE message.
    expect(typeLine(acc, '')).toBe('a\nb\nc')
  })

  it('merges paste-then-typed-tail into a single submission (the reported bug)', () => {
    const acc = new PasteAccumulator()
    // User pastes "a\nb\nc\n", pauses, then types "d" and presses Enter.
    expect(paste(acc, 'a\nb\nc\n')).toEqual([null, null, null])
    // Typing "d" then Enter — must NOT produce a second message; it joins.
    expect(typeLine(acc, 'd')).toBe('a\nb\nc\nd')
  })

  it('handles a paste with no trailing newline then a typed tail', () => {
    const acc = new PasteAccumulator()
    // "a\nb\nc" — readline emits "a","b" and buffers "c".
    expect(paste(acc, 'a\nb\nc')).toEqual([null, null])
    // User keeps typing on the buffered "c" line → "cd", then Enter.
    expect(typeLine(acc, 'cd')).toBe('a\nb\ncd')
  })

  it('clear() drops accumulated lines (Ctrl+C drain)', () => {
    const acc = new PasteAccumulator()
    paste(acc, 'a\nb\nc\n')
    acc.clear()
    // After clearing, a fresh Enter submits only what comes next.
    expect(typeLine(acc, 'fresh')).toBe('fresh')
  })

  it('drain() recovers a buffered paste at EOF, else returns null', () => {
    const acc = new PasteAccumulator()
    expect(acc.drain()).toBeNull()
    paste(acc, 'x\ny\n')
    expect(acc.drain()).toBe('x\ny')
    // Drained buffer is now empty.
    expect(acc.drain()).toBeNull()
  })

  it('resetChunk() prevents a stale chunk from being read as a bare Enter', () => {
    const acc = new PasteAccumulator()
    // Pretend a bare Enter arrived but was swallowed by the SIGINT drain window.
    acc.onData('\r')
    acc.resetChunk()
    // A line firing now must NOT be treated as a submit (stale chunk cleared).
    expect(acc.onLine('partial')).toBeNull()
  })

  it('treats a standalone CRLF chunk as a submit', () => {
    const acc = new PasteAccumulator()
    acc.onData('\r\n')
    expect(acc.onLine('typed')).toBe('typed')
  })

  // ── Bracketed paste mode (precise classification) ────────────────────────

  it('accumulates a bracketed multi-line paste and flushes on explicit Enter', () => {
    const acc = new PasteAccumulator()
    // Markers guarantee these newlines are pasted, not typed.
    expect(bracketPaste(acc, 'a\nb\nc\n')).toEqual([null, null, null])
    expect(typeLine(acc, '')).toBe('a\nb\nc')
  })

  it('bracketed paste with no trailing newline keeps the tail for the Enter', () => {
    const acc = new PasteAccumulator()
    // "a\nb\nc" → readline emits "a","b"; "c"+closing-marker stay buffered.
    expect(bracketPaste(acc, 'a\nb\nc')).toEqual([null, null])
    // The user's Enter fires the buffered tail line "c".
    expect(typeLine(acc, 'c')).toBe('a\nb\nc')
  })

  it('merges a bracketed paste with a later typed tail (the reported bug)', () => {
    const acc = new PasteAccumulator()
    expect(bracketPaste(acc, 'a\nb\nc\n')).toEqual([null, null, null])
    // Even after an arbitrary pause, typing "d" + Enter joins — no timer race.
    expect(typeLine(acc, 'd')).toBe('a\nb\nc\nd')
  })

  it('handles bracketed markers split across separate chunks', () => {
    const acc = new PasteAccumulator()
    acc.onData(PASTE_START)            // opening marker alone
    acc.onData('a\nb\nc')              // content arrives next (paste still open)
    expect(acc.onLine('a')).toBeNull()
    expect(acc.onLine('b')).toBeNull()
    acc.onData(PASTE_END)              // closing marker alone
    // "c" was buffered by readline; the user's Enter flushes the block.
    expect(typeLine(acc, 'c')).toBe('a\nb\nc')
  })

  it('does not treat a newline typed after a paste closes as pasted', () => {
    const acc = new PasteAccumulator()
    expect(bracketPaste(acc, 'one\n')).toEqual([null])
    // A normal typed line afterwards must submit the whole block, not accumulate.
    expect(typeLine(acc, 'two')).toBe('one\ntwo')
  })

  it('strips paste markers that leak into a line', () => {
    const acc = new PasteAccumulator()
    acc.onData(PASTE_START + 'hello' + PASTE_END)
    // If readline hands back the marker-laden buffer, it must be cleaned out.
    expect(typeLine(acc, PASTE_START + 'hello' + PASTE_END)).toBe('hello')
  })
})
