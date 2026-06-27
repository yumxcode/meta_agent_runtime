/**
 * Blackboard — unit coverage for the run-scoped corrective channel.
 */
import { describe, it, expect } from 'vitest'
import { Blackboard } from '../Blackboard.js'

describe('Blackboard', () => {
  it('posts correctives and drains them exactly once', () => {
    const bb = new Blackboard()
    expect(bb.hasPendingCorrectives()).toBe(false)
    bb.postCorrective('verify', ['add tests', 'fix null check'])
    expect(bb.hasPendingCorrectives()).toBe(true)
    const drained = bb.drainCorrectives()
    expect(drained).toEqual([{ from: 'verify', messages: ['add tests', 'fix null check'] }])
    // consumed: a second drain is empty
    expect(bb.drainCorrectives()).toEqual([])
    expect(bb.hasPendingCorrectives()).toBe(false)
  })

  it('renders a corrective preface and clears pending', () => {
    const bb = new Blackboard()
    bb.postCorrective('verify', ['fix bug X'])
    const preface = bb.takeCorrectivePreface()
    expect(preface).toContain('上一轮审查反馈')
    expect(preface).toContain('fix bug X')
    expect(preface).toContain('verify')
    // drained by the render
    expect(bb.hasPendingCorrectives()).toBe(false)
    expect(bb.takeCorrectivePreface()).toBe('')
  })

  it('ignores empty / whitespace messages and counts rounds', () => {
    const bb = new Blackboard()
    bb.postCorrective('verify', ['', '   '])
    expect(bb.hasPendingCorrectives()).toBe(false)
    expect(bb.correctiveRounds()).toBe(0)
    bb.postCorrective('verify', ['real item'])
    bb.postCorrective('reviewer', ['another'])
    expect(bb.correctiveRounds()).toBe(2)
  })

  it('retains a full post log for observability', () => {
    const bb = new Blackboard()
    bb.postCorrective('verify', ['x'])
    bb.post({ from: 'gen', kind: 'output', data: { file: 'a.ts' } })
    const kinds = bb.entries().map(e => e.kind)
    expect(kinds).toEqual(['corrective', 'output'])
    // draining pending correctives does not erase the log
    bb.drainCorrectives()
    expect(bb.entries()).toHaveLength(2)
  })
})
