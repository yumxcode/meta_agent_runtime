/**
 * HumanAcceptance — a person's verdict on whether a task was actually done.
 *
 * ── Why this is the most valuable signal in the system ──────────────────────
 *
 * The evaluator registry currently tops out at T1: `executor_self_report` is
 * T0 and `auto_verify` is T1. Nothing reaches T2 (a deterministic check in its
 * own process) or T3 (independent identity and governance). That means no
 * metric in this repository can currently be used as a promotion gate, because
 * `MINIMUM_PROMOTION_TIER` is T3.
 *
 * Human acceptance IS T3. It is the first — and for now the only — evidence in
 * the system that can legitimately anchor a promotion decision, which makes it
 * far more than a convenience label.
 *
 * ── Why retrospective, and why that is not post-treatment bias ──────────────
 *
 * Asking a user to state acceptance criteria before the task starts fails in
 * practice: for many real tasks the criteria are not knowable up front. So the
 * verdict is recorded afterwards, through the Reviewer, where a TaskCase
 * already exists.
 *
 * That is retrospective, but it is NOT the bias that `criteriaOrigin =
 * 'reviewer_generated'` is barred for. The difference is what gets produced:
 *
 *   - a model writing detailed criteria after reading the outcome produces
 *     criteria shaped to fit the outcome — a test that asserts the agent did
 *     what it did;
 *   - a person answering "did this do what I asked?" is comparing the outcome
 *     against an intent they held independently, and emits one coarse label.
 *
 * A label is not a criterion. These verdicts are ground truth for measuring
 * false success; they are NOT `successCriteria` and cannot be replayed. Nothing
 * here lets a case into `sealed_test`.
 *
 * ── Additive by construction ────────────────────────────────────────────────
 *
 * This store is keyed by `caseId` and lives beside the Reviewer's own files. It
 * never writes to TaskReview, never changes how trajectory lines render, and so
 * cannot move `windowHash` or invalidate a stored review, a pending proposal or
 * an incremental-skip record.
 */

import { join } from 'path'
import { chmod, readdir, rm } from 'fs/promises'
import { z } from 'zod'
import { atomicWriteJson, ensureDir, readJsonFile, withFileLock } from '../infra/persist/index.js'

/** Evaluator id under which these verdicts are registered. */
export const HUMAN_ACCEPTANCE_EVALUATOR_ID = 'human_acceptance'

/**
 * Four coarse verdicts.
 *
 * `unclear` is a first-class answer, not a failure to answer. Forcing a binary
 * choice on a case the person genuinely cannot judge would put guesses into the
 * one dataset whose whole value is that it is ground truth — the same reason
 * `insufficient_evidence` exists on the runner side.
 *
 * `completed_with_concerns` separates "it worked" from "it worked and I had to
 * clean up after it". That distinction is the signal
 * `preventable_correction_rate` needs, and it is invisible in a binary label.
 */
export const ACCEPTANCE_VERDICTS = [
  'completed',
  'completed_with_concerns',
  'not_completed',
  'unclear',
] as const

export type AcceptanceVerdict = (typeof ACCEPTANCE_VERDICTS)[number]

export const HUMAN_ACCEPTANCE_SCHEMA_VERSION = 'human-acceptance-1.0'

export const HumanAcceptanceSchema = z.object({
  schemaVersion: z.literal(HUMAN_ACCEPTANCE_SCHEMA_VERSION),
  caseId: z.string().regex(/^case_[a-f0-9]{24}$/),
  rootTrajectoryId: z.string().uuid(),
  verdict: z.enum(ACCEPTANCE_VERDICTS),
  /**
   * The TaskCase content this verdict was formed against.
   *
   * A case grows as its trajectory does. Without this, a label made on a
   * three-turn case would silently continue to describe the same case after it
   * had grown to thirty — asserting acceptance of work the rater never saw.
   */
  ratedInputHash: z.string().min(1),
  ratedAt: z.number(),
  /** Free text is capped and never rendered into any model context. */
  note: z.string().max(2_000).optional(),
  /**
   * What the agent itself claimed, captured at rating time.
   *
   * Stored alongside the human verdict so false-success can be computed later
   * without re-deriving the agent's claim from a trajectory that may since have
   * been compacted or pruned.
   */
  agentClaimedSuccess: z.boolean().optional(),
}).strict()

