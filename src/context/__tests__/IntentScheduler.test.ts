/**
 * IntentScheduler — when the LLM-backed intent analysis runs, and what it costs.
 *
 * Replaces an unconditional per-turn flash call. The properties that matter and
 * that these tests hold:
 *
 *   • a steady conversation makes NO LLM calls at all
 *   • a topic switch is picked up when it happens, not up to 9 turns later
 *   • only the first turn of a FRESH project blocks; a resumed one never does
 *   • a background refresh's change is reported on the next turn (the latch —
 *     without it every refresh after the first is inert)
 *   • per-turn fields stay fresh between refreshes; project fields carry over
 */
import { describe, expect, it, vi } from 'vitest'
import {
  SessionIntentTracker,
  decideIntentRefresh,
  projectIntentChanged,
  projectIntentOf,
  type ProjectIntent,
} from '../IntentScheduler.js'
import { heuristicIntent, type QueryIntent } from '../QueryAnalyzer.js'

function intent(over: Partial<QueryIntent> = {}): QueryIntent {
  return {
    domains: ['locomotion'],
    hasHardware: false,
    hasSimulation: false,
    searchKeywords: ['gait'],
    intent: 'experiment',
    ...over,
  }
}

const LOCOMOTION: ProjectIntent = { domains: ['locomotion'], hasHardware: false, hasSimulation: false }

/** Analyzer stub that records every call. */
function stubAnalyzer(reply: QueryIntent | (() => QueryIntent | null)) {
  const calls: string[] = []
  return {
    calls,
    analyze: vi.fn(async (q: string) => {
      calls.push(q)
      const r = typeof reply === 'function' ? reply() : reply
      if (!r) throw new Error('flash failed')
      return r
    }),
  }
}

// ── decideIntentRefresh (pure policy) ─────────────────────────────────────────

describe('decideIntentRefresh', () => {
  const base = { turnIndex: 5, lastRefreshTurn: 1, current: LOCOMOTION, prompt: '继续调步态' }

  it('first turn refreshes and BLOCKS', () => {
    expect(decideIntentRefresh({ ...base, turnIndex: 1, lastRefreshTurn: 0, current: null }))
      .toEqual({ refresh: true, blocking: true, reason: 'first_turn' })
  })

  it('a steady turn makes no call', () => {
    expect(decideIntentRefresh(base)).toEqual({ refresh: false, blocking: false, reason: 'steady' })
  })

  it('a domain shift refreshes in the background', () => {
    // locomotion project, user pivots to perception.
    const d = decideIntentRefresh({ ...base, prompt: '看下激光雷达的点云配准' })
    expect(d).toEqual({ refresh: true, blocking: false, reason: 'domain_shift' })
  })

  it('`general` is "no signal", not a shift', () => {
    // The heuristic names no domain here; treating that as a shift would fire a
    // call on every vague message ("好像报错了，查看下").
    expect(decideIntentRefresh({ ...base, prompt: '好像报错了，查看下' }).reason).toBe('steady')
  })

  it('an overlapping domain is not a shift', () => {
    expect(decideIntentRefresh({ ...base, prompt: '步态的支撑相时间调一下' }).reason).toBe('steady')
  })

  it('crossing into real hardware refreshes even without a domain change', () => {
    const d = decideIntentRefresh({ ...base, prompt: '步态改完了，放到真机上跑' })
    expect(d.refresh).toBe(true)
    expect(['hardware_crossing', 'domain_shift']).toContain(d.reason)
  })

  it('does not re-fire hardware_crossing once hasHardware is already set', () => {
    const onHw: ProjectIntent = { ...LOCOMOTION, hasHardware: true }
    expect(decideIntentRefresh({ ...base, current: onHw, prompt: '真机上再跑一次步态' }).reason)
      .toBe('steady')
  })

  it('debounces a burst of shift-looking messages', () => {
    const d = decideIntentRefresh({ ...base, turnIndex: 2, lastRefreshTurn: 1, prompt: '看下点云' })
    expect(d).toEqual({ refresh: false, blocking: false, reason: 'debounced' })
  })

  it('an EXPLICIT switch beats the debounce', () => {
    // If the user says "new task" they mean now, not in two turns.
    const d = decideIntentRefresh({ ...base, turnIndex: 2, lastRefreshTurn: 1, prompt: '换个任务，来看导航' })
    expect(d).toEqual({ refresh: true, blocking: false, reason: 'explicit_switch' })
  })

  it('the periodic tick is the backstop for drift the heuristic cannot name', () => {
    const d = decideIntentRefresh({ ...base, turnIndex: 11, lastRefreshTurn: 1, prompt: '继续' })
    expect(d).toEqual({ refresh: true, blocking: false, reason: 'periodic' })
  })

  it('periodicTurns: 0 disables the tick entirely', () => {
    const d = decideIntentRefresh({
      ...base, turnIndex: 99, lastRefreshTurn: 1, prompt: '继续',
      options: { periodicTurns: 0 },
    })
    expect(d.reason).toBe('steady')
  })
})

