/**
 * Some characters attack the READER rather than the terminal.
 *
 * The sanitizer's state machine strips everything that drives the terminal —
 * CSI, OSC, DCS, C0/C1 — but bidirectional overrides and zero-width characters
 * are ordinary printable code points and went through untouched. They reorder
 * or hide the glyphs around them, which matters most in exactly one place: the
 * tool-call preview line, which is the thing an operator reads before deciding
 * whether to approve a command. A model, a fetched web page, or a file being
 * summarised can all put them there.
 */
import { describe, expect, it } from 'vitest'
import { sanitizeTerminalPreview, sanitizeTerminalText } from '../terminalSanitizer.js'

const RLO = '‮'   // right-to-left override
const PDF = '‬'   // pop directional formatting
const RLI = '⁧'   // right-to-left isolate
const PDI = '⁩'   // pop directional isolate
const ZWSP = '​'
const BOM = '﻿'

describe('terminal sanitizer — text direction and invisibles', () => {
  it('drops bidi overrides so the rendered order is the real order', () => {
    // The classic shape: what displays is not what would execute.
    const spoofed = `rm -rf ${RLO}gnp. txt${PDF}`
    const clean = sanitizeTerminalText(spoofed)
    expect(clean).not.toContain(RLO)
    expect(clean).not.toContain(PDF)
    expect(clean).toBe('rm -rf gnp. txt')
  })

  it('drops isolates too', () => {
    expect(sanitizeTerminalText(`a${RLI}b${PDI}c`)).toBe('abc')
  })

  it('drops zero-width characters and the BOM', () => {
    expect(sanitizeTerminalText(`ru${ZWSP}n${BOM}`)).toBe('run')
    // Two strings that looked identical now really are identical.
    expect(sanitizeTerminalText(`admin${ZWSP}`)).toBe(sanitizeTerminalText('admin'))
  })

  it('applies to the tool-call preview, which is what gets approved', () => {
    const preview = sanitizeTerminalPreview(`{"command":"rm ${RLO}x${PDF}"}`, 120)
    expect(preview).not.toContain(RLO)
    expect(preview).not.toContain(PDF)
  })

  it('leaves ordinary text — CJK included — alone', () => {
    expect(sanitizeTerminalText('保持推进 X1 训练 · 100%')).toBe('保持推进 X1 训练 · 100%')
    expect(sanitizeTerminalText('emoji 😀 and math ∑ survive')).toBe('emoji 😀 and math ∑ survive')
  })

  it('still strips the control sequences it always did', () => {
    expect(sanitizeTerminalText('\x1b[31mred\x1b[0m')).toBe('red')
    expect(sanitizeTerminalText('title\x1b]0;evil\x07 after')).toBe('title after')
  })
})
