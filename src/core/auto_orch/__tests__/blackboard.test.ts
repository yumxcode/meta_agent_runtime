/**
 * Blackboard — unit coverage for the target-addressed corrective channel.
 */
import { describe, it, expect } from 'vitest'
import { Blackboard } from '../Blackboard.js'

describe('Blackboard', () => {
  it('delivers an addressed corrective only to its target node', () => {
    const bb = new Blackboard()
    bb.postCorrective({ from: 'verifyAuth', to: 'buildAuth', messages: ['fix token expiry'] })
    bb.postCorrective({ from: 'verifyApi', to: 'buildApi', messages: ['fix pagination'] })

    // an unrelated node gets nothing
    expect(bb.hasCorrectivesFor('buildOther')).toBe(false)
    expect(bb.takeCorrectivesFor('buildOther')).toEqual([])

    // each node gets ONLY its own feedback (no cross-contamination)
    expect(bb.takeCorrectivesFor('buildAuth')).toEqual([{ from: 'verifyAuth', messages: ['fix token expiry'] }])
    expect(bb.takeCorrectivesFor('buildApi')).toEqual([{ from: 'verifyApi', messages: ['fix pagination'] }])
  })

  it('consume-once: a corrective is delivered to exactly one read', () => {
    const bb = new Blackboard()
    bb.postCorrective({ from: 'v', to: 'B', messages: ['x'] })
    expect(bb.takeCorrectivesFor('B')).toHaveLength(1)
    expect(bb.takeCorrectivesFor('B')).toHaveLength(0) // consumed
    expect(bb.hasCorrectivesFor('B')).toBe(false)
  })

  it('a broadcast corrective (no target) goes to whoever reads first', () => {
    const bb = new Blackboard()
    bb.postCorrective({ from: 'v', messages: ['legacy'] }) // to undefined = broadcast
    expect(bb.hasCorrectivesFor('anyone')).toBe(true)
    expect(bb.takeCorrectivesFor('anyone')).toEqual([{ from: 'v', messages: ['legacy'] }])
    expect(bb.takeCorrectivesFor('someoneElse')).toEqual([]) // already consumed
  })

  it('renders a corrective preface for the addressed node and clears it', () => {
    const bb = new Blackboard()
    bb.postCorrective({ from: 'verify', to: 'gen', messages: ['fix bug X'] })
    expect(bb.takeCorrectivePrefaceFor('other')).toBe('') // not addressed to 'other'
    const preface = bb.takeCorrectivePrefaceFor('gen')
    expect(preface).toContain('上一轮审查反馈')
    expect(preface).toContain('fix bug X')
    expect(bb.hasCorrectivesFor('gen')).toBe(false) // drained
  })

  it('ignores empty messages and counts rounds', () => {
    const bb = new Blackboard()
    bb.postCorrective({ from: 'v', to: 'B', messages: ['', '   '] })
    expect(bb.hasCorrectivesFor('B')).toBe(false)
    expect(bb.correctiveRounds()).toBe(0)
    bb.postCorrective({ from: 'v', to: 'B', messages: ['real'] })
    bb.postCorrective({ from: 'r', to: 'C', messages: ['other'] })
    expect(bb.correctiveRounds()).toBe(2)
  })

  it('persistent outputs: readFor does NOT consume, supports fan-in, filters by kind', () => {
    const bb = new Blackboard()
    bb.post({ from: 'A', to: 'C', kind: 'output', data: { x: 1 } })
    bb.post({ from: 'B', kind: 'output', data: { y: 2 } }) // broadcast
    bb.post({ from: 'A', to: 'C', kind: 'note', messages: ['fyi'] })

    // C sees both the addressed output and the broadcast one — twice (no consume)
    expect(bb.readFor('C', 'output')).toHaveLength(2)
    expect(bb.readFor('C', 'output')).toHaveLength(2)
    // a different node only sees the broadcast output
    expect(bb.readFor('D', 'output')).toHaveLength(1)
    // kind filter
    expect(bb.readFor('C', 'note')).toHaveLength(1)
    // correctives are never returned by readFor
    bb.postCorrective({ from: 'v', to: 'C', messages: ['x'] })
    expect(bb.readFor('C')).toHaveLength(3) // 2 outputs + 1 note, NOT the corrective
  })

  it('retains a full post log for observability', () => {
    const bb = new Blackboard()
    bb.postCorrective({ from: 'v', to: 'B', messages: ['x'] })
    bb.post({ from: 'gen', kind: 'output', data: { file: 'a.ts' } })
    expect(bb.entries().map(e => e.kind)).toEqual(['corrective', 'output'])
    bb.takeCorrectivesFor('B') // draining does not erase the log
    expect(bb.entries()).toHaveLength(2)
  })
})
