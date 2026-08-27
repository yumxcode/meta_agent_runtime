/**
 * Corpus survey (§10.3).
 *
 * Every statistical mechanism from G1 onward assumes a corpus that may not
 * exist. The survey's job is to say how big it really is *before* the
 * machinery gets built on the assumption.
 *
 * The tests that matter most are the ones about honesty rather than counting:
 *
 *   - the headline number is a ceiling, and the dimensions that make it only a
 *     ceiling are reported rather than scored zero;
 *   - `parked` is not an abnormal termination, so it must not inflate the
 *     survivorship signal;
 *   - a run with no result is surveyed, not dropped — silently omitting
 *     unterminated runs is itself the bias the rate exists to expose.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import {
  surveyTrajectoryLines,
  aggregateCorpusSurvey,
  formatCorpusSurvey,
  surveyCorpus,
  CORPUS_BLOCKERS,
  G1_MINIMUM_REEXECUTABLE_CASES,
} from '../CorpusSurvey.js'
import type { PreservedTrajectoryLine } from '../../trajectory/types.js'

const TRAJ = '00000000-0000-4000-8000-000000000001'

let ordinal = 0
function line(
  item: Record<string, unknown>,
  runId = 'run-1',
): PreservedTrajectoryLine {
  ordinal += 1
  return {
    schemaVersion: 'trajectory-line-1.0',
    ts: ordinal,
    ordinal,
    trajectoryId: TRAJ,
    runId,
    item: item as PreservedTrajectoryLine['item'],
    knownItem: true,
    rawLine: JSON.stringify(item),
  }
}

function cleanBase() {
  return { commit: 'a'.repeat(40), branch: 'main', dirty: false, untracked: false }
}

function run(opts: {
  runId?: string
  gitBase?: Record<string, unknown>
  outcome?: string
}): PreservedTrajectoryLine[] {
  const runId = opts.runId ?? 'run-1'
  const lines = [line({
    type: 'run_started',
    reason: 'submit',
    ...(opts.gitBase ? { gitBase: opts.gitBase } : {}),
  }, runId)]
  if (opts.outcome !== undefined) {
    lines.push(line({ type: 'run_result', outcome: opts.outcome, isError: false }, runId))
  }
  return lines
}

describe('surveyTrajectoryLines', () => {
  it('counts a clean successful run as unblocked', () => {
    const surveys = surveyTrajectoryLines(TRAJ, run({ gitBase: cleanBase(), outcome: 'success' }))
    expect(surveys).toHaveLength(1)
    expect(surveys[0]).toMatchObject({ hasGitBase: true, cleanStart: true, blockers: [] })
  })

  it('blocks a run with no gitBase', () => {
    // Every run written before item schema 1.3.0 is in this bucket, which is
    // exactly what makes the pre-G1-1 corpus unusable for re-execution.
    const surveys = surveyTrajectoryLines(TRAJ, run({ outcome: 'success' }))
    expect(surveys[0]!.blockers).toContain(CORPUS_BLOCKERS.NO_GIT_BASE)
    expect(surveys[0]!.hasGitBase).toBe(false)
  })

  it('blocks a dirty start even though a commit was recorded', () => {
    // The commit is present but is not where the run actually began.
    const surveys = surveyTrajectoryLines(TRAJ, run({
      gitBase: { ...cleanBase(), dirty: true },
      outcome: 'success',
    }))
    expect(surveys[0]!.cleanStart).toBe(false)
    expect(surveys[0]!.blockers).toContain(CORPUS_BLOCKERS.DIRTY_START)
  })

  it('blocks an untracked start separately from a dirty one', () => {
    const surveys = surveyTrajectoryLines(TRAJ, run({
      gitBase: { ...cleanBase(), untracked: true },
      outcome: 'success',
    }))
    expect(surveys[0]!.blockers).toContain(CORPUS_BLOCKERS.UNTRACKED_START)
    expect(surveys[0]!.blockers).not.toContain(CORPUS_BLOCKERS.DIRTY_START)
  })

  it('blocks a run that did not end in success', () => {
    for (const outcome of ['error_max_turns', 'error_during_execution', 'interrupted', 'parked']) {
      const surveys = surveyTrajectoryLines(TRAJ, run({ gitBase: cleanBase(), outcome }))
      expect(surveys[0]!.blockers, outcome).toContain(CORPUS_BLOCKERS.INCOMPLETE_RUN)
    }
  })

  it('surveys a run that never produced a result', () => {
    // Dropping unterminated runs would quietly improve every rate below.
    const surveys = surveyTrajectoryLines(TRAJ, run({ gitBase: cleanBase() }))
    expect(surveys[0]!.outcome).toBe('no_result')
    expect(surveys[0]!.blockers).toContain(CORPUS_BLOCKERS.INCOMPLETE_RUN)
  })

  it('pairs results with their own run when several runs share a trajectory', () => {
    const surveys = surveyTrajectoryLines(TRAJ, [
      ...run({ runId: 'run-a', gitBase: cleanBase(), outcome: 'success' }),
      ...run({ runId: 'run-b', gitBase: cleanBase(), outcome: 'error_max_turns' }),
    ])
    expect(surveys.map(s => s.outcome)).toEqual(['success', 'error_max_turns'])
  })

  it('ignores lines it does not understand', () => {
    const unknown: PreservedTrajectoryLine = {
      ...line({ type: 'from_the_future' }),
      knownItem: false,
    }
    expect(surveyTrajectoryLines(TRAJ, [unknown, ...run({ gitBase: cleanBase(), outcome: 'success' })]))
      .toHaveLength(1)
  })
})

describe('aggregateCorpusSurvey', () => {
  it('reports the ceiling and whether G1 can proceed', () => {
    const runs = surveyTrajectoryLines(TRAJ, [
      ...run({ runId: 'a', gitBase: cleanBase(), outcome: 'success' }),
      ...run({ runId: 'b', gitBase: cleanBase(), outcome: 'success' }),
      ...run({ runId: 'c', outcome: 'success' }),
    ])
    const report = aggregateCorpusSurvey(runs, 1)

    expect(report.runs).toBe(3)
    expect(report.reExecutableCeiling).toBe(2)
    expect(report.meetsG1Threshold).toBe(false)
    expect(G1_MINIMUM_REEXECUTABLE_CASES).toBe(15)
  })

  it('does not count parked runs as abnormal terminations', () => {
    // A planned suspension is not a lost run. Counting it would inflate the
    // very survivorship signal this rate exists to expose.
    const runs = surveyTrajectoryLines(TRAJ, [
      ...run({ runId: 'a', gitBase: cleanBase(), outcome: 'parked' }),
      ...run({ runId: 'b', gitBase: cleanBase(), outcome: 'success' }),
    ])
    const report = aggregateCorpusSurvey(runs, 1)

    expect(report.abnormalTerminationRate).toBe(0)
    // Still unusable as a case, for a different reason.
    expect(report.reExecutableCeiling).toBe(1)
  })

  it('counts genuine failures in the abnormal rate', () => {
    const runs = surveyTrajectoryLines(TRAJ, [
      ...run({ runId: 'a', gitBase: cleanBase(), outcome: 'error_during_execution' }),
      ...run({ runId: 'b', gitBase: cleanBase(), outcome: 'success' }),
    ])
    expect(aggregateCorpusSurvey(runs, 1).abnormalTerminationRate).toBe(0.5)
  })

  it('ranks blockers so the binding constraint is obvious', () => {
    const runs = surveyTrajectoryLines(TRAJ, [
      ...run({ runId: 'a', outcome: 'success' }),
      ...run({ runId: 'b', outcome: 'success' }),
      ...run({ runId: 'c', gitBase: { ...cleanBase(), dirty: true }, outcome: 'success' }),
    ])
    expect(aggregateCorpusSurvey(runs, 1).blockerCounts[0])
      .toEqual({ blocker: CORPUS_BLOCKERS.NO_GIT_BASE, runs: 2 })
  })

  it('handles an empty corpus without dividing by zero', () => {
    const report = aggregateCorpusSurvey([], 0)
    expect(report.runs).toBe(0)
    expect(report.abnormalTerminationRate).toBe(0)
    expect(report.meetsG1Threshold).toBe(false)
  })

  it('always reports the dimensions it cannot measure', () => {
    // The headline number is a ceiling precisely because of these. Scoring them
    // zero would confuse "no instrument" with "measured and empty", and those
    // two call for opposite responses.
    const report = aggregateCorpusSurvey([], 0)
    const dimensions = report.unmeasured.map(u => u.dimension)
    expect(dimensions).toContain('training_eligibility')
    expect(dimensions).toContain('t2_check_coverage')
    expect(dimensions).toContain('environment_beyond_git')
    for (const entry of report.unmeasured) expect(entry.reason.length).toBeGreaterThan(20)
  })
})

describe('growth and mode breakdown (§10.3)', () => {
  const DAY = 24 * 60 * 60 * 1000
  // A real wall-clock base: epoch 0 is not a plausible run timestamp and the
  // survey filters it out as such.
  const BASE = Date.UTC(2026, 0, 1)

  function runAt(ts: number, opts: { outcome?: string; gitBase?: Record<string, unknown> } = {}) {
    const runId = `${ts}`
    const lines: PreservedTrajectoryLine[] = [{
      schemaVersion: 'trajectory-line-1.0', ts, ordinal: 1, trajectoryId: TRAJ, runId,
      item: {
        type: 'run_started', reason: 'submit',
        ...(opts.gitBase ? { gitBase: opts.gitBase } : {}),
      } as PreservedTrajectoryLine['item'],
      knownItem: true, rawLine: '',
    }]
    if (opts.outcome) {
      lines.push({
        schemaVersion: 'trajectory-line-1.0', ts: ts + 1, ordinal: 2, trajectoryId: TRAJ, runId,
        item: { type: 'run_result', outcome: opts.outcome, isError: false } as PreservedTrajectoryLine['item'],
        knownItem: true, rawLine: '',
      })
    }
    return lines
  }

  it('measures the observed window and the per-week rate', () => {
    const runs = surveyTrajectoryLines(TRAJ, [
      ...runAt(BASE, { gitBase: cleanBase(), outcome: 'success' }),
      ...runAt(BASE + 14 * DAY, { gitBase: cleanBase(), outcome: 'success' }),
    ])
    const growth = aggregateCorpusSurvey(runs, 1).growth
    expect(growth.observedDays).toBeCloseTo(14, 1)
    expect(growth.runsPerWeek).toBeCloseTo(1, 1)
  })

  it('refuses to project from a zero qualifying rate', () => {
    // The whole pre-gitBase corpus is in this state. Printing a huge number of
    // weeks would read as a schedule; null reads as "no basis", which is true.
    const runs = surveyTrajectoryLines(TRAJ, [
      ...runAt(BASE, { outcome: 'success' }),
      ...runAt(BASE + 14 * DAY, { outcome: 'success' }),
    ])
    const growth = aggregateCorpusSurvey(runs, 1).growth
    expect(growth.qualifyingRunsPerWeek).toBe(0)
    expect(growth.weeksToThreshold).toBeNull()
  })

  it('declines to annualise a corpus produced inside one day', () => {
    // Dividing by a near-zero span turns one busy afternoon into an enormous
    // weekly rate.
    const runs = surveyTrajectoryLines(TRAJ, [
      ...runAt(BASE, { gitBase: cleanBase(), outcome: 'success' }),
      ...runAt(BASE + 60_000, { gitBase: cleanBase(), outcome: 'success' }),
    ])
    const growth = aggregateCorpusSurvey(runs, 2).growth
    expect(growth.runsPerWeek).toBe(0)
    expect(growth.weeksToThreshold).toBeNull()
  })

  it('reports zero weeks once the threshold is already met', () => {
    // The qualifying count is derived from the runs themselves, not passed in —
    // so the corpus has to genuinely contain enough usable runs.
    const lines = Array.from({ length: G1_MINIMUM_REEXECUTABLE_CASES }, (_, i) =>
      runAt(BASE + i * DAY, { gitBase: cleanBase(), outcome: 'success' })).flat()
    const report = aggregateCorpusSurvey(surveyTrajectoryLines(TRAJ, lines), 1)

    expect(report.reExecutableCeiling).toBe(G1_MINIMUM_REEXECUTABLE_CASES)
    expect(report.meetsG1Threshold).toBe(true)
    expect(report.growth.weeksToThreshold).toBe(0)
  })

  it('separates modes an eval case cannot represent', () => {
    // campaign spans too long to replay and robotics needs real hardware, so
    // counting them in the denominator understates the usable corpus.
    const lines: PreservedTrajectoryLine[] = [
      {
        schemaVersion: 'trajectory-line-1.0', ts: 1, ordinal: 1, trajectoryId: TRAJ,
        item: {
          type: 'trajectory_meta',
          subject: { kind: 'session', sessionId: TRAJ },
          mode: 'robotics', createdAt: 1,
        } as PreservedTrajectoryLine['item'],
        knownItem: true, rawLine: '',
      },
      ...runAt(BASE, { gitBase: cleanBase(), outcome: 'success' }),
    ]
    const report = aggregateCorpusSurvey(surveyTrajectoryLines(TRAJ, lines), 1)
    expect(report.byMode).toEqual([{ mode: 'robotics', runs: 1, caseEligible: false }])
    expect(report.caseEligibleModeRuns).toBe(0)
  })

  it('counts agentic and auto runs as case-eligible', () => {
    for (const mode of ['agentic', 'auto', 'simple_auto']) {
      const lines: PreservedTrajectoryLine[] = [
        {
          schemaVersion: 'trajectory-line-1.0', ts: 1, ordinal: 1, trajectoryId: TRAJ,
          item: {
            type: 'trajectory_meta',
            subject: { kind: 'session', sessionId: TRAJ },
            mode, createdAt: 1,
          } as PreservedTrajectoryLine['item'],
          knownItem: true, rawLine: '',
        },
        ...runAt(BASE, { gitBase: cleanBase(), outcome: 'success' }),
      ]
      expect(aggregateCorpusSurvey(surveyTrajectoryLines(TRAJ, lines), 1).caseEligibleModeRuns, mode).toBe(1)
    }
  })
})

describe('surveyCorpus — through the real reader', () => {
  it('reads trajectory files from disk and reports on them', async () => {
    // The unit tests above hand `surveyTrajectoryLines` pre-parsed lines, which
    // skips envelope validation entirely. This one goes through the same reader
    // the CLI uses, so a fixture that the real schema rejects cannot pass.
    const home = await mkdtemp(join(tmpdir(), 'meta-agent-corpus-'))
    try {
      const trajectoryId = '00000000-0000-4000-8000-0000000000aa'
      const runId = '11111111-1111-4111-8111-111111111111'
      const dir = join(home, 'trajectories', trajectoryId)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'trajectory.jsonl'), [
        JSON.stringify({
          schemaVersion: 'trajectory-line-1.0', ts: 1, ordinal: 1, trajectoryId,
          item: {
            type: 'trajectory_meta',
            subject: { kind: 'session', sessionId: trajectoryId },
            mode: 'agentic', createdAt: 1,
          },
        }),
        JSON.stringify({
          schemaVersion: 'trajectory-line-1.0', ts: 2, ordinal: 2, trajectoryId, runId,
          item: { type: 'run_started', reason: 'submit', gitBase: cleanBase() },
        }),
        JSON.stringify({
          schemaVersion: 'trajectory-line-1.0', ts: 3, ordinal: 3, trajectoryId, runId,
          item: { type: 'run_result', outcome: 'success', isError: false },
        }),
      ].join('\n') + '\n')

      const report = await surveyCorpus({ rootDir: home })
      expect(report.trajectories).toBe(1)
      expect(report.runs).toBe(1)
      expect(report.reExecutableCeiling).toBe(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('reports an empty corpus rather than failing when nothing exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'meta-agent-corpus-empty-'))
    try {
      const report = await surveyCorpus({ rootDir: home })
      expect(report).toMatchObject({ trajectories: 0, runs: 0, meetsG1Threshold: false })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('formatCorpusSurvey', () => {
  it('states that the ceiling is an upper bound, not an estimate', () => {
    // A reader who skims the number and misses the caveat will over-read it,
    // so the caveat is printed last and in full.
    const text = formatCorpusSurvey(aggregateCorpusSurvey(
      surveyTrajectoryLines(TRAJ, run({ gitBase: cleanBase(), outcome: 'success' })), 1,
    ))
    expect(text).toContain('NOT MEASURED')
    expect(text).toContain('upper bound, not an estimate')
    expect(text).toContain('training_eligibility')
  })

  it('renders an empty corpus without NaN percentages', () => {
    const text = formatCorpusSurvey(aggregateCorpusSurvey([], 0))
    expect(text).not.toContain('NaN')
    expect(text).toContain('G1 threshold met       NO')
  })
})
