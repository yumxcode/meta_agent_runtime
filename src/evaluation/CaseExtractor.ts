/**
 * CaseExtractor — recovering eval-case candidates from real trajectories (G1-8).
 *
 * ── Why this produces drafts and refuses to produce EvalCases ───────────────
 *
 * An `EvalCase` asserts that a task can be re-executed and that there is a
 * deterministic definition of having succeeded at it. Almost nothing in the
 * existing corpus supports either claim: `eligibilityRef`, `evaluatorBundleRef`
 * and `resetRecipeRef` have no source yet, and success criteria written after
 * reading the outcome carry post-treatment bias by construction.
 *
 * So this module emits `EvalCaseCandidate` — a draft that names, field by
 * field, what a human still has to supply. It never emits an `EvalCase`, and it
 * never proposes a split other than `support`. The temptation this is designed
 * against is mechanical completion: a pipeline that fills the missing refs with
 * placeholders would produce a corpus that validates, re-executes, and measures
 * nothing.
 *
 * ── Why chains, not runs (§15.6) ────────────────────────────────────────────
 *
 * The first corpus survey found 44.3% of runs ending in `parked`. park/wake is
 * the dominant pattern, so a task routinely spans several runs. Extracting one
 * case per run would systematically capture only the tail of long tasks, or cut
 * one task into fragments — and both produce cases that look entirely normal
 * while measuring the wrong thing.
 *
 * A chain therefore runs from the first run after a terminal one up to and
 * including the first run that does not end `parked`. The chain's starting
 * point is the FIRST run's `gitBase`, which is what a replay would have to
 * restore; a later run's base is mid-task state and already contains part of
 * the answer.
 */

import { createHash } from 'crypto'
import { readdir } from 'fs/promises'
import { trajectoriesRoot, trajectoryFile, type TrajectoryPathsOptions } from '../trajectory/paths.js'
import { readTrajectoryPreservingUnknown } from '../trajectory/reader.js'
import type { PreservedTrajectoryLine } from '../trajectory/types.js'
import type { GitBase } from '../infra/git/gitBase.js'
import type { EnvironmentFidelity } from './BaseSnapshot.js'

/** Fields a human must supply before a candidate can become an EvalCase. */
export const MISSING_FIELDS = {
  PROMPT: 'prompt — no user message found in the chain',
  GIT_BASE: 'baseSnapshotRef — the chain\'s first run recorded no gitBase',
  CLEAN_START: 'baseSnapshotRef — the chain started from a dirty or untracked working tree',
  SUCCESS_CRITERIA: 'successCriteria — nothing in the trajectory states what "done" meant',
  EVALUATOR_BUNDLE: 'evaluatorBundleRef — no deterministic check exists for this task',
  ELIGIBILITY: 'eligibilityRef — no training-eligibility decision has been recorded',
  RESET_RECIPE: 'resetRecipeRef — no teardown recipe has been written',
  ENVIRONMENT_MANIFEST: 'environmentManifestRef — dependency locks and env are not captured',
  CONTAMINATION_GROUP: 'contaminationGroupId — defaulted to the root trajectory; rewrites of the same task must be grouped by hand',
  TASK_FAMILY: 'taskFamily — needed for the lower-tail cohort gate',
  RISK_TIER: 'riskTier — must be assigned by a human',
} as const

export type MissingField = typeof MISSING_FIELDS[keyof typeof MISSING_FIELDS]

export interface RunLink {
  runId?: string
  startedAtOrdinal: number
  startedAt: number
  outcome?: string
  gitBase?: GitBase
}

export interface EvalCaseCandidate {
  schemaVersion: 'eval-case-candidate-1.0'
  /** Stable id derived from the chain's identity, so re-extraction is idempotent. */
  candidateId: string
  rootTrajectoryId: string
  mode?: string
  /** Every run in the chain, in order. */
  runs: RunLink[]
  parkedRuns: number
  finalOutcome?: string
  /** First user message in the chain, truncated. */
  prompt?: string
  /** The chain's starting point — the FIRST run's base, never a later one. */
  chainStartGitBase?: GitBase
  environmentFidelity: EnvironmentFidelity
  /**
   * Always `support`.
   *
   * A candidate has no deterministic checks and no human-written criteria, so
   * it cannot legitimately enter validation, sealed_test or canary. Suggesting
   * anything else here would be the extractor quietly making a curation
   * decision it has no basis for.
   */
  suggestedSplit: 'support'
  missing: MissingField[]
  /** True when the chain completed successfully — a prerequisite, not a pass. */
  completed: boolean
}

const PROMPT_MAX_CHARS = 2_000

/**
 * Split one trajectory's runs into task chains.
 *
 * `parked` continues a chain; anything else ends it. A trailing run with no
 * result is kept as its own unterminated chain rather than dropped — an
 * unfinished task is a real thing the corpus should be able to count.
 */
