import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { validateCharter, freezeCharter } from '../CharterValidate.js'
import { CharterStore } from '../CharterStore.js'
import { evaluateBool } from '../../expr/Expr.js'
import { walkResearchCharter } from '../../__tests__/testCharter.js'

describe('validateCharter', () => {
  it('accepts the walk-research fixture', () => {
    expect(validateCharter(walkResearchCharter())).toEqual([])
  })

  it('rejects undeclared identifiers in meter/tripwire expressions', () => {
    const errs = validateCharter(walkResearchCharter({
      meters: [
        { name: 'iteration', inc: 'every_round' },
        { name: 'stale_count', incWhen: 'new_findingz == 0' },  // typo
      ],
    }))
    expect(errs.some(e => e.includes('undeclared identifier') && e.includes('new_findingz'))).toBe(true)
  })

  it("rejects an observable whose source.from is not 'judge' (only wired source)", () => {
    const errs = validateCharter(walkResearchCharter({
      observables: [
        { name: 'new_findings', source: { from: 'judge', key: 'new_findings_count' } },
        { name: 'metric_delta', source: { from: 'judge', key: 'metric_delta' } },
        // Unsupported source — the kernel never populates it (dead tripwire risk).
        { name: 'worker_status', source: { from: 'worker', key: 'label' } as unknown as { from: 'judge'; key: string } },
      ],
    }))
    expect(errs.some(e => e.includes('worker_status') && e.includes("must be 'judge'"))).toBe(true)
  })

  it("rejects a judge observable missing its 'key'", () => {
    const errs = validateCharter(walkResearchCharter({
      observables: [
        { name: 'new_findings', source: { from: 'judge', key: 'new_findings_count' } },
        { name: 'metric_delta', source: { from: 'judge' } as unknown as { from: 'judge'; key: string } },
      ],
    }))
    expect(errs.some(e => e.includes('metric_delta') && e.includes("needs a non-empty 'key'"))).toBe(true)
  })

  it('rejects a loop with no guaranteed terminator (no stop tripwire and no lifetime budget)', () => {
    const errs = validateCharter(walkResearchCharter({
      tripwires: [{ when: 'stale_count >= 2', then: { act: 'pivot' } }],
      budgets: { perRound: { usd: 6 } },  // no lifetime cap
    }))
    expect(errs.some(e => e.includes('guaranteed terminator'))).toBe(true)
  })

  it('rejects an escalate action without a reason', () => {
    const errs = validateCharter(walkResearchCharter({
      tripwires: [
        { when: 'stale_count >= 4', then: { act: 'escalate' } as never },
        { when: 'stale_count >= 2', then: { act: 'pivot' } },
        { when: 'iteration >= 3', then: { act: 'finalize' } },
      ],
    }))
    expect(errs.some(e => e.includes("escalate needs a non-empty 'reason'"))).toBe(true)
  })

  it('rejects onResume.resetMeters that names a non-meter', () => {
    const errs = validateCharter(walkResearchCharter({
      tripwires: [
        { when: 'stale_count >= 4', then: { act: 'escalate', reason: 'x', onResume: { resetMeters: ['new_findings'] } } },
        { when: 'stale_count >= 2', then: { act: 'pivot' } },
        { when: 'iteration >= 3', then: { act: 'finalize' } },
      ],
    }))
    expect(errs.some(e => e.includes('not a declared meter'))).toBe(true)
  })

  it('enforces pivot ⇔ pivoter in both directions', () => {
    // pivot tripwire without a pivoter seat
    const noSeat = walkResearchCharter()
    delete noSeat.seats.pivoter
    expect(validateCharter(noSeat).some(e => e.includes('seats.pivoter is not declared'))).toBe(true)
    // pivoter seat without a pivot tripwire (explicit seats override keeps the pivoter)
    const noTripwire = walkResearchCharter()
    noTripwire.tripwires = [{ when: 'iteration >= 3', then: { act: 'finalize' } }]
    expect(validateCharter(noTripwire).some(e => e.includes('dead seat'))).toBe(true)
  })

  it('validates health.staleWhen statically', () => {
    const errs = validateCharter(walkResearchCharter({ health: { staleWhen: 'nope_meter > 1' } }))
    expect(errs.some(e => e.includes('health.staleWhen') && e.includes('undeclared'))).toBe(true)
    expect(validateCharter(walkResearchCharter({ health: { staleWhen: 'stale_count >= 2' } }))).toEqual([])
  })

  it('migrates pre-v3 tripwire actions on validate/freeze (attention→escalate, stop→finalize)', () => {
    const legacy = walkResearchCharter({
      tripwires: [
        { when: 'stale_count >= 4', then: { escalate: 'attention', stop: true } as never },
        { when: 'stale_count >= 2', then: { mode: 'pivot' } as never },
        { when: 'iteration >= 5', then: { mode: 'attention' } as never },
        { when: 'iteration >= 3', then: { mode: 'finalize', stop: true } as never },
      ],
    })
    expect(validateCharter(legacy)).toEqual([])
    const frozen = freezeCharter(legacy)
    expect(frozen.tripwires.map(tw => tw.then)).toEqual([
      { act: 'escalate', reason: 'attention' },
      { act: 'pivot' },
      { act: 'escalate', reason: 'attention' },
      { act: 'finalize' },
    ])
  })

  it('rejects non-isolated judge/pivoter (D6 is structural)', () => {
    const charter = walkResearchCharter()
    charter.seats.judge!.context = 'lineage_round' as never
    expect(validateCharter(charter).some(e => e.includes("must be 'isolated'"))).toBe(true)
  })

  it('rejects .meta-agent references in prompts and writeScope', () => {
    const errs = validateCharter(walkResearchCharter({
      writeScope: ['.meta-agent/research/**'],
    }))
    expect(errs.some(e => e.includes('.meta-agent'))).toBe(true)
  })

  it('rejects paths and write scopes that cannot be enforced safely', () => {
    const charter = walkResearchCharter({ writeScope: ['*.md'] })
    charter.seats.judge!.inputs = ['../../etc/passwd']
    const errs = validateCharter(charter)
    expect(errs.some(e => e.includes('cannot be enforced safely'))).toBe(true)
    expect(errs.some(e => e.includes("must not contain '..'"))).toBe(true)
  })

  it('requires a judge for judge-sourced observables', () => {
    const charter = walkResearchCharter()
    delete charter.seats.judge
    delete charter.gates.findings_gate
    expect(validateCharter(charter)).toContain(
      'judge-sourced observables require seats.judge — otherwise they can never be populated',
    )
  })

  it('rejects a judge gate without a judge seat', () => {
    const charter = walkResearchCharter()
    delete charter.seats.judge
    expect(validateCharter(charter).some(e => e.includes('no judge seat'))).toBe(true)
  })

  it('requires at least one tripwire', () => {
    expect(validateCharter(walkResearchCharter({ tripwires: [] }))
      .some(e => e.includes('at least one tripwire'))).toBe(true)
  })

  it('requires a shape spec for newly frozen schema gates', () => {
    const charter = walkResearchCharter()
    charter.gates.state_gate = { kind: 'schema', files: ['ledger/progress.json'] }
    expect(validateCharter(charter).some(e => e.includes('requires a versioned spec'))).toBe(true)
  })
})

