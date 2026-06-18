/**
 * Knowledge-store types — the experience-entry schema persisted by
 * ExperienceStore. These live in neutral infra (not robotics) so the store and
 * its auto-mode reuse don't force a mode→mode dependency
 * (architecture-review-2026-06-18.md §1.2 / §5.1 #2b).
 *
 * `robotics/types.ts` re-exports these under its historical names
 * (`KnowledgeDomain` → `RoboticsDomain`, `KNOWLEDGE_DOMAINS` → `ROBOTICS_DOMAINS`)
 * so every robotics call site is unchanged.
 */
import { randomUUID } from 'crypto'

// ── Domain taxonomy ───────────────────────────────────────────────────────────
// Named neutrally; the member values happen to be robotics-flavored because
// that's the only domain set in use today. New domains can be added here.
export type KnowledgeDomain =
  | 'motion_planning' | 'perception' | 'manipulation' | 'locomotion'
  | 'navigation' | 'simulation' | 'hardware_interface' | 'deployment'
  | 'calibration' | 'general'

export const KNOWLEDGE_DOMAINS: KnowledgeDomain[] = [
  'motion_planning', 'perception', 'manipulation', 'locomotion',
  'navigation', 'simulation', 'hardware_interface', 'deployment',
  'calibration', 'general',
]

// ── Knowledge confidence ─────────────────────────────────────────────────────
export type KnowledgeConfidenceTier =
  | 'observed'      // Seen in this project/session/robotics run.
  | 'reproduced'    // Confirmed across repeated observations.
  | 'derived'       // Derived from physics, math, datasheets, or specs.
  | 'reported'      // Reported by papers/docs/forums but not locally verified.
  | 'hypothesis'    // Plausible but not yet verified.

export const KNOWLEDGE_CONFIDENCE_TIERS: KnowledgeConfidenceTier[] = [
  'observed', 'reproduced', 'derived', 'reported', 'hypothesis',
]

// ── Experience entry schema ────────────────────────────────────────────────────
export interface ExperienceOutcome {
  success: boolean
  summary: string        // ≤ 200 chars, shown in index
  failureReason?: string
  workarounds?: string[]
}

export interface ExperienceEntry {
  id: string             // 'exp_<timestamp>_<uuid8>'
  schemaVersion: '1.0'
  createdAt: number
  updatedAt: number
  domain: KnowledgeDomain
  algorithm?: string
  tags: string[]
  robot?: string
  difficulty: 'low' | 'medium' | 'high'
  title: string          // ≤ 80 chars
  problem: string        // ≤ 500 chars
  solution: string       // ≤ 800 chars
  outcome: ExperienceOutcome
  /**
   * Same-domain abstract principle extracted by flash model at write time.
   * Used for same-domain principle matching in ExperiencePatternChecker.
   * Example: "Spatial resolution × map size determines peak memory; estimate before coding."
   */
  abstractPrinciple?: string
  /** How strongly this experience should be trusted when retrieved. */
  confidenceTier?: KnowledgeConfidenceTier
  /** Experiment log, commit, report, paper, datasheet, or other supporting references. */
  evidenceRefs?: string[]
  /** Number of independent observations supporting this lesson. Defaults to 1. */
  observationCount?: number
  /** Number of later observations that contradicted this lesson. Defaults to 0. */
  contradictionCount?: number
  /** Assumptions this experience falsified. Especially important for failures. */
  invalidatedAssumptions?: string[]
  /** Last time the lesson was checked against observation or source evidence. */
  lastVerifiedAt?: number
  metrics?: Record<string, number | string>
  sourceTaskId?: string
  sourceSessionId?: string
  /** Reviewed principles promoted from or linked to this concrete experience. */
  principleIds?: string[]
  /** Physical anchors this experience applied, validated, or contradicted. Usually empty. */
  anchorIds?: string[]
  relatedPapers?: string[]
  fullReport?: string    // Markdown, loaded on demand only
}

export interface ExperienceSearchQuery {
  domain?: KnowledgeDomain
  tags?: string[]
  algorithm?: string
  robot?: string
  keyword?: string       // searches title + problem + solution
  successOnly?: boolean
  limit?: number         // default 10, max 20
}

export function makeExperienceId(): string {
  const ts = Date.now().toString(36)
  const uuid8 = randomUUID().replace(/-/g, '').slice(0, 8)
  return `exp_${ts}_${uuid8}`
}