export function groupRunsIntoChains(runs: readonly RunLink[]): RunLink[][] {
  const chains: RunLink[][] = []
  let current: RunLink[] = []

  for (const run of runs) {
    current.push(run)
    // Only `parked` means "this task continues in a later run". Every other
    // outcome — success, error, interrupted, or no result at all — terminates.
    if (run.outcome !== 'parked') {
      chains.push(current)
      current = []
    }
  }

  if (current.length > 0) chains.push(current)
  return chains
}

/** Extract candidates from one trajectory's lines. */
export function extractFromTrajectoryLines(
  trajectoryId: string,
  lines: readonly PreservedTrajectoryLine[],
): EvalCaseCandidate[] {
  let mode: string | undefined
  let rootTrajectoryId = trajectoryId
  const runs: RunLink[] = []
  const byRunId = new Map<string, RunLink>()
  // Ordinal → prompt, so each chain can find the user message that started it.
  const userMessages: Array<{ ordinal: number; text: string }> = []

  for (const line of lines) {
    if (!line.knownItem) continue
    const item = line.item as { type: string } & Record<string, unknown>

    if (item.type === 'trajectory_meta') {
      if (typeof item['mode'] === 'string') mode = item['mode']
      if (typeof item['rootTrajectoryId'] === 'string') rootTrajectoryId = item['rootTrajectoryId']
      continue
    }

    if (item.type === 'run_started') {
      const link: RunLink = {
        ...(line.runId !== undefined ? { runId: line.runId } : {}),
        startedAtOrdinal: line.ordinal,
        startedAt: line.ts,
        ...(item['gitBase'] ? { gitBase: item['gitBase'] as GitBase } : {}),
      }
      runs.push(link)
      if (line.runId) byRunId.set(line.runId, link)
      continue
    }

    if (item.type === 'run_result') {
      const link = line.runId ? byRunId.get(line.runId) : runs[runs.length - 1]
      if (link) link.outcome = typeof item['outcome'] === 'string' ? item['outcome'] : 'unknown'
      continue
    }

    if (item.type === 'message') {
      const message = item['message'] as Record<string, unknown> | undefined
      if (message?.['role'] !== 'user') continue
      const text = messageText(message['content'])
      if (text.trim()) userMessages.push({ ordinal: line.ordinal, text: text.trim() })
    }
  }

  const chains = groupRunsIntoChains(runs)
  return chains.map((chain, index) => toCandidate({
    trajectoryId,
    rootTrajectoryId,
    mode,
    chain,
    userMessages,
    // The next chain's first run bounds this one's prompt window. Without the
    // bound, a chain with no user message of its own would silently adopt the
    // next task's prompt and describe work it never did.
    boundOrdinal: chains[index + 1]?.[0]?.startedAtOrdinal ?? Infinity,
  }))
}

function toCandidate(args: {
  trajectoryId: string
  rootTrajectoryId: string
  mode?: string
  chain: RunLink[]
  userMessages: Array<{ ordinal: number; text: string }>
  boundOrdinal: number
}): EvalCaseCandidate {
  const { chain, userMessages, boundOrdinal } = args
  const first = chain[0]!
  const last = chain[chain.length - 1]!

  // The chain's own start, not any later run's. A base captured mid-task
  // already contains part of the work and would let a replay pass for free.
  const chainStartGitBase = first.gitBase

  // The kernel records run_started before the turn's messages, so the prompt
  // that drove this chain sits after its first run and before the next chain.
  const prompt = userMessages
    .find(message =>
      message.ordinal >= first.startedAtOrdinal && message.ordinal < boundOrdinal)
    ?.text.slice(0, PROMPT_MAX_CHARS)

  const missing: MissingField[] = []
  if (!prompt) missing.push(MISSING_FIELDS.PROMPT)
  if (!chainStartGitBase) missing.push(MISSING_FIELDS.GIT_BASE)
  else if (chainStartGitBase.dirty || chainStartGitBase.untracked) {
    missing.push(MISSING_FIELDS.CLEAN_START)
  }

  // These have no source anywhere in the system yet. Listing each one rather
  // than a single "not ready" keeps the size of the remaining work visible.
  missing.push(
    MISSING_FIELDS.SUCCESS_CRITERIA,
    MISSING_FIELDS.EVALUATOR_BUNDLE,
    MISSING_FIELDS.ELIGIBILITY,
    MISSING_FIELDS.RESET_RECIPE,
    MISSING_FIELDS.ENVIRONMENT_MANIFEST,
    MISSING_FIELDS.CONTAMINATION_GROUP,
    MISSING_FIELDS.TASK_FAMILY,
    MISSING_FIELDS.RISK_TIER,
  )

  const environmentFidelity: EnvironmentFidelity = !chainStartGitBase
    ? 'unrestorable'
    : chainStartGitBase.dirty || chainStartGitBase.untracked
      ? 'approximated'
      : 'restored'

  return {
    schemaVersion: 'eval-case-candidate-1.0',
    candidateId: candidateId(args.trajectoryId, first),
    rootTrajectoryId: args.rootTrajectoryId,
    ...(args.mode !== undefined ? { mode: args.mode } : {}),
    runs: chain,
    parkedRuns: chain.filter(run => run.outcome === 'parked').length,
    ...(last.outcome !== undefined ? { finalOutcome: last.outcome } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(chainStartGitBase !== undefined ? { chainStartGitBase } : {}),
    environmentFidelity,
    suggestedSplit: 'support',
    missing,
    completed: last.outcome === 'success',
  }
}

function candidateId(trajectoryId: string, first: RunLink): string {
  const digest = createHash('sha256')
    .update(`${trajectoryId}:${first.runId ?? first.startedAtOrdinal}`)
    .digest('hex')
    .slice(0, 24)
  return `evalcand_${digest}`
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: string } =>
      Boolean(block) && typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join(' ')
}