describe('freezeCharter', () => {
  it('parses every expression to an AST and records the identifier universe', () => {
    const frozen = freezeCharter(walkResearchCharter())
    expect(frozen.frozen.tripwireAsts).toHaveLength(3)
    expect(frozen.frozen.meterAsts['stale_count']!.incWhen).toBeDefined()
    expect(frozen.frozen.declaredIdentifiers).toContain('new_findings')
    // The frozen AST evaluates — end-to-end through the JSON round trip (D9).
    const revived = JSON.parse(JSON.stringify(frozen)) as typeof frozen
    expect(evaluateBool(revived.frozen.tripwireAsts[1]!, { stale_count: 2 })).toBe(true)
  })

  it('throws (instructive, multi-line) on an invalid charter', () => {
    expect(() => freezeCharter(walkResearchCharter({ goal: '' })))
      .toThrow(/charter failed validation/)
  })
})

describe('CharterStore', () => {
  it('versions monotonically and loads latest or pinned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-charter-'))
    const store = new CharterStore(dir)
    const r1 = await store.save(walkResearchCharter())
    const r2 = await store.save(walkResearchCharter({ goal: '修订后的目标：加入接触相位约束。' }))
    expect([r1.version, r2.version]).toEqual([1, 2])
    expect((await store.load('walk-research'))!.goal).toContain('修订后')
    expect((await store.load('walk-research', 1))!.goal).toContain('长周期自主研究')
    expect(await store.latestVersion('walk-research')).toBe(2)
    expect(await store.load('nope')).toBeNull()
  })

  it('refuses to persist an invalid charter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-charter-bad-'))
    const store = new CharterStore(dir)
    await expect(store.save(walkResearchCharter({ tripwires: [] })))
      .rejects.toThrow(/refusing to save/)
  })
})
