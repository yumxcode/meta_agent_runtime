/**
 * CorpusSurvey — how much of the existing trajectory corpus could become a
 * re-executable EvalCase (§10.3).
 *
 * Every statistical mechanism from G1 onward assumes a corpus that may not
 * exist. The plan is explicit that this has to be tracked from G0 rather than
 * discovered at G2, and that if the corpus is below threshold the statistical
 * design must be redone for small samples *now* — not after the machinery is
 * built on an assumption that turns out to be false.
 *
 * ── The distinction this module refuses to blur ─────────────────────────────
 *
 * Two dimensions of the "qualified case" definition have no data source yet:
 * training eligibility (G0-5's judgement CLI is unbuilt) and T2 deterministic
 * check coverage (evaluator bundles are G1-6). Reporting those as 0% would be
 * false — they are *unmeasured*, not measured-and-empty, and the difference
 * decides whether the right response is "collect more data" or "build the
 * missing instrument". So they are listed under `unmeasured` with the reason,
 * and the headline number is explicitly a ceiling rather than an estimate.
 *
 * This is the same discipline as `environmentFidelity`: a survey that cannot
 * see something says so instead of scoring it zero.
 */

import { readdir } from 'fs/promises'
import { trajectoriesRoot, trajectoryFile, type TrajectoryPathsOptions } from '../trajectory/paths.js'
import { readTrajectoryPreservingUnknown } from '../trajectory/reader.js'
import type { PreservedTrajectoryLine } from '../trajectory/types.js'

/**
 * G1's abort condition: fewer than this many genuinely re-executable cases
 * means the trajectories lack the acceptance evidence and environment records
 * an eval set needs, and the answer is to fix that rather than to assemble a
 * set out of fragments.
 */
export const G1_MINIMUM_REEXECUTABLE_CASES = 15

/** Why a run cannot currently become a re-executable case. */
export const CORPUS_BLOCKERS = {
  /** No gitBase on run_started — the field only ships from item schema 1.3.0. */
  NO_GIT_BASE: 'no_git_base',
  /** gitBase present but the working tree was dirty, so the commit is not the start. */
  DIRTY_START: 'dirty_start',
  /** gitBase present but untracked files existed, which live nowhere in git. */
  UNTRACKED_START: 'untracked_start',
  /**
   * The run did not end in `success`, so there is no completed task to build a
   * case around. Covers deliberate pauses (`parked`) as well as failures —
   * both are unusable as cases, for different reasons.
   */
  INCOMPLETE_RUN: 'incomplete_run',
} as const

export type CorpusBlocker = typeof CORPUS_BLOCKERS[keyof typeof CORPUS_BLOCKERS]

/**
 * The only outcome that represents a finished task.
 *
 * Taken from `ResultEvent.subtype`: success | parked | error_max_turns |
 * error_max_budget | error_max_output_tokens | error_during_execution, plus
 * `interrupted` / `abandoned` written by the abandoned-run path.
 */
const COMPLETED_OUTCOME = 'success'

/**
 * Outcomes that indicate a run ended badly, for the survivorship-bias read.
 *
 * `parked` is deliberately excluded: it is a planned suspension, not a lost
 * run, and counting it as an abnormal termination would inflate the very
 * signal this rate exists to expose.
 */
function isAbnormalOutcome(outcome: string): boolean {
  return outcome !== COMPLETED_OUTCOME && outcome !== 'parked'
}

/**
 * Modes an EvalCase can represent.
 *
 * `campaign` spans too long to re-execute and `robotics` depends on real
 * hardware, so runs in those modes are not corpus candidates at all — counting
 * them in the denominator would understate how usable the eligible corpus is.
 */
const CASE_ELIGIBLE_MODES = new Set(['agentic', 'auto', 'simple_auto'])

export interface RunSurvey {
  trajectoryId: string
  runId?: string
  startedAtOrdinal: number
  /** Session mode from trajectory_meta, when the trajectory declared one. */
  mode?: string
  /** Wall-clock time of run_started, for growth-rate measurement. */
  startedAt: number
  hasGitBase: boolean
  cleanStart: boolean
  outcome?: string
  blockers: CorpusBlocker[]
}

export interface UnmeasuredDimension {
  dimension: string
  reason: string
}

export interface CorpusSurveyReport {
  surveyedAt: number
  trajectories: number
  runs: number

  /** Runs carrying any starting point at all. */
  runsWithGitBase: number
  /** Runs whose starting point is a clean commit — the only fully restorable kind. */
  runsWithCleanStart: number
  runsWithDirtyStart: number
  runsWithUntrackedStart: number

  /** run_result outcomes, for the survivorship-bias read. */
  outcomes: Record<string, number>
  abnormalTerminationRate: number