export interface ExtractionReport {
  trajectories: number
  chains: number
  candidates: EvalCaseCandidate[]
  /** Chains that ended in success — the only ones worth curating first. */
  completedChains: number
  /** Chains whose start could be restored exactly. */
  restorableChains: number
  /** Chains spanning more than one run, i.e. park/wake tasks. */
  multiRunChains: number
  /** How often each missing field blocks a candidate, most common first. */
  missingCounts: Array<{ field: MissingField; candidates: number }>
}

/** Scan every trajectory and produce candidates. */
export async function extractCaseCandidates(
  options: TrajectoryPathsOptions = {},
): Promise<ExtractionReport> {
  const root = trajectoriesRoot(options)
  const entries = await readdir(root).catch(() => [] as string[])
  const ids = entries.filter(name => /^[0-9a-f-]{36}$/.test(name))

  const candidates: EvalCaseCandidate[] = []
  let readable = 0

  for (const id of ids) {
    try {
      const lines = await readTrajectoryPreservingUnknown(trajectoryFile(id, options))
      candidates.push(...extractFromTrajectoryLines(id, lines))
      readable += 1
    } catch {
      // A corrupt trajectory should not abort a survey of the rest.
    }
  }

  return summarise(candidates, readable)
}

export function summarise(
  candidates: readonly EvalCaseCandidate[],
  trajectories: number,
): ExtractionReport {
  const missingCounts = new Map<MissingField, number>()
  for (const candidate of candidates) {
    for (const field of new Set(candidate.missing)) {
      missingCounts.set(field, (missingCounts.get(field) ?? 0) + 1)
    }
  }

  return {
    trajectories,
    chains: candidates.length,
    candidates: [...candidates],
    completedChains: candidates.filter(c => c.completed).length,
    restorableChains: candidates.filter(c => c.environmentFidelity === 'restored').length,
    multiRunChains: candidates.filter(c => c.runs.length > 1).length,
    missingCounts: [...missingCounts.entries()]
      .map(([field, count]) => ({ field, candidates: count }))
      .sort((a, b) => b.candidates - a.candidates || a.field.localeCompare(b.field)),
  }
}

export function formatExtractionReport(report: ExtractionReport, limit = 10): string {
  const lines = [
    `Case extraction — ${report.trajectories} trajectories, ${report.chains} task chains`,
    '',
    `  completed chains    ${report.completedChains}`,
    `  restorable start    ${report.restorableChains}`,
    `  multi-run chains    ${report.multiRunChains}  (park/wake tasks)`,
    '',
    'Blocking fields',
    ...report.missingCounts.map(({ field, candidates }) =>
      `  ${String(candidates).padStart(4)}  ${field}`),
  ]

  const worthCurating = report.candidates
    .filter(c => c.completed && c.environmentFidelity === 'restored')
    .slice(0, limit)

  lines.push('', `Best curation candidates (${worthCurating.length} shown)`)
  if (worthCurating.length === 0) {
    lines.push('  none — no chain both completed and started from a restorable state')
  } else {
    for (const candidate of worthCurating) {
      lines.push(
        `  ${candidate.candidateId}  runs=${candidate.runs.length}` +
        `  mode=${candidate.mode ?? '?'}  ${(candidate.prompt ?? '(no prompt)').slice(0, 60)}`,
      )
    }
  }

  // Stated last and unconditionally: nothing here is an EvalCase, and the
  // distance to becoming one is the list above, not a formatting step.
  lines.push(
    '',
    'These are DRAFTS, not eval cases. Every one is missing fields a human must',
    'supply, and none may leave the `support` split until it has human-written',
    'success criteria backed by a deterministic check.',
  )

  return lines.join('\n')
}
