/**
 * Terminal output sanitizer for untrusted model/tool text.
 *
 * The CLI owns its own ANSI colour/status sequences, but text originating from
 * models, tools, web pages, files, or persisted session previews must not be
 * allowed to drive the user's terminal.  In particular, macOS Terminal is
 * sensitive to malformed or very long OSC/DCS/CSI sequences in scrollback.
 */

type State = 'normal' | 'esc' | 'csi' | 'osc' | 'oscEsc' | 'stString' | 'stEsc'

/**
 * Maximum characters consumed inside one control sequence before we give up and
 * treat it as noise.
 *
 * T1: without this the state machine could never leave `osc` / `stString`. Their
 * only terminators are BEL, ST (`ESC \`) and 0x9C — bytes that essentially never
 * occur in ordinary text — so ONE unterminated `\x1b]` swallowed every
 * subsequent character. That mattered because streamPrompt keeps a single
 * sanitizer for the whole turn (deliberately, so a sequence split across chunks
 * still gets stripped): the agent would go silent mid-sentence while the spinner
 * kept turning and tools kept running, with no way to tell why.
 *
 * The trigger surface is wide (binary output, curl progress, tmux passthrough, a
 * stray 0x9D from mis-decoded latin-1) and we manufacture it ourselves: the bash
 * tool truncates at an exact character count, which can cut `\x1b]0;title\x07`
 * in half and guarantee an unterminated OSC.
 *
 * 4096 is far above any legitimate sequence — window titles and OSC-8 hyperlinks
 * are tens to low hundreds of characters — and far below the point where losing
 * the run costs the user anything. Real terminals bound these the same way.
 */
const MAX_SEQUENCE_CHARS = 4096

/**
 * Characters that change how text READS without being control sequences.
 *
 * The state machine above strips everything that drives the terminal; these
 * drive the *reader* instead. U+202A–202E and U+2066–2069 reorder the glyphs
 * around them (the "Trojan Source" trick), so a tool-call preview can be made
 * to display a command that is not the one about to run — and that preview line
 * is exactly what the operator approves from. U+200B–200F and U+FEFF are
 * invisible: they hide differences between two strings that look identical.
 *
 * Both classes are legitimate in real prose, but nothing the CLI renders is
 * prose that needs them, and neither survives a copy-paste review either.
 * Dropped outright rather than replaced, so the visible text is what remains.
 */
function isTextDirectionOrInvisible(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) ||  // ZWSP … RLM
    (code >= 0x202a && code <= 0x202e) ||  // LRE RLE PDF LRO RLO
    (code >= 0x2066 && code <= 0x2069) ||  // LRI RLI FSI PDI
    code === 0xfeff                        // BOM / zero-width no-break space
  )
}

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e
}

function isC0Control(code: number): boolean {
  return code >= 0x00 && code <= 0x1f
}

function isC1Control(code: number): boolean {
  return code >= 0x80 && code <= 0x9f
}

export class TerminalSanitizer {
  private state: State = 'normal'
  /** Characters consumed since the current control sequence started. */
  private sequenceChars = 0
  /**
   * True when the previous emitted character was a CR that we turned into a
   * newline, so an immediately following LF must be swallowed.
   *
   * W11: a bare CR is a progress-bar redraw and becomes '\n' (showing each
   * update on its own line beats letting it overwrite). But CRLF is ONE line
   * break, and mapping the CR and then also emitting the LF double-spaced every
   * line. On Linux/macOS that only showed up on the occasional CRLF file; on
   * Windows every child process emits CRLF, so the entire terminal — all tool
   * output, all pasted logs — would render double-spaced.
   *
   * The flag lives on the instance because streamPrompt keeps one sanitizer per
   * turn and a CRLF can straddle two chunks.
   */
  private pendingCr = false

  /**
   * Enter a control-sequence state, resetting the overflow counter.
   * `normal` is the only state that is not part of a sequence.
   */
  private enter(state: State): void {
    this.state = state
    if (state === 'normal') this.sequenceChars = 0
    // A control sequence between the CR and the LF means they were not a CRLF
    // pair; do not swallow the next newline.
    if (state !== 'normal') this.pendingCr = false
  }

  sanitize(input: string): string {
    let out = ''

    for (let i = 0; i < input.length; i++) {
      const ch = input[i]!
      const code = ch.charCodeAt(0)

      // Bail out of a runaway sequence (see MAX_SEQUENCE_CHARS). Everything
      // consumed so far stays dropped — it was still control-sequence bytes,
      // and re-emitting it would be worse than losing it — but the CURRENT
      // character is re-examined as normal text so output resumes here.
      if (this.state !== 'normal') {
        if (this.sequenceChars >= MAX_SEQUENCE_CHARS) this.enter('normal')
        else this.sequenceChars++
      }

      switch (this.state) {
        case 'normal': {
          if (ch === '\x1b') {
            this.enter('esc')
            break
          }
          if (code === 0x9b) {
            this.enter('csi')
            break
          }
          if (code === 0x9d) {
            this.enter('osc')
            break
          }
          if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
            this.enter('stString')
            break
          }
          if (isC1Control(code)) break
          if (isC0Control(code)) {
            if (ch === '\n') {
              // Second half of a CRLF — the CR already produced the newline.
              if (this.pendingCr) this.pendingCr = false
              else out += ch
            } else if (ch === '\r') {
              out += '\n'
              this.pendingCr = true
            } else {
              this.pendingCr = false
              if (ch === '\t') out += ch
            }
            break
          }
          this.pendingCr = false
          if (code === 0x7f) break
          if (isTextDirectionOrInvisible(code)) break
          out += ch
          break
        }

        case 'esc': {
          if (ch === '[') this.enter('csi')
          else if (ch === ']') this.enter('osc')
          else if (ch === 'P' || ch === 'X' || ch === '^' || ch === '_') this.enter('stString')
          else if (ch === '\x1b') this.enter('esc')
          else this.enter('normal')
          break
        }

        case 'csi': {
          if (ch === '\x1b') this.enter('esc')
          else if (isCsiFinal(code)) this.enter('normal')
          break
        }

        case 'osc': {
          if (ch === '\x07' || code === 0x9c) this.enter('normal')
          else if (ch === '\x1b') this.enter('oscEsc')
          break
        }

        case 'oscEsc': {
          if (ch === '\\') this.enter('normal')
          else if (ch === '\x1b') this.enter('oscEsc')
          else this.enter('osc')
          break
        }

        case 'stString': {
          if (code === 0x9c) this.enter('normal')
          else if (ch === '\x1b') this.enter('stEsc')
          break
        }

        case 'stEsc': {
          if (ch === '\\') this.enter('normal')
          else if (ch === '\x1b') this.enter('stEsc')
          else this.enter('stString')
          break
        }
      }
    }

    return out
  }

  reset(): void {
    this.enter('normal')
    this.pendingCr = false
  }
}

export function sanitizeTerminalText(input: unknown): string {
  return new TerminalSanitizer().sanitize(String(input ?? ''))
}

export function sanitizeTerminalPreview(input: unknown, maxChars: number): string {
  const cleaned = sanitizeTerminalText(input)
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, maxChars)
}