  /**
   * Upper bound on re-executable cases: runs with a clean start that ended
   * normally. A ceiling, not an estimate — the eligibility and T2 dimensions
   * below are unmeasured and can only reduce it.
   */
  reExecutableCeiling: number
  meetsG1Threshold: boolean
  /** Frequency of each blocker across all runs, most common first. */
  blockerCounts: Array<{ blocker: CorpusBlocker; runs: number }>
  unmeasured: UnmeasuredDimension[]

  /** Runs per session mode, most common first. */
  byMode: Array<{ mode: string; runs: number; caseEligible: boolean }>
  /** Runs in modes an EvalCase can represent at all. */
  caseEligibleModeRuns: number
  growth: CorpusGrowth
}

/**
 * Observed production rate (§10.3).
 *
 * A snapshot answers "is the corpus big enough today"; the plan asks for the
 * growth rate, because the actionable question is "how long until it is". The
 * projection is deliberately conservative and refuses to extrapolate from
 * nothing — see `weeksToThreshold`.
 */
export interface CorpusGrowth {
  firstRunAt?: number
  lastRunAt?: number
  observedDays: number
  /** All runs, regardless of usability. */
  runsPerWeek: number
  /**
   * Runs per week that clear every blocker — the rate that actually matters.
   * Zero while gitBase has not been recorded long enough to appear.
   */
  qualifyingRunsPerWeek: number
  /**
   * Weeks until `reExecutableCeiling` reaches the G1 threshold at the observed
   * qualifying rate, or null when there is no basis to project.
   *
   * Null is the honest answer while the qualifying rate is zero: a projection
   * from zero qualifying runs is not "a long time", it is no information, and
   * printing a large number would invite someone to plan around it.
   */
  weeksToThreshold: number | null
}

/**
 * Dimensions the definition of "qualified" requires but nothing can currently
 * report. Held as data so the report cannot quietly omit them.
 */
const UNMEASURED: UnmeasuredDimension[] = [
  {
    dimension: 'training_eligibility',
    reason:
      'DataEligibility records are fail-closed by contract (G0-5) but nothing writes them yet, ' +
      'so no run has a decision. Absent is not denied, and neither is it granted.',
  },
  {
    dimension: 't2_check_coverage',
    reason:
      'A T2 check must live in a versioned evaluator bundle (G1-6), which does not exist. ' +
      'No run can be scored on whether its success criteria are deterministically checkable.',
  },
  {
    dimension: 'environment_beyond_git',
    reason:
      'Dependency locks, env whitelists and time/network simulation are not captured yet ' +
      '(G1-5 is at its minimum viable subset), so a clean git start is necessary but not sufficient.',
  },
]

function isKnown(line: PreservedTrajectoryLine): boolean {
  return line.knownItem
}

/**
 * Survey one trajectory's lines.
 *
 * A run is opened by `run_started` and closed by the next `run_result` sharing
 * its runId. A run with no result is still surveyed — an unterminated run is
 * exactly the kind of thing a survivorship read needs to see, and dropping it
 * would flatter the numbers.
 */
export function surveyTrajectoryLines(
  trajectoryId: string,
  lines: readonly PreservedTrajectoryLine[],
): RunSurvey[] {
  const runs: RunSurvey[] = []
  const byRunId = new Map<string, RunSurvey>()
  let mode: string | undefined

  for (const line of lines) {
    if (!isKnown(line)) continue
    const item = line.item as { type: string } & Record<string, unknown>

    if (item.type === 'trajectory_meta') {
      if (typeof item['mode'] === 'string') mode = item['mode']
      continue
    }

    if (item.type === 'run_started') {
      const gitBase = item['gitBase'] as
        { commit: string; dirty: boolean; untracked: boolean } | undefined
      const blockers: CorpusBlocker[] = []
      if (!gitBase) blockers.push(CORPUS_BLOCKERS.NO_GIT_BASE)
      if (gitBase?.dirty) blockers.push(CORPUS_BLOCKERS.DIRTY_START)
      if (gitBase?.untracked) blockers.push(CORPUS_BLOCKERS.UNTRACKED_START)

      const survey: RunSurvey = {
        trajectoryId,
        ...(line.runId !== undefined ? { runId: line.runId } : {}),
        ...(mode !== undefined ? { mode } : {}),
        startedAtOrdinal: line.ordinal,
        startedAt: line.ts,
        hasGitBase: Boolean(gitBase),
        cleanStart: Boolean(gitBase && !gitBase.dirty && !gitBase.untracked),
        blockers,
      }
      runs.push(survey)
      if (line.runId) byRunId.set(line.runId, survey)
      continue
    }

    if (item.type === 'run_result') {
      const survey = line.runId ? byRunId.get(line.runId) : runs[runs.length - 1]
      if (!survey) continue
      const outcome = typeof item['outcome'] === 'string' ? item['outcome'] : 'unknown'
      survey.outcome = outcome
      if (outcome !== COMPLETED_OUTCOME) survey.blockers.push(CORPUS_BLOCKERS.INCOMPLETE_RUN)
    }
  }

  // A run with no result never finished. Surveyed rather than dropped: silently
  // omitting unterminated runs is itself a survivorship bias.
  for (const run of runs) {
    if (run.outcome === undefined) {
      run.outcome = 'no_result'
      run.blockers.push(CORPUS_BLOCKERS.INCOMPLETE_RUN)
    }
  }

  return runs
}

