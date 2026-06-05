/**
 * Terminal output sanitizer for untrusted model/tool text.
 *
 * The CLI owns its own ANSI colour/status sequences, but text originating from
 * models, tools, web pages, files, or persisted session previews must not be
 * allowed to drive the user's terminal.  In particular, macOS Terminal is
 * sensitive to malformed or very long OSC/DCS/CSI sequences in scrollback.
 */

type State = 'normal' | 'esc' | 'csi' | 'osc' | 'oscEsc' | 'stString' | 'stEsc'

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

  sanitize(input: string): string {
    let out = ''

    for (let i = 0; i < input.length; i++) {
      const ch = input[i]!
      const code = ch.charCodeAt(0)

      switch (this.state) {
        case 'normal': {
          if (ch === '\x1b') {
            this.state = 'esc'
            break
          }
          if (code === 0x9b) {
            this.state = 'csi'
            break
          }
          if (code === 0x9d) {
            this.state = 'osc'
            break
          }
          if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
            this.state = 'stString'
            break
          }
          if (isC1Control(code)) break
          if (isC0Control(code)) {
            if (ch === '\n' || ch === '\t') out += ch
            else if (ch === '\r') out += '\n'
            break
          }
          if (code === 0x7f) break
          out += ch
          break
        }

        case 'esc': {
          if (ch === '[') this.state = 'csi'
          else if (ch === ']') this.state = 'osc'
          else if (ch === 'P' || ch === 'X' || ch === '^' || ch === '_') this.state = 'stString'
          else if (ch === '\x1b') this.state = 'esc'
          else this.state = 'normal'
          break
        }

        case 'csi': {
          if (ch === '\x1b') this.state = 'esc'
          else if (isCsiFinal(code)) this.state = 'normal'
          break
        }

        case 'osc': {
          if (ch === '\x07' || code === 0x9c) this.state = 'normal'
          else if (ch === '\x1b') this.state = 'oscEsc'
          break
        }

        case 'oscEsc': {
          if (ch === '\\') this.state = 'normal'
          else if (ch === '\x1b') this.state = 'oscEsc'
          else this.state = 'osc'
          break
        }

        case 'stString': {
          if (code === 0x9c) this.state = 'normal'
          else if (ch === '\x1b') this.state = 'stEsc'
          break
        }

        case 'stEsc': {
          if (ch === '\\') this.state = 'normal'
          else if (ch === '\x1b') this.state = 'stEsc'
          else this.state = 'stString'
          break
        }
      }
    }

    return out
  }

  reset(): void {
    this.state = 'normal'
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
