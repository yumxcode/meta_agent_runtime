/**
 * Data eligibility (G0-A).
 *
 * "Auditable" does not imply "usable for learning or repeated execution". The
 * existing privacy filter removes secrets and oversized fields from a
 * trajectory; it does not decide whether that trajectory may be re-executed,
 * exported into an evaluation set, or used to generate candidates.
 *
 * Default is `denied`. Absence of a decision is a denial, not a permission —
 * an unmarked trajectory is the common case, so an optimistic default would
 * silently admit everything.
 *
 * Nothing consumes this yet; it is the contract the EvalSet extractor will be
 * required to pass through.
 */
import { z } from 'zod'

/** Ordered narrowest → broadest. Comparison relies on this order. */
export const TRAINING_ELIGIBILITY_LEVELS = ['denied', 'local_only', 'workspace', 'aggregate'] as const

export type TrainingEligibility = (typeof TRAINING_ELIGIBILITY_LEVELS)[number]

export const DATA_USES = [
  'audit',
  'analysis',
  'evaluation',
  'candidate_generation',
  'training',
] as const

export type DataUse = (typeof DATA_USES)[number]

export const DataEligibilitySchema = z.object({
  schemaVersion: z.literal('data-eligibility-1.0'),
  /** A caseId or trajectoryId; the subject this decision is about. */
  subjectRef: z.string().min(1),
  trainingEligibility: z.enum(TRAINING_ELIGIBILITY_LEVELS),
  workspaceId: z.string().min(1).optional(),
  dataSubject: z.string().min(1).optional(),
  retentionUntil: z.number().optional(),
  allowedUses: z.array(z.enum(DATA_USES)).max(DATA_USES.length),
  /**
   * Crossing a workspace boundary is never implicit. Either it is refused, or
   * a named person approved it at a recorded time.
   */
  crossWorkspace: z.union([
    z.literal(false),
    z.object({ approvedBy: z.string().min(1), approvedAt: z.number() }).strict(),
  ]),
  decidedAt: z.number(),
  note: z.string().max(2_000).optional(),
}).strict()

export type DataEligibility = z.infer<typeof DataEligibilitySchema>

export interface EligibilityDecision {
  allowed: boolean
  /** Populated whenever `allowed` is false; safe to surface to an operator. */
  reason?: string
}

export interface EligibilityQuery {
  use: DataUse
  /** Workspace the data is about to be used in, when that differs from its own. */
  targetWorkspaceId?: string
  now?: number
}

/**
 * Fail closed. A missing record is a denial.
 */
export function checkEligibility(
  record: DataEligibility | null | undefined,
  query: EligibilityQuery,
): EligibilityDecision {
  if (!record) {
    return { allowed: false, reason: 'no eligibility decision recorded for this subject' }
  }
  if (record.trainingEligibility === 'denied') {
    return { allowed: false, reason: `subject '${record.subjectRef}' is marked denied` }
  }
  if (!record.allowedUses.includes(query.use)) {
    return { allowed: false, reason: `use '${query.use}' is not in the allowed uses for '${record.subjectRef}'` }
  }

  const now = query.now ?? Date.now()
  if (record.retentionUntil !== undefined && now > record.retentionUntil) {
    return { allowed: false, reason: `retention for '${record.subjectRef}' expired at ${new Date(record.retentionUntil).toISOString()}` }
  }

  const crossesWorkspace = Boolean(
    query.targetWorkspaceId &&
    record.workspaceId &&
    query.targetWorkspaceId !== record.workspaceId,
  )
  if (crossesWorkspace) {
    if (record.trainingEligibility === 'local_only' || record.trainingEligibility === 'workspace') {
      return {
        allowed: false,
        reason: `'${record.subjectRef}' is ${record.trainingEligibility}; it cannot leave workspace '${record.workspaceId}'`,
      }
    }
    if (record.crossWorkspace === false) {
      return { allowed: false, reason: `cross-workspace use of '${record.subjectRef}' was not approved` }
    }
  }

  return { allowed: true }
}

/** Throwing variant for boundaries where continuing without permission is the bug. */
export function assertEligible(
  record: DataEligibility | null | undefined,
  query: EligibilityQuery,
): void {
  const decision = checkEligibility(record, query)
  if (!decision.allowed) throw new Error(`data eligibility denied: ${decision.reason}`)
}