/** Aggregate per-run surveys into the report. */
export function aggregateCorpusSurvey(
  runs: readonly RunSurvey[],
  trajectories: number,
  now: number = Date.now(),
): CorpusSurveyReport {
  const outcomes: Record<string, number> = {}
  const blockerCounts = new Map<CorpusBlocker, number>()
  const modeCounts = new Map<string, number>()

  let withGitBase = 0
  let cleanStart = 0
  let dirtyStart = 0
  let untrackedStart = 0
  let abnormal = 0
  let ceiling = 0

  for (const run of runs) {
    if (run.hasGitBase) withGitBase += 1
    if (run.cleanStart) cleanStart += 1
    const blockers = new Set(run.blockers)
    if (blockers.has(CORPUS_BLOCKERS.DIRTY_START)) dirtyStart += 1
    if (blockers.has(CORPUS_BLOCKERS.UNTRACKED_START)) untrackedStart += 1
    if (run.outcome !== undefined && isAbnormalOutcome(run.outcome)) abnormal += 1
    if (blockers.size === 0) ceiling += 1

    outcomes[run.outcome ?? 'unknown'] = (outcomes[run.outcome ?? 'unknown'] ?? 0) + 1
    for (const blocker of blockers) {
      blockerCounts.set(blocker, (blockerCounts.get(blocker) ?? 0) + 1)
    }
    const mode = run.mode ?? 'unknown'
    modeCounts.set(mode, (modeCounts.get(mode) ?? 0) + 1)
  }

  const byMode = [...modeCounts.entries()]
    .map(([mode, count]) => ({ mode, runs: count, caseEligible: CASE_ELIGIBLE_MODES.has(mode) }))
    .sort((a, b) => b.runs - a.runs || a.mode.localeCompare(b.mode))

  return {
    surveyedAt: now,
    trajectories,
    runs: runs.length,
    runsWithGitBase: withGitBase,
    runsWithCleanStart: cleanStart,
    runsWithDirtyStart: dirtyStart,
    runsWithUntrackedStart: untrackedStart,
    outcomes,
    abnormalTerminationRate: runs.length === 0 ? 0 : abnormal / runs.length,
    reExecutableCeiling: ceiling,
    meetsG1Threshold: ceiling >= G1_MINIMUM_REEXECUTABLE_CASES,
    blockerCounts: [...blockerCounts.entries()]
      .map(([blocker, count]) => ({ blocker, runs: count }))
      .sort((a, b) => b.runs - a.runs || a.blocker.localeCompare(b.blocker)),
    unmeasured: UNMEASURED,
    byMode,
    caseEligibleModeRuns: byMode
      .filter(entry => entry.caseEligible)
      .reduce((sum, entry) => sum + entry.runs, 0),
    growth: measureGrowth(runs, ceiling),
  }
}

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000

function measureGrowth(runs: readonly RunSurvey[], qualifying: number): CorpusGrowth {
  const timestamps = runs.map(run => run.startedAt).filter(ts => Number.isFinite(ts) && ts > 0)
  if (timestamps.length === 0) {
    return { observedDays: 0, runsPerWeek: 0, qualifyingRunsPerWeek: 0, weeksToThreshold: null }
  }

  const firstRunAt = Math.min(...timestamps)
  const lastRunAt = Math.max(...timestamps)
  const spanMs = lastRunAt - firstRunAt

  // A corpus produced within a single day gives no usable rate: dividing by a
  // near-zero span manufactures an enormous per-week figure out of one busy
  // afternoon. Report the counts and decline to annualise them.
  if (spanMs < MS_PER_WEEK / 7) {
    return {
      firstRunAt,
      lastRunAt,
      observedDays: spanMs / (24 * 60 * 60 * 1000),
      runsPerWeek: 0,
      qualifyingRunsPerWeek: 0,
      weeksToThreshold: null,
    }
  }

  const weeks = spanMs / MS_PER_WEEK
  const runsPerWeek = runs.length / weeks
  const qualifyingRunsPerWeek = qualifying / weeks
  const remaining = G1_MINIMUM_REEXECUTABLE_CASES - qualifying

  return {
    firstRunAt,
    lastRunAt,
    observedDays: spanMs / (24 * 60 * 60 * 1000),
    runsPerWeek,
    qualifyingRunsPerWeek,
    // Null rather than Infinity when nothing qualifies yet. A projection from a
    // zero rate is not "a long time" — it is no information, and a printed
    // number invites planning around it.
    weeksToThreshold: remaining <= 0
      ? 0
      : qualifyingRunsPerWeek > 0
        ? remaining / qualifyingRunsPerWeek
        : null,
  }
}

