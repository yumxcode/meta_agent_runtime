/**
 * EvalSetStore (G1-4).
 *
 * The interesting behaviour here is what the store *refuses*. Both refusals
 * exist because the alternative failure is silent:
 *
 *   - growing a frozen set retroactively changes the population that every
 *     already-computed result claims to describe, and nothing anywhere would
 *     report that those results are now wrong;
 *   - admitting a case that straddles a split turns memorisation into a good
 *     score, and the number looks entirely normal.
 *
 * The concurrency test covers the read-modify-write that would otherwise drop a
 * case with no error at all.
 */
import { mkdtemp, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { EvalSetStore, EvalSetStoreError } from '../EvalSetStore.js'
import type { EvalCase, EvalSet } from '../types.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function store(): Promise<EvalSetStore> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-evalset-'))
  tempDirs.push(dir)
  return new EvalSetStore(dir)
}

let caseCounter = 0
function evalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  caseCounter += 1
  return {
    schemaVersion: 'eval-case-2.0',
    id: `evalcase_${caseCounter.toString(16).padStart(24, '0')}`,
    origin: {
      caseId: `case-${caseCounter}`,
      rootTrajectoryId: '00000000-0000-4000-8000-000000000001',
      taskReviewId: 'review-1',
    },
    prompt: 'Fix the failing test',
    mode: 'agentic',
    eligibilityRef: 'elig-1',
    baseSnapshotRef: `basesnap_${'b'.repeat(24)}`,
    environmentManifestRef: 'envman-1',
    evaluatorBundleRef: 'bundle-1',
    resetRecipeRef: 'reset-1',
    criteriaOrigin: 'human_curated',
    contaminationGroupId: `group-${caseCounter}`,
    riskTier: 'R1',
    successCriteria: [{ id: 'c1', statement: 'the test passes', checkRef: 'bundle-1#test' }],
    replayClass: 'deterministic',
    environmentFidelity: 'restored',
    split: 'validation',
    frozenAt: 1_700_000_000_000,
    ...overrides,
  } as EvalCase
}

function evalSet(overrides: Partial<EvalSet> = {}): EvalSet {
  return {
    schemaVersion: 'eval-set-1.0',
    id: 'evalset_batch-one',
    name: 'Batch one',
    createdAt: 1_700_000_000_000,
    caseIds: [],
    ...overrides,
  } as EvalSet
}

describe('EvalSetStore — round trip', () => {
  it('writes and reads a case', async () => {
    const s = await store()
    const c = evalCase()
    await s.writeCase(c)
    expect(await s.loadCase(c.id)).toEqual(c)
  })

  it('returns null for a case that was never written', async () => {
    const s = await store()
    expect(await s.loadCase(`evalcase_${'f'.repeat(24)}`)).toBeNull()
  })

  it('creates its directories with owner-only permissions', async () => {
    // These hold prompts and workspace paths recovered from real sessions.
    const s = await store()
    await s.ensureDirs()
    expect((await stat(s.casesDir)).mode & 0o777).toBe(0o700)
  })

  it('refuses ids that would escape the store directory', async () => {
    const s = await store()
    await expect(s.loadCase('../../etc/passwd')).rejects.toThrow(EvalSetStoreError)
    await expect(s.loadSet('evalset_../../x')).rejects.toThrow(EvalSetStoreError)
  })

  it('validates before writing, so an invalid case never reaches disk', async () => {
    // A case that violates the split rules must not be readable later by
    // something that trusts what it loads.
    const s = await store()
    await expect(s.writeCase(evalCase({
      environmentFidelity: 'unrestorable',
      split: 'sealed_test',
    }))).rejects.toThrow()
  })

  it('treats a corrupted case file as absent rather than repairing it', async () => {
    // Coercing it would put a rule-violating case back into circulation.
    const s = await store()
    const c = evalCase()
    await s.writeCase(c)
    await writeFile(join(s.casesDir, `${c.id}.json`), '{"schemaVersion":"eval-case-2.0"}')
    expect(await s.loadCase(c.id)).toBeNull()
  })
})

