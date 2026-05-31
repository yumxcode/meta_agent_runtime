import { describe, expect, it } from 'vitest'
import { assembleSystemPrompt } from '../utils/AssembleSystemPrompt.js'

describe('assembleSystemPrompt (L1)', () => {
  it('returns undefined when every part is missing or empty', () => {
    expect(assembleSystemPrompt()).toBeUndefined()
    expect(assembleSystemPrompt(undefined, '')).toBeUndefined()
    expect(assembleSystemPrompt(null, undefined, '')).toBeUndefined()
  })

  it('returns the only non-empty part verbatim', () => {
    expect(assembleSystemPrompt('hello', '')).toBe('hello')
    expect(assembleSystemPrompt('', 'world')).toBe('world')
  })

  it('joins multiple non-empty parts with \\n\\n', () => {
    expect(assembleSystemPrompt('a', 'b')).toBe('a\n\nb')
    expect(assembleSystemPrompt('a', '', 'c', undefined, 'd')).toBe('a\n\nc\n\nd')
  })

  it('treats null parts as missing', () => {
    expect(assembleSystemPrompt(null as unknown as string, 'x')).toBe('x')
  })
})
