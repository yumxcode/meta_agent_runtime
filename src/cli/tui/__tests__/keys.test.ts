/**
 * Key decoding. The two that matter operationally:
 *
 *  - Ctrl+C must decode, because raw mode stops the tty from raising SIGINT and
 *    a viewer you cannot quit strands the terminal.
 *  - A chunk can carry several keypresses; dropping the tail loses keystrokes
 *    under fast typing or a paste.
 */
import { describe, expect, it } from 'vitest'
import { decodeKeys } from '../keys.js'

const names = (chunk: string): string[] => decodeKeys(chunk).map(k => k.name)

describe('decodeKeys', () => {
  it('decodes arrow keys in both CSI and SS3 forms', () => {
    expect(names('\x1b[A\x1b[B')).toEqual(['up', 'down'])
    expect(names('\x1bOA')).toEqual(['up'])
  })

  it('decodes Ctrl+C — raw mode never raises SIGINT for us', () => {
    expect(names('\x03')).toEqual(['ctrl-c'])
    expect(names('\x04')).toEqual(['ctrl-d'])
  })

  it('decodes enter, backspace and escape', () => {
    expect(names('\r')).toEqual(['enter'])
    expect(names('\n')).toEqual(['enter'])
    expect(names('\x7f')).toEqual(['backspace'])
    expect(names('\x1b')).toEqual(['escape'])
  })

  it('consumes the trailing tilde of page up/down', () => {
    expect(names('\x1b[5~\x1b[6~')).toEqual(['pageup', 'pagedown'])
  })

  it('splits a chunk carrying several keypresses', () => {
    const keys = decodeKeys('jk\x1b[Aq')
    expect(keys.map(k => k.name)).toEqual(['char', 'char', 'up', 'char'])
    expect(keys.map(k => k.ch).filter(Boolean)).toEqual(['j', 'k', 'q'])
  })

  it('passes multi-byte characters through as single chars', () => {
    const keys = decodeKeys('继续')
    expect(keys).toHaveLength(2)
    expect(keys[0]?.ch).toBe('继')
  })

  it('never emits a control byte as typeable text', () => {
    for (const key of decodeKeys('\x01\x02\x1a')) {
      expect(key.name).toBe('unknown')
      expect(key.ch).toBeUndefined()
    }
  })
})
