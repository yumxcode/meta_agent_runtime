import { describe, expect, it } from 'vitest'
import { sanitizeTerminalPreview, sanitizeTerminalText, TerminalSanitizer } from '../terminalSanitizer.js'

describe('terminalSanitizer', () => {
  it('strips OSC and CSI sequences', () => {
    expect(sanitizeTerminalText('a\x1b]0;bad title\x07b\x1b[31mc')).toBe('abc')
  })

  it('strips OSC sequences split across stream chunks', () => {
    const sanitizer = new TerminalSanitizer()
    expect(sanitizer.sanitize('before \x1b]52;c;AAAA')).toBe('before ')
    expect(sanitizer.sanitize('BBBB\x07 after')).toBe(' after')
  })

  it('strips DCS-style ST-terminated strings split across chunks', () => {
    const sanitizer = new TerminalSanitizer()
    expect(sanitizer.sanitize('x\x1bPpayload')).toBe('x')
    expect(sanitizer.sanitize('more\x1b\\y')).toBe('y')
  })

  it('strips 8-bit C1 CSI/OSC/DCS-style controls', () => {
    expect(sanitizeTerminalText('a\u009b31mb\u009d0;title\u009cc\u0090payload\u009cd')).toBe('abcd')
  })

  it('keeps ordinary whitespace but removes other control bytes', () => {
    expect(sanitizeTerminalText('a\tb\nc\rd\x00e\x7ff')).toBe('a\tb\nc\ndef')
  })

  it('builds single-line previews after sanitizing', () => {
    expect(sanitizeTerminalPreview('a\n\x1b]8;;url\x07link\x1b]8;;\x07 b', 20)).toBe('a link b')
  })
})
