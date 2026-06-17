import { describe, it, expect } from 'vitest'
import { parseVerdict } from '../VerifyJudge.js'
import { buildVerifyRejectionPrompt } from '../../../../kernel/loop/VerifyGate.js'

describe('parseVerdict', () => {
  it('parses a fenced json verdict', () => {
    const text = 'Here is my review.\n```json\n{"done": false, "unfinished": ["add tests"], "evidence": ["src/a.ts:10 missing return"]}\n```'
    const v = parseVerdict(text)
    expect(v).not.toBeNull()
    expect(v!.done).toBe(false)
    expect(v!.unfinished).toEqual(['add tests'])
    expect(v!.evidence).toEqual(['src/a.ts:10 missing return'])
  })

  it('parses a done verdict with empty arrays', () => {
    const v = parseVerdict('```json\n{"done": true, "unfinished": [], "evidence": ["npm run test exit 0"]}\n```')
    expect(v!.done).toBe(true)
    expect(v!.unfinished).toEqual([])
  })

  it('falls back to a trailing bare object', () => {
    const v = parseVerdict('blah blah {"done": false, "unfinished": ["x"], "evidence": []}')
    expect(v!.done).toBe(false)
    expect(v!.unfinished).toEqual(['x'])
  })

  it('coerces missing/wrong-typed fields to safe defaults', () => {
    const v = parseVerdict('```json\n{"done": true}\n```')
    expect(v!.done).toBe(true)
    expect(v!.unfinished).toEqual([])
    expect(v!.evidence).toEqual([])
  })

  it('returns null when there is no parseable verdict', () => {
    expect(parseVerdict('I think it is fine, looks good to me.')).toBeNull()
    expect(parseVerdict('')).toBeNull()
  })

  it('returns null when done is not a boolean', () => {
    expect(parseVerdict('```json\n{"done": "yes", "unfinished": []}\n```')).toBeNull()
  })

  it('prefers the last verdict block when several are present', () => {
    const text = '```json\n{"done": true, "unfinished": []}\n```\nwait, revised:\n```json\n{"done": false, "unfinished": ["redo"]}\n```'
    const v = parseVerdict(text)
    expect(v!.done).toBe(false)
    expect(v!.unfinished).toEqual(['redo'])
  })
})

describe('buildVerifyRejectionPrompt', () => {
  it('lists unfinished items and evidence', () => {
    const p = buildVerifyRejectionPrompt(
      { done: false, unfinished: ['fix typecheck', 'add README'], evidence: ['tsc exit 2'] },
      2,
    )
    expect(p).toContain('第 2 轮')
    expect(p).toContain('1. fix typecheck')
    expect(p).toContain('2. add README')
    expect(p).toContain('tsc exit 2')
  })

  it('handles an empty unfinished list gracefully', () => {
    const p = buildVerifyRejectionPrompt({ done: false, unfinished: [], evidence: [] }, 1)
    expect(p).toContain('第 1 轮')
    expect(p).toContain('未给出具体项')
  })
})
