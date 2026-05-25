/**
 * CompactPrompt unit tests
 *
 * Covers:
 *  - formatCompactSummary: analysis strip, summary unwrap, blank-line collapse
 *  - extractCompactInstructions: section detection, missing section
 *  - buildCompactPrompt: custom instructions injection
 */
import { describe, it, expect } from 'vitest'
import {
  formatCompactSummary,
  extractCompactInstructions,
  buildCompactPrompt,
  buildCompactSummaryMessage,
} from '../compact/CompactPrompt.js'

// ── formatCompactSummary ──────────────────────────────────────────────────────

describe('formatCompactSummary', () => {
  it('strips <analysis> block', () => {
    const raw = '<analysis>private reasoning</analysis>\nThe summary text.'
    expect(formatCompactSummary(raw)).toBe('The summary text.')
  })

  it('strips multiple <analysis> blocks', () => {
    const raw = '<analysis>first</analysis>\nMiddle\n<analysis>second</analysis>\nEnd'
    const result = formatCompactSummary(raw)
    expect(result).not.toContain('<analysis>')
    expect(result).toContain('Middle')
    expect(result).toContain('End')
  })

  it('unwraps <summary> tag with "Summary:" prefix', () => {
    const raw = '<summary>This is the summary content.</summary>'
    const result = formatCompactSummary(raw)
    expect(result).toBe('Summary:\nThis is the summary content.')
  })

  it('handles <analysis> before <summary>', () => {
    const raw = '<analysis>private</analysis>\n<summary>The actual summary.</summary>'
    const result = formatCompactSummary(raw)
    expect(result).toBe('Summary:\nThe actual summary.')
    expect(result).not.toContain('private')
    expect(result).not.toContain('<analysis>')
    expect(result).not.toContain('<summary>')
  })

  it('collapses 3+ consecutive blank lines to 2', () => {
    const raw = 'Line A\n\n\n\nLine B'
    const result = formatCompactSummary(raw)
    expect(result).toBe('Line A\n\nLine B')
  })

  it('preserves exactly 2 blank lines', () => {
    const raw = 'Line A\n\nLine B'
    expect(formatCompactSummary(raw)).toBe('Line A\n\nLine B')
  })

  it('trims leading and trailing whitespace', () => {
    const raw = '   \n\nSome text\n\n   '
    expect(formatCompactSummary(raw)).toBe('Some text')
  })

  it('is case-insensitive for tag names', () => {
    const raw = '<ANALYSIS>hidden</ANALYSIS>\n<SUMMARY>shown</SUMMARY>'
    const result = formatCompactSummary(raw)
    expect(result).toBe('Summary:\nshown')
    expect(result).not.toContain('hidden')
  })

  it('passes through plain text with no tags', () => {
    const raw = 'Just plain text with no special tags.'
    expect(formatCompactSummary(raw)).toBe('Just plain text with no special tags.')
  })
})

// ── extractCompactInstructions ────────────────────────────────────────────────

describe('extractCompactInstructions', () => {
  it('extracts ## Compact Instructions section', () => {
    const prompt = `
## Overview
Some overview text.

## Compact Instructions
Always preserve function names.
Keep file paths intact.

## Other Section
Other content.
`.trim()
    const result = extractCompactInstructions(prompt)
    expect(result).toContain('Always preserve function names.')
    expect(result).toContain('Keep file paths intact.')
    expect(result).not.toContain('## Other Section')
  })

  it('returns undefined when section is absent', () => {
    const prompt = '## Overview\nSome text.\n## Rules\nSome rules.'
    expect(extractCompactInstructions(prompt)).toBeUndefined()
  })

  it('handles section at end of string', () => {
    const prompt = '## Overview\nText.\n\n## Compact Instructions\nCustom stuff.'
    const result = extractCompactInstructions(prompt)
    expect(result).toBe('Custom stuff.')
  })

  it('trims the extracted content', () => {
    const prompt = '## Compact Instructions\n  \n  spaces around  \n  \n## Next'
    const result = extractCompactInstructions(prompt)
    expect(result?.startsWith('spaces')).toBe(true)
    expect(result?.endsWith('spaces around')).toBe(true)
  })

  it('is case-insensitive for section header', () => {
    const prompt = '## COMPACT INSTRUCTIONS\nFoo bar.'
    const result = extractCompactInstructions(prompt)
    expect(result).toBe('Foo bar.')
  })
})

// ── buildCompactPrompt ────────────────────────────────────────────────────────

describe('buildCompactPrompt', () => {
  it('includes the base compact prompt text', () => {
    const prompt = buildCompactPrompt()
    expect(prompt).toContain('detailed summary of the conversation')
  })

  it('includes the 9-section structure', () => {
    const prompt = buildCompactPrompt()
    expect(prompt).toContain('## 1. Primary Request and Intent')
    expect(prompt).toContain('## 9. Optional Next Step')
  })

  it('includes no-tools preamble', () => {
    const prompt = buildCompactPrompt()
    expect(prompt).toContain('Do NOT call any tools')
  })

  it('injects custom instructions when provided', () => {
    const prompt = buildCompactPrompt('Always include git hashes.')
    expect(prompt).toContain('## Additional Instructions')
    expect(prompt).toContain('Always include git hashes.')
  })

  it('does not add additional instructions section when none provided', () => {
    const prompt = buildCompactPrompt()
    expect(prompt).not.toContain('## Additional Instructions')
  })

  it('ends with the no-tools trailer', () => {
    const prompt = buildCompactPrompt()
    expect(prompt.trimEnd()).toContain('Respond with TEXT ONLY')
  })
})

// ── buildCompactSummaryMessage ────────────────────────────────────────────────

describe('buildCompactSummaryMessage', () => {
  it('includes the formatted summary', () => {
    const msg = buildCompactSummaryMessage('Summary:\nDone things.')
    expect(msg).toContain('Summary:\nDone things.')
  })

  it('includes the resume instruction', () => {
    const msg = buildCompactSummaryMessage('Summary:\nContext.')
    expect(msg).toContain('Continue the conversation from where it left off')
  })

  it('includes the context-continuation preamble', () => {
    const msg = buildCompactSummaryMessage('Summary:\nContext.')
    expect(msg).toContain('previous conversation that ran out of context')
  })
})