// ── projectIntentChanged ──────────────────────────────────────────────────────

describe('projectIntentChanged', () => {
  it('null → anything is a change (the first-turn case)', () => {
    expect(projectIntentChanged(null, LOCOMOTION)).toBe(true)
  })

  it('domain order does not matter', () => {
    expect(projectIntentChanged(
      { domains: ['locomotion', 'deployment'], hasHardware: false, hasSimulation: false },
      { domains: ['deployment', 'locomotion'], hasHardware: false, hasSimulation: false },
    )).toBe(false)
  })

  it('a hardware flip is a change', () => {
    expect(projectIntentChanged(LOCOMOTION, { ...LOCOMOTION, hasHardware: true })).toBe(true)
  })

  it('per-turn fields are not part of the comparison', () => {
    // searchKeywords / intent differ every turn; including them would make the
    // change detector fire constantly and mean nothing.
    const a = projectIntentOf(intent({ searchKeywords: ['a'], intent: 'debug' }))
    const b = projectIntentOf(intent({ searchKeywords: ['z'], intent: 'deploy' }))
    expect(projectIntentChanged(a, b)).toBe(false)
  })
})

// ── SessionIntentTracker ──────────────────────────────────────────────────────

describe('SessionIntentTracker · call budget', () => {
  it('blocks once on the first turn, then goes quiet', async () => {
    const a = stubAnalyzer(intent())
    const tracker = new SessionIntentTracker(a)

    const first = await tracker.intentForTurn('调一下四足步态')
    expect(a.analyze).toHaveBeenCalledTimes(1)
    expect(first.reason).toBe('first_turn')
    expect(first.projectIntentChanged).toBe(true)   // null → something

    for (const q of ['继续', '步态再快一点', '看看支撑相', '嗯', '再来一次']) {
      await tracker.intentForTurn(q)
    }
    // THE headline property: a steady conversation costs nothing.
    expect(a.analyze).toHaveBeenCalledTimes(1)
  })

  it('a RESUMED project pays zero calls — seeded from disk', async () => {
    const a = stubAnalyzer(intent())
    const tracker = new SessionIntentTracker(a)
    tracker.seed(LOCOMOTION)

    for (const q of ['继续上次的步态', '看下日志', '再跑一遍']) {
      const t = await tracker.intentForTurn(q)
      expect(t.reason).not.toBe('first_turn')
    }
    expect(a.analyze).not.toHaveBeenCalled()
  })

  it('the periodic backstop fires at the configured interval', async () => {
    const a = stubAnalyzer(intent())
    const tracker = new SessionIntentTracker(a, { periodicTurns: 4 })
    tracker.seed(LOCOMOTION)

    for (let i = 0; i < 10; i++) await tracker.intentForTurn('继续')
    await tracker.settle()
    // turns 4 and 8 (measured from lastRefreshTurn = 0, then from 4)
    expect(a.analyze.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(a.analyze.mock.calls.length).toBeLessThanOrEqual(3)
  })
})

describe('SessionIntentTracker · topic switch', () => {
  it('reacts to a switch immediately, not at the next tick', async () => {
    const a = stubAnalyzer(intent({ domains: ['perception'] }))
    const tracker = new SessionIntentTracker(a, { periodicTurns: 10 })
    tracker.seed(LOCOMOTION)

    await tracker.intentForTurn('步态还行')                    // steady
    await tracker.intentForTurn('步态再调调')                   // steady
    const t = await tracker.intentForTurn('看下激光雷达的点云')   // domain shift
    expect(t.reason).toBe('domain_shift')
    expect(a.analyze).toHaveBeenCalledTimes(1)
  })

  it('reports a background refresh on the NEXT turn — the latch', async () => {
    // Without the latch this is the bug: the background result updates the
    // tracker silently, nothing ever returns projectIntentChanged: true, and
    // the candidate pool is never reloaded for any refresh after the first.
    const a = stubAnalyzer(intent({ domains: ['perception'] }))
    const tracker = new SessionIntentTracker(a, { periodicTurns: 10 })
    tracker.seed(LOCOMOTION)

    const shiftTurn = await tracker.intentForTurn('看下激光雷达的点云配准')
    expect(shiftTurn.reason).toBe('domain_shift')
    expect(shiftTurn.projectIntentChanged).toBe(false)   // hasn't landed yet

    await tracker.settle()

    const nextTurn = await tracker.intentForTurn('点云配准的残差怎么看')
    expect(nextTurn.projectIntentChanged).toBe(true)     // ← the latch
    expect(nextTurn.intent.domains).toEqual(['perception'])

    // Consumed exactly once — a stale flag would force-reload every turn after.
    const third = await tracker.intentForTurn('继续')
    expect(third.projectIntentChanged).toBe(false)
  })

  it('a background refresh that changes nothing does not raise the latch', async () => {
    const a = stubAnalyzer(intent({ domains: ['locomotion'] }))
    const tracker = new SessionIntentTracker(a, { periodicTurns: 2, minTurnsBetweenRefresh: 1 })
    tracker.seed(LOCOMOTION)

    await tracker.intentForTurn('继续')
    await tracker.intentForTurn('继续')
    await tracker.settle()
    expect((await tracker.intentForTurn('继续')).projectIntentChanged).toBe(false)
  })
})

describe('SessionIntentTracker · field lifetimes', () => {
  it('carries project fields forward and recomputes per-turn fields locally', async () => {
    const a = stubAnalyzer(intent({
      domains: ['locomotion'], searchKeywords: ['llm-derived'], intent: 'experiment',
    }))
    const tracker = new SessionIntentTracker(a)
    await tracker.intentForTurn('四足步态实验')       // first turn: full LLM intent

    const later = await tracker.intentForTurn('为什么报错了')
    // Project-level: carried from the LLM answer.
    expect(later.intent.domains).toEqual(['locomotion'])
    // Turn-level: fresh from THIS turn, not the 1-turn-old LLM keywords.
    // A stale keyword set is worse than a local one here, because keywords
    // drive candidate RECALL from the experience store.
    expect(later.intent.searchKeywords).not.toContain('llm-derived')
    expect(later.intent.intent).toBe('debug')          // heuristic read "为什么"
  })

  it('hasHardware latches on from a local signal without waiting for a refresh', async () => {
    const a = stubAnalyzer(intent({ hasHardware: false }))
    const tracker = new SessionIntentTracker(a)
    tracker.seed(LOCOMOTION)
    const t = await tracker.intentForTurn('放到真机上跑一遍')
    expect(t.intent.hasHardware).toBe(true)
  })

  it('falls back to pure heuristics when the first-turn LLM call fails', async () => {
    const a = stubAnalyzer(() => null)                  // analyze throws
    const tracker = new SessionIntentTracker(a)
    const t = await tracker.intentForTurn('调一下四足步态')
    expect(t.intent.domains).toEqual(heuristicIntent('调一下四足步态').domains)
  })

  it('a failing background refresh leaves the previous intent in place', async () => {
    const a = stubAnalyzer(() => null)
    const tracker = new SessionIntentTracker(a, { periodicTurns: 2, minTurnsBetweenRefresh: 1 })
    tracker.seed(LOCOMOTION)
    await tracker.intentForTurn('继续')
    await tracker.intentForTurn('继续')
    await tracker.settle()
    expect(tracker.projectIntent).toEqual(LOCOMOTION)
  })

  it('never runs two background refreshes at once', async () => {
    let resolveIt: ((v: QueryIntent) => void) | undefined
    const analyze = vi.fn(() => new Promise<QueryIntent>(r => { resolveIt = r }))
    const tracker = new SessionIntentTracker({ analyze }, { periodicTurns: 1, minTurnsBetweenRefresh: 1 })
    tracker.seed(LOCOMOTION)

    await tracker.intentForTurn('继续')
    await tracker.intentForTurn('继续')
    await tracker.intentForTurn('继续')
    expect(analyze).toHaveBeenCalledTimes(1)
    resolveIt?.(intent())
    await tracker.settle()
  })
})

/**
 * The boundary that must not move.
 *
 * An intent change refreshes the experience WORKING SET (a read: re-query
 * candidates, re-pick which to inject). It must never reach the knowledge
 * WRITE path — experience_write / physical anchor / postSessionExtract — which
 * feeds a queue this system requires a human to review.
 *
 * The reasoning: new knowledge comes from experiment RESULTS, not from the user
 * changing subject. Wiring writes to a topic switch would push unsupported
 * entries into the review queue at exactly the rate the user changes their mind.
 */
describe('intent change may refresh reads, never writes', () => {
  it('TurnIntent exposes no write-side signal at all', async () => {
    const a = stubAnalyzer(intent({ domains: ['perception'] }))
    const tracker = new SessionIntentTracker(a)
    tracker.seed(LOCOMOTION)
    const t = await tracker.intentForTurn('看下激光雷达的点云')
    await tracker.settle()
    const next = await tracker.intentForTurn('点云残差')

    // The whole contract surface. Anything resembling extract/promote/write
    // appearing here is the regression this test exists to catch.
    expect(Object.keys(next).sort()).toEqual(['intent', 'projectIntentChanged', 'reason'])
    expect(t.reason).toBe('domain_shift')
  })

  it('the tracker never touches a store — it takes only an analyzer', async () => {
    // Constructor shape is the guard: with no store handle in scope, a future
    // edit cannot casually call experienceStore.write() from a refresh.
    const a = stubAnalyzer(intent())
    const tracker = new SessionIntentTracker(a)
    await tracker.intentForTurn('四足步态')
    await tracker.settle()
    expect(a.analyze).toHaveBeenCalledTimes(1)
  })
})
