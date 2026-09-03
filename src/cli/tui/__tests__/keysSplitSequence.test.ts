/**
 * Reported on macOS: two-finger scrolling the report pane closed it and started
 * moving the task selection instead.
 *
 * Terminal.app and iTerm2 translate a trackpad scroll, in the alternate screen,
 * into a BURST of arrow-key sequences. Bursts get split across `read()`
 * boundaries, and the decoder used to resolve a chunk ending on the bare
 * `\x1b` of `\x1b[B` as a real Escape — which is the key that closes the
 * report. The `[B` opening the next chunk was then decoded as two characters,
 * and every arrow after it arrived in browse mode, where down means "select the
 * next task".
 *
 * The old comment justified this ("a stray Escape is harmless"), and it was —
 * until Escape started closing something.
 */
import { describe, expect, it } from 'vitest'
import { createKeyDecoder, decodeKeys } from '../keys.js'

const names = (keys: readonly { name: string }[]): string[] => keys.map(k => k.name)

describe('an escape sequence split across chunks', () => {
  it('survives a split between ESC and the rest', () => {
    const decoder = createKeyDecoder()
    expect(names(decoder.decode('\x1b'))).toEqual([])
    expect(decoder.hasPending()).toBe(true)
    expect(names(decoder.decode('[B'))).toEqual(['down'])
    expect(decoder.hasPending()).toBe(false)
  })

  it('survives a split between ESC[ and the final byte', () => {
    const decoder = createKeyDecoder()
    expect(names(decoder.decode('\x1b['))).toEqual([])
    expect(names(decoder.decode('A'))).toEqual(['up'])
  })

  it('survives a split inside the parameters of a tilde sequence', () => {
    const decoder = createKeyDecoder()
    expect(names(decoder.decode('\x1b[5'))).toEqual([])
    expect(names(decoder.decode('~'))).toEqual(['pageup'])
  })

  it('decodes a scroll burst split at an arbitrary point as pure arrows', () => {
    // What the trackpad actually produces: several sequences, one write, cut
    // wherever the pipe felt like it.
    const burst = '\x1b[B'.repeat(9)
    for (let cut = 1; cut < burst.length; cut++) {
      const decoder = createKeyDecoder()
      const keys = [
        ...decoder.decode(burst.slice(0, cut)),
        ...decoder.decode(burst.slice(cut)),
      ]
      expect(names(keys), `cut at ${cut}`).toEqual(Array(9).fill('down'))
      expect(decoder.hasPending(), `cut at ${cut}`).toBe(false)
    }
  })

  it('never turns the tail of a split sequence into typed characters', () => {
    // The `[` and `B` used to land in whatever text field was open.
    const decoder = createKeyDecoder()
    decoder.decode('\x1b')
    const keys = decoder.decode('[B')
    expect(keys.some(k => k.name === 'char')).toBe(false)
  })
})

describe('a real Escape keypress still works', () => {
  it('is held, then resolved by an explicit flush', () => {
    const decoder = createKeyDecoder()
    expect(names(decoder.decode('\x1b'))).toEqual([])
    expect(names(decoder.flush())).toEqual(['escape'])
    expect(decoder.hasPending()).toBe(false)
  })

  it('flushes to nothing when there is no held tail', () => {
    const decoder = createKeyDecoder()
    decoder.decode('j')
    expect(decoder.flush()).toEqual([])
  })

  it('does not become an Escape when the sequence merely never completed', () => {
    // A truncated CSI is not an Escape keypress; emitting one would close a
    // pane the operator never asked to close.
    const decoder = createKeyDecoder()
    decoder.decode('\x1b[1;5')
    expect(names(decoder.flush())).toEqual(['unknown'])
  })
})

describe('the CSI parser is a parser, not a fixed width', () => {
  it('handles modified arrows without emitting their parameters as text', () => {
    expect(names(decodeKeys('\x1b[1;5A'))).toEqual(['up'])
    expect(names(decodeKeys('\x1b[1;2B'))).toEqual(['down'])
  })

  it('handles a long sequence without desynchronising the rest of the chunk', () => {
    // The old `i += 3` left `00~j` behind, typing `0`, `0`, `~` into the UI.
    expect(names(decodeKeys('\x1b[200~j'))).toEqual(['unknown', 'char'])
  })

  it('maps the navigation family', () => {
    expect(names(decodeKeys('\x1b[5~\x1b[6~\x1b[3~\x1b[1~\x1b[4~'))).toEqual(
      ['pageup', 'pagedown', 'delete', 'home', 'end'],
    )
  })

  it('consumes both bytes of an Alt+key so the letter is not typed', () => {
    // `\x1bd` is Alt+d; the `d` used to arrive as a plain character, which in
    // browse mode is one row away from the destructive keys.
    const keys = decodeKeys('\x1bd')
    expect(names(keys)).toEqual(['unknown'])
    expect(keys.some(k => k.ch === 'd')).toBe(false)
  })
})