describe('EvalSetStore — frozen sets are immutable', () => {
  it('accepts a case before freezing', async () => {
    const s = await store()
    const c = evalCase()
    await s.writeCase(c)
    await s.writeSet(evalSet())

    const updated = await s.addCaseToSet('evalset_batch-one', c.id)
    expect(updated.caseIds).toEqual([c.id])
  })

  it('refuses to add a case after freezing', async () => {
    const s = await store()
    const first = evalCase()
    const second = evalCase()
    await s.writeCase(first)
    await s.writeCase(second)
    await s.writeSet(evalSet())
    await s.addCaseToSet('evalset_batch-one', first.id)
    await s.freezeSet('evalset_batch-one')

    await expect(s.addCaseToSet('evalset_batch-one', second.id))
      .rejects.toThrow(/frozen/)
  })

  it('keeps the original freeze timestamp when frozen twice', async () => {
    // Every existing result refers to the original freeze; moving it would
    // quietly re-date the population those results describe.
    const s = await store()
    await s.writeSet(evalSet())
    const first = await s.freezeSet('evalset_batch-one', 1_000)
    const second = await s.freezeSet('evalset_batch-one', 9_999)
    expect(second.frozenAt).toBe(first.frozenAt)
    expect(second.frozenAt).toBe(1_000)
  })
})

describe('EvalSetStore — leakage is refused at write time', () => {
  it('rejects a case that would straddle two splits', async () => {
    // Caught here it is one refused write. Caught later it is a corpus
    // re-audit, and every number computed in between is suspect.
    const s = await store()
    const support = evalCase({ contaminationGroupId: 'shared', split: 'support' })
    const sealed = evalCase({ contaminationGroupId: 'shared', split: 'sealed_test' })
    await s.writeCase(support)
    await s.writeCase(sealed)
    await s.writeSet(evalSet())
    await s.addCaseToSet('evalset_batch-one', support.id)

    await expect(s.addCaseToSet('evalset_batch-one', sealed.id))
      .rejects.toThrow(/contamination group/)
  })

  it('allows two cases of one group inside the same split', async () => {
    const s = await store()
    const a = evalCase({ contaminationGroupId: 'shared', split: 'support' })
    const b = evalCase({ contaminationGroupId: 'shared', split: 'support' })
    await s.writeCase(a)
    await s.writeCase(b)
    await s.writeSet(evalSet())
    await s.addCaseToSet('evalset_batch-one', a.id)

    const updated = await s.addCaseToSet('evalset_batch-one', b.id)
    expect(updated.caseIds).toHaveLength(2)
  })

  it('rejects a case id that does not resolve', async () => {
    const s = await store()
    await s.writeSet(evalSet())
    await expect(s.addCaseToSet('evalset_batch-one', `evalcase_${'e'.repeat(24)}`))
      .rejects.toThrow(/not found/)
  })
})

describe('EvalSetStore — concurrency', () => {
  it('keeps every case when adds race', async () => {
    // Without the lock both adds read the same caseIds and the second write
    // silently drops the first case — no error, just a smaller corpus.
    const s = await store()
    const cases = [evalCase(), evalCase(), evalCase(), evalCase(), evalCase()]
    await Promise.all(cases.map(c => s.writeCase(c)))
    await s.writeSet(evalSet())

    await Promise.all(cases.map(c => s.addCaseToSet('evalset_batch-one', c.id)))

    const loaded = await s.loadSet('evalset_batch-one')
    expect(loaded?.caseIds.sort()).toEqual(cases.map(c => c.id).sort())
  })

  it('is idempotent when the same case is added twice', async () => {
    const s = await store()
    const c = evalCase()
    await s.writeCase(c)
    await s.writeSet(evalSet())
    await s.addCaseToSet('evalset_batch-one', c.id)

    const again = await s.addCaseToSet('evalset_batch-one', c.id)
    expect(again.caseIds).toEqual([c.id])
  })
})

describe('EvalSetStore — listing', () => {
  it('lists only well-formed ids', async () => {
    const s = await store()
    const c = evalCase()
    await s.writeCase(c)
    await writeFile(join(s.casesDir, 'not-a-case.json'), '{}')
    await writeFile(join(s.casesDir, 'README.txt'), 'x')

    expect(await s.listCaseIds()).toEqual([c.id])
  })

  it('loads the cases belonging to a set', async () => {
    const s = await store()
    const a = evalCase()
    const b = evalCase()
    await s.writeCase(a)
    await s.writeCase(b)
    await s.writeSet(evalSet())
    await s.addCaseToSet('evalset_batch-one', a.id)
    await s.addCaseToSet('evalset_batch-one', b.id)

    const loaded = await s.loadSetCases('evalset_batch-one')
    expect(loaded.map(c => c.id).sort()).toEqual([a.id, b.id].sort())
  })
})