export type HumanAcceptance = z.infer<typeof HumanAcceptanceSchema>

/** A stored verdict plus whether it still describes the current case. */
export interface AcceptanceStatus {
  acceptance: HumanAcceptance
  /**
   * True when the case has changed since it was rated. The verdict is kept —
   * it was a real judgement — but it must not be counted as describing the
   * case as it now stands.
   */
  stale: boolean
}

export class HumanAcceptanceStore {
  private readonly dir: string

  constructor(root: string) {
    this.dir = join(root, 'acceptance')
  }

  get path(): string { return this.dir }

  async ensureLayout(): Promise<void> {
    await ensureDir(this.dir)
    await chmod(this.dir, 0o700).catch(() => undefined)
  }

  private fileFor(caseId: string): string {
    if (!/^case_[a-f0-9]{24}$/.test(caseId)) {
      throw new Error(`invalid case id: ${caseId}`)
    }
    return join(this.dir, `${caseId}.json`)
  }

  async record(input: HumanAcceptance): Promise<HumanAcceptance> {
    const parsed = HumanAcceptanceSchema.parse(input)
    await this.ensureLayout()
    const file = this.fileFor(parsed.caseId)
    // Locked because a re-rating and a listing can race; last writer wins, but
    // never a half-written file.
    await withFileLock(file, async () => {
      await atomicWriteJson(file, parsed)
      await chmod(file, 0o600).catch(() => undefined)
    })
    return parsed
  }

  async get(caseId: string): Promise<HumanAcceptance | null> {
    const raw = await readJsonFile<unknown>(this.fileFor(caseId))
    if (!raw) return null
    const parsed = HumanAcceptanceSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }

  /**
   * Fetch a verdict together with whether it still applies.
   *
   * Callers that are computing metrics must use this rather than `get`, so a
   * stale label cannot quietly count as current ground truth.
   */
  async status(caseId: string, currentInputHash: string): Promise<AcceptanceStatus | null> {
    const acceptance = await this.get(caseId)
    if (!acceptance) return null
    return { acceptance, stale: acceptance.ratedInputHash !== currentInputHash }
  }

  async list(): Promise<HumanAcceptance[]> {
    await this.ensureLayout()
    const entries = await readdir(this.dir).catch(() => [] as string[])
    const ids = entries
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .filter(id => /^case_[a-f0-9]{24}$/.test(id))
      .sort()
    const loaded = await Promise.all(ids.map(id => this.get(id)))
    return loaded.filter((a): a is HumanAcceptance => a !== null)
  }

  async ratedCaseIds(): Promise<Set<string>> {
    return new Set((await this.list()).map(a => a.caseId))
  }

  async remove(caseId: string): Promise<void> {
    await rm(this.fileFor(caseId), { force: true })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the verdicts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Did a human consider the task done?
 *
 * `completed_with_concerns` counts as done: the work was delivered. The
 * concerns are a separate signal about cost, not about completion, and folding
 * them into "not done" would overstate the failure rate.
 */
export function isAcceptedAsDone(verdict: AcceptanceVerdict): boolean {
  return verdict === 'completed' || verdict === 'completed_with_concerns'
}

/** A verdict that carries usable ground truth — i.e. anything but `unclear`. */
export function isConclusiveVerdict(verdict: AcceptanceVerdict): boolean {
  return verdict !== 'unclear'
}

export interface AcceptanceSummary {
  rated: number
  byVerdict: Record<AcceptanceVerdict, number>
  /** Rated, non-stale and not `unclear` — the usable ground-truth count. */
  usable: number
  stale: number
}

export function summariseAcceptance(
  statuses: readonly AcceptanceStatus[],
): AcceptanceSummary {
  const byVerdict = Object.fromEntries(
    ACCEPTANCE_VERDICTS.map(verdict => [verdict, 0]),
  ) as Record<AcceptanceVerdict, number>

  let usable = 0
  let stale = 0
  for (const status of statuses) {
    byVerdict[status.acceptance.verdict] += 1
    if (status.stale) stale += 1
    else if (isConclusiveVerdict(status.acceptance.verdict)) usable += 1
  }

  return { rated: statuses.length, byVerdict, usable, stale }
}
