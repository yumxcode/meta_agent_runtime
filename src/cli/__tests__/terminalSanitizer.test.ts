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

  // ── W11: CRLF is one line break, a bare CR is a progress redraw ──────────
  //
  // Mapping CR→LF and then also emitting the LF double-spaced every CRLF line.
  // On Windows every child process emits CRLF, so ALL tool output rendered
  // double-spaced.
  describe('newline normalisation', () => {
    it('treats CRLF as a single newline', () => {
      expect(sanitizeTerminalText('line1\r\nline2\r\n')).toBe('line1\nline2\n')
    })

    it('leaves LF-only text unchanged', () => {
      expect(sanitizeTerminalText('line1\nline2\n')).toBe('line1\nline2\n')
    })

    it('still turns a bare CR (progress redraw) into a newline', () => {
      expect(sanitizeTerminalText('50%\r100%')).toBe('50%\n100%')
    })

    it('handles a CRLF split across chunks', () => {
      const sanitizer = new TerminalSanitizer()
      expect(sanitizer.sanitize('line1\r')).toBe('line1\n')
      expect(sanitizer.sanitize('\nline2')).toBe('line2')
    })

    it('does not swallow a newline that merely follows a CR-terminated redraw', () => {
      // CR, then real content, then a genuine newline — the LF must survive.
      expect(sanitizeTerminalText('50%\rdone\n')).toBe('50%\ndone\n')
    })

    it('handles repeated CRLF without collapsing blank lines', () => {
      expect(sanitizeTerminalText('a\r\n\r\nb')).toBe('a\n\nb')
    })
  })

  // ── T1: runaway-sequence recovery ────────────────────────────────────────
  //
  // OSC / DCS terminate only on BEL, ST or 0x9C — bytes that essentially never
  // occur in ordinary text. streamPrompt keeps ONE sanitizer for a whole turn,
  // so before the length cap a single unterminated `\x1b]` swallowed every
  // remaining character of that turn: the agent went silent mid-sentence while
  // the spinner kept turning. The bash tool's own output truncation can cut a
  // window-title sequence in half and produce exactly this input.
  describe('recovers from an unterminated control sequence', () => {
    it('resumes output after an unterminated OSC exceeds the cap', () => {
      const sanitizer = new TerminalSanitizer()
      expect(sanitizer.sanitize('build ok\x1b]0;my-title')).toBe('build ok')
      // A short follow-up chunk is still swallowed — we are inside the bounded
      // sequence and have not spent the budget yet.
      expect(sanitizer.sanitize('line A\nline B\n')).toBe('')
      // Once the budget is spent the sanitizer gives up on the sequence.
      // Assert the property (output resumes), not the exact byte at which the
      // counter trips — that would just re-encode the constant.
      sanitizer.sanitize('x'.repeat(4096))
      expect(sanitizer.sanitize('the final answer is 42\n')).toBe('the final answer is 42\n')
    })

    it('recovers from a stray C1 introducer', () => {
      const sanitizer = new TerminalSanitizer()
      expect(sanitizer.sanitize('')).toBe('')
      expect(sanitizer.sanitize('y'.repeat(5000))).toContain('y')
    })

    it('recovers from an unterminated DCS string', () => {
      const sanitizer = new TerminalSanitizer()
      expect(sanitizer.sanitize('a\x1bPnever-ends')).toBe('a')
      expect(sanitizer.sanitize('z'.repeat(5000))).toContain('z')
    })

    it('still strips a legitimate long-but-bounded OSC in full', () => {
      const sanitizer = new TerminalSanitizer()
      // An OSC-8 hyperlink with a long URL is well under the cap and must be
      // removed completely, not partially emitted.
      const url = 'https://example.com/' + 'p'.repeat(500)
      expect(sanitizer.sanitize(`see \x1b]8;;${url}\x07link\x1b]8;;\x07 end`))
        .toBe('see link end')
    })

    it('gives each new sequence a fresh budget', () => {
      const sanitizer = new TerminalSanitizer()
      for (let i = 0; i < 5; i++) {
        expect(sanitizer.sanitize(`\x1b]0;title-${i}\x07ok${i} `)).toBe(`ok${i} `)
      }
    })
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