/**
 * Scan every trajectory on disk and produce the report.
 *
 * Unreadable trajectories are skipped rather than fatal: a corrupt file should
 * not prevent the survey from reporting on the rest, and an aborted survey is
 * the least useful possible outcome for a question about coverage.
 */
export async function surveyCorpus(
  options: TrajectoryPathsOptions = {},
): Promise<CorpusSurveyReport> {
  const root = trajectoriesRoot(options)
  const entries = await readdir(root).catch(() => [] as string[])
  const ids = entries.filter(name => /^[0-9a-f-]{36}$/.test(name))

  const runs: RunSurvey[] = []
  let readable = 0

  for (const id of ids) {
    try {
      const lines = await readTrajectoryPreservingUnknown(trajectoryFile(id, options))
      runs.push(...surveyTrajectoryLines(id, lines))
      readable += 1
    } catch {
      // Counted as unreadable by omission; see the doc comment.
    }
  }

  return aggregateCorpusSurvey(runs, readable)
}

/** Human-readable rendering for the CLI. */
export function formatCorpusSurvey(report: CorpusSurveyReport): string {
  const pct = (n: number): string =>
    report.runs === 0 ? '—' : `${((n / report.runs) * 100).toFixed(1)}%`

  const lines = [
    `Corpus survey — ${report.trajectories} trajectories, ${report.runs} runs`,
    '',
    'Starting-point recoverability',
    `  with gitBase        ${report.runsWithGitBase} (${pct(report.runsWithGitBase)})`,
    `  clean start         ${report.runsWithCleanStart} (${pct(report.runsWithCleanStart)})`,
    `  dirty worktree      ${report.runsWithDirtyStart} (${pct(report.runsWithDirtyStart)})`,
    `  untracked files     ${report.runsWithUntrackedStart} (${pct(report.runsWithUntrackedStart)})`,
    '',
    'Termination',
    ...Object.entries(report.outcomes)
      .sort((a, b) => b[1] - a[1])
      .map(([outcome, count]) => `  ${outcome.padEnd(20)}${count} (${pct(count)})`),
    `  abnormal rate       ${(report.abnormalTerminationRate * 100).toFixed(1)}%`,
    '',
    '',
    'Session mode',
    ...report.byMode.map(({ mode, runs, caseEligible }) =>
      `  ${mode.padEnd(20)}${runs} (${pct(runs)})${caseEligible ? '' : '  — not an eval-case mode'}`),
    `  case-eligible       ${report.caseEligibleModeRuns} (${pct(report.caseEligibleModeRuns)})`,
    '',
    'Growth',
    `  observed window     ${report.growth.observedDays.toFixed(1)} days`,
    `  runs / week         ${report.growth.runsPerWeek.toFixed(1)}`,
    `  qualifying / week   ${report.growth.qualifyingRunsPerWeek.toFixed(1)}`,
    `  weeks to threshold  ${report.growth.weeksToThreshold === null
      ? 'cannot project — nothing qualifies yet'
      : report.growth.weeksToThreshold.toFixed(1)}`,
    '',
    `Re-executable ceiling  ${report.reExecutableCeiling}  (G1 needs ${G1_MINIMUM_REEXECUTABLE_CASES})`,
    `G1 threshold met       ${report.meetsG1Threshold ? 'yes' : 'NO'}`,
  ]

  if (report.blockerCounts.length > 0) {
    lines.push('', 'Blockers')
    for (const { blocker, runs } of report.blockerCounts) {
      lines.push(`  ${blocker.padEnd(22)}${runs} (${pct(runs)})`)
    }
  }

  // Printed last and never abbreviated: the ceiling above is only an upper
  // bound because of these, and a reader who skips them will over-read it.
  lines.push('', 'NOT MEASURED — the ceiling above is an upper bound, not an estimate')
  for (const { dimension, reason } of report.unmeasured) {
    lines.push(`  ${dimension}`)
    lines.push(`    ${reason}`)
  }

  return lines.join('\n')
}
