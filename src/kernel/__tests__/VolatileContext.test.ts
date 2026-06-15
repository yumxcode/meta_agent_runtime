/**
 * Tests for the unified volatile-context prefix stripper.
 */
import { describe, it, expect } from 'vitest'
import {
  stripVolatileContextPrefix,
  VOLATILE_CONTEXT_PREFIX_END,
} from '../utils/VolatileContext.js'

const prefix = (inner: string): string => `<context>\n${inner}\n</context>\n\n---\n\n`

describe('stripVolatileContextPrefix', () => {
  it('strips a well-formed volatile prefix', () => {
    const text = `${prefix('<memory>m1</memory>')}do the task`
    expect(stripVolatileContextPrefix(text)).toBe('do the task')
  })

  it('returns text unchanged when no prefix is present', () => {
    expect(stripVolatileContextPrefix('plain user text')).toBe('plain user text')
  })

  it('does not terminate at a bare </context> inside section content', () => {
    // Memory recall quoting a past transcript that contains a closing tag —
    // the bare tag is not followed by the full \n\n---\n\n sentinel.
    const text = `${prefix('<memory>quoted: </context> end-quote</memory>')}real prompt`
    expect(stripVolatileContextPrefix(text)).toBe('real prompt')
  })

  it('uses the FIRST full sentinel so pasted transcripts in user text survive', () => {
    // The user pastes a log that itself contains a volatile prefix. The first
    // sentinel is the real boundary; using the last would destroy the pasted
    // content and the user's actual request around it.
    const pasted = `review this log:\n<context>\nold stuff\n</context>\n\n---\n\nold prompt\nand tell me what happened`
    const text = `${prefix('<notifications>n</notifications>')}${pasted}`
    expect(stripVolatileContextPrefix(text)).toBe(pasted)
  })

  it('returns text unchanged when it starts with <context> but has no full sentinel', () => {
    const malformed = '<context>\nincomplete'
    expect(stripVolatileContextPrefix(malformed)).toBe(malformed)
  })

  it('sentinel constant matches the formatVolatileContext join convention', () => {
    // `${volatilePrefix}\n\n---\n\n${prompt}` where volatilePrefix ends with `\n</context>`
    expect(VOLATILE_CONTEXT_PREFIX_END).toBe('\n</context>\n\n---\n\n')
  })
})
