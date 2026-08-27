/**
 * Case extraction from real trajectories (G1-8).
 *
 * Two properties carry this module, and both come from findings rather than
 * from the original design:
 *
 *   §15.6  A task spans several runs. 44.3% of the real corpus ends in
 *          `parked`, so extracting one case per run would capture only the
 *          tail of long tasks or cut one task into fragments — and both produce
 *          cases that look entirely normal while measuring the wrong thing.
 *
 *   The chain's starting point is the FIRST run's base. A later run's base is
 *   mid-task state that already contains part of the answer, so a case built on
 *   it would pass without the candidate doing the work.
 *
 * The third theme is refusal: the extractor must never emit something that
 * could be mistaken for a finished case.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  groupRunsIntoChains,
  extractFromTrajectoryLines,
  extractCaseCandidates,
  formatExtractionReport,
  summarise,
  MISSING_FIELDS,
  type RunLink,
} from '../CaseExtractor.js'
import type { PreservedTrajectoryLine } from '../../trajectory/types.js'

const TRAJ = '00000000-0000-4000-8000-0000000000cc'
const CLEAN = { commit: 'a'.repeat(40), branch: 'main', dirty: false, untracked: false }
const DIRTY = { commit: 'b'.repeat(40), branch: 'main', dirty: true, untracked: false }

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function run(ordinal: number, outcome?: string, gitBase?: object): RunLink {
  return {
    runId: `run-${ordinal}`,
    startedAtOrdinal: ordinal,
    startedAt: ordinal * 1000,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(gitBase ? { gitBase: gitBase as RunLink['gitBase'] } : {}),
  }
}

describe('groupRunsIntoChains — parked continues, everything else ends', () => {
  it('joins a park/wake pair into one task', () => {
    const chains = groupRunsIntoChains([run(1, 'parked'), run(2, 'success')])
    expect(chains).toHaveLength(1)
    expect(chains[0]!.map(r => r.startedAtOrdinal)).toEqual([1, 2])
  })

  it('joins a long park chain', () => {
    const chains = groupRunsIntoChains([
      run(1, 'parked'), run(2, 'parked'), run(3, 'parked'), run(4, 'success'),
    ])
    expect(chains).toHaveLength(1)
    expect(chains[0]).toHaveLength(4)
  })

  it('splits consecutive completed runs into separate tasks', () => {
    const chains = groupRunsIntoChains([run(1, 'success'), run(2, 'success')])
    expect(chains).toHaveLength(2)
  })

  it('ends a chain on failure, not only on success', () => {
    const chains = groupRunsIntoChains([
      run(1, 'parked'), run(2, 'error_during_execution'), run(3, 'success'),
    ])
    expect(chains.map(c => c.length)).toEqual([2, 1])
  })

  it('keeps a trailing unterminated run as its own chain', () => {
    // An unfinished task is a real thing the corpus should be able to count.
    const chains = groupRunsIntoChains([run(1, 'success'), run(2)])
    expect(chains).toHaveLength(2)
    expect(chains[1]![0]!.outcome).toBeUndefined()
  })

  it('returns nothing for no runs', () => {
    expect(groupRunsIntoChains([])).toEqual([])
  })
})

describe('extractFromTrajectoryLines', () => {
  function lines(items: Array<{ ordinal: number; runId?: string; item: Record<string, unknown> }>): PreservedTrajectoryLine[] {
    return items.map(entry => ({
      schemaVersion: 'trajectory-line-1.0' as const,
      ts: entry.ordinal * 1000,
      ordinal: entry.ordinal,
      trajectoryId: TRAJ,
      ...(entry.runId !== undefined ? { runId: entry.runId } : {}),
      item: entry.item as PreservedTrajectoryLine['item'],
      knownItem: true,
      rawLine: '',
    }))
  }

  const meta = { ordinal: 1, item: { type: 'trajectory_meta', subject: { kind: 'session', sessionId: TRAJ }, mode: 'auto', createdAt: 1 } }

  it('takes the chain start from the FIRST run, not the last', () => {
    // The property everything rests on. Run 2 starts dirty mid-task; using its
    // base would describe a starting state that already contains the work.
    const candidates = extractFromTrajectoryLines(TRAJ, lines([
      meta,
      { ordinal: 2, runId: 'r1', item: { type: 'run_started', reason: 'submit', gitBase: CLEAN } },
      { ordinal: 3, runId: 'r1', item: { type: 'run_result', outcome: 'parked', isError: false } },
      { ordinal: 4, runId: 'r2', item: { type: 'run_started', reason: 'self_timer', gitBase: DIRTY } },
      { ordinal: 5, runId: 'r2', item: { type: 'run_result', outcome: 'success', isError: false } },
    ]))

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.chainStartGitBase?.commit).toBe(CLEAN.commit)
    expect(candidates[0]!.environmentFidelity).toBe('restored')
    expect(candidates[0]!.runs).toHaveLength(2)
    expect(candidates[0]!.parkedRuns).toBe(1)
  })

  it('marks a chain that began dirty as approximated, not restored', () => {
    const candidates = extractFromTrajectoryLines(TRAJ, lines([
      meta,
      { ordinal: 2, runId: 'r1', item: { type: 'run_started', reason: 'submit', gitBase: DIRTY } },
      { ordinal: 3, runId: 'r1', item: { type: 'run_result', outcome: 'success', isError: false } },
    ]))
    expect(candidates[0]!.environmentFidelity).toBe('approximated')
    expect(candidates[0]!.missing).toContain(MISSING_FIELDS.CLEAN_START)
  })

  it('marks a chain with no gitBase as unrestorable', () => {
    // Every run written before item schema 1.3.0 lands here.
    const candidates = extractFromTrajectoryLines(TRAJ, lines([
      meta,
      { ordinal: 2, runId: 'r1', item: { type: 'run_started', reason: 'submit' } },
      { ordinal: 3, runId: 'r1', item: { type: 'run_result', outcome: 'success', isError: false } },
    ]))
    expect(candidates[0]!.environmentFidelity).toBe('unrestorable')
    expect(candidates[0]!.missing).toContain(MISSING_FIELDS.GIT_BASE)
  })

  it('attributes each prompt to its own chain', () => {
    // Without a bound on the prompt window, a chain with no user message would
    // adopt the next task's prompt and describe work it never did.
    const candidates = extractFromTrajectoryLines(TRAJ, lines([
      meta,
      { ordinal: 2, runId: 'r1', item: { type: 'run_started', reason: 'submit', gitBase: CLEAN } },
      { ordinal: 3, runId: 'r1', item: { type: 'message', message: { role: 'user', content: 'first task' } } },
      { ordinal: 4, runId: 'r1', item: { type: 'run_result', outcome: 'success', isError: false } },
      { ordinal: 5, runId: 'r2', item: { type: 'run_started', reason: 'submit', gitBase: CLEAN } },
      { ordinal: 6, runId: 'r2', item: { type: 'message', message: { role: 'user', content: 'second task' } } },
      { ordinal: 7, runId: 'r2', item: { type: 'run_result', outcome: 'success', isError: false } },
    ]))

    expect(candidates.map(c => c.prompt)).toEqual(['first task', 'second task'])
  })

  it('does not borrow a later chain\'s prompt', () => {
    const candidates = extractFromTrajectoryLines(TRAJ, lines([
      meta,
      { ordinal: 2, runId: 'r1', item: { type: 'run_started', reason: 'submit', gitBase: CLEAN } },
      { ordinal: 3, runId: 'r1', item: { type: 'run_result', outcome: 'success', isError: false } },
      { ordinal: 4, runId: 'r2', item: { type: 'run_started', reason: 'submit', gitBase: CLEAN } },
      { ordinal: 5, runId: 'r2', item: { type: 'message', message: { role: 'user', content: 'only the second chain asked this' } } },
      { ordinal: 6, runId: 'r2', item: { type: 'run_result', outcome: 'success', isError: false } },
    ]))

    expect(candidates[0]!.prompt).toBeUndefined()
    expect(candidates[0]!.missing).toContain(MISSING_FIELDS.PROMPT)
    expect(candidates[1]!.prompt).toBe('only the second chain asked this')
  })

  it('reads text out of structured message content', () => {
    const candidates = extractFromTrajectoryLines(TRAJ, lines([
      meta,
      { ordinal: 2, runId: 'r1', item: { type: 'run_started', reason: 'submit', gitBase: CLEAN } },
      {
        ordinal: 3, runId: 'r1',
        item: { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'blocks work too' }] } },
      },
      { ordinal: 4, runId: 'r1', item: { type: 'run_result', outcome: 'success', isError: false } },
    ]))
    expect(candidates[0]!.prompt).toBe('blocks work too')
  })

  it('produces a stable id so re-extraction is idempotent', () => {
    const input = lines([
      meta,
      { ordinal: 2, runId: 'r1', item: { type: 'run_started', reason: 'submit', gitBase: CLEAN } },
      { ordinal: 3, runId: 'r1', item: { type: 'run_result', outcome: 'success', isError: false } },
    ])
    expect(extractFromTrajectoryLines(TRAJ, input)[0]!.candidateId)
      .toBe(extractFromTrajectoryLines(TRAJ, input)[0]!.candidateId)
  })
})

describe('the extractor never finalises a case', () => {
  const candidate = () => extractFromTrajectoryLines(TRAJ, [{
    schemaVersion: 'trajectory-line-1.0' as const,
    ts: 1, ordinal: 1, trajectoryId: TRAJ, runId: 'r1',
    item: { type: 'run_started', reason: 'submit', gitBase: CLEAN } as PreservedTrajectoryLine['item'],
    knownItem: true, rawLine: '',
  }, {
    schemaVersion: 'trajectory-line-1.0' as const,
    ts: 2, ordinal: 2, trajectoryId: TRAJ, runId: 'r1',
    item: { type: 'run_result', outcome: 'success', isError: false } as PreservedTrajectoryLine['item'],
    knownItem: true, rawLine: '',
  }])[0]!

  it('always suggests the support split, even for a perfect chain', () => {
    // Anything else would be the extractor making a curation call it has no
    // basis for: there are no criteria and no deterministic check.
    expect(candidate().suggestedSplit).toBe('support')
  })

  it('lists every field a human still has to supply', () => {
    const missing = candidate().missing
    for (const field of [
      MISSING_FIELDS.SUCCESS_CRITERIA,
      MISSING_FIELDS.EVALUATOR_BUNDLE,
      MISSING_FIELDS.ELIGIBILITY,
      MISSING_FIELDS.RESET_RECIPE,
      MISSING_FIELDS.ENVIRONMENT_MANIFEST,
      MISSING_FIELDS.CONTAMINATION_GROUP,
      MISSING_FIELDS.TASK_FAMILY,
      MISSING_FIELDS.RISK_TIER,
    ]) {
      expect(missing).toContain(field)
    }
  })

  it('emits a candidate schema version distinct from eval-case', () => {
    // So nothing downstream can mistake a draft for a validated case.
    expect(candidate().schemaVersion).toBe('eval-case-candidate-1.0')
  })
})

describe('reporting', () => {
  it('counts park/wake chains separately from single-run ones', () => {
    const report = summarise([
      { ...stub(), runs: [run(1, 'parked'), run(2, 'success')], completed: true },
      { ...stub(), runs: [run(3, 'success')], completed: true },
    ], 1)
    expect(report.multiRunChains).toBe(1)
    expect(report.chains).toBe(2)
  })

  it('says so plainly when nothing is worth curating', () => {
    const text = formatExtractionReport(summarise([
      { ...stub(), environmentFidelity: 'unrestorable', completed: true },
    ], 1))
    expect(text).toContain('none — no chain both completed and started from a restorable state')
  })

  it('always states that the output is drafts', () => {
    const text = formatExtractionReport(summarise([stub()], 1))
    expect(text).toContain('DRAFTS, not eval cases')
  })

  it('scans an empty store without failing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'meta-agent-extract-'))
    tempDirs.push(home)
    const report = await extractCaseCandidates({ rootDir: home })
    expect(report).toMatchObject({ trajectories: 0, chains: 0 })
  })

  it('reads trajectories from disk through the real reader', async () => {
    const home = await mkdtemp(join(tmpdir(), 'meta-agent-extract-'))
    tempDirs.push(home)
    const dir = join(home, 'trajectories', TRAJ)
    await mkdir(dir, { recursive: true })
    const runId = '11111111-1111-4111-8111-111111111111'
    await writeFile(join(dir, 'trajectory.jsonl'), [
      JSON.stringify({
        schemaVersion: 'trajectory-line-1.0', ts: 1, ordinal: 1, trajectoryId: TRAJ,
        item: { type: 'trajectory_meta', subject: { kind: 'session', sessionId: TRAJ }, mode: 'auto', createdAt: 1 },
      }),
      JSON.stringify({
        schemaVersion: 'trajectory-line-1.0', ts: 2, ordinal: 2, trajectoryId: TRAJ, runId,
        item: { type: 'run_started', reason: 'submit', gitBase: CLEAN },
      }),
      JSON.stringify({
        schemaVersion: 'trajectory-line-1.0', ts: 3, ordinal: 3, trajectoryId: TRAJ, runId,
        item: { type: 'run_result', outcome: 'success', isError: false },
      }),
    ].join('\n') + '\n')

    const report = await extractCaseCandidates({ rootDir: home })
    expect(report.trajectories).toBe(1)
    expect(report.chains).toBe(1)
    expect(report.restorableChains).toBe(1)
  })
})

function stub() {
  return {
    schemaVersion: 'eval-case-candidate-1.0' as const,
    candidateId: 'evalcand_' + 'a'.repeat(24),
    rootTrajectoryId: TRAJ,
    runs: [run(1, 'success')],
    parkedRuns: 0,
    environmentFidelity: 'restored' as const,
    suggestedSplit: 'support' as const,
    missing: [],
    completed: true,
  }
}
