/**
 * IKnowledgeSource — abstraction over any domain knowledge store.
 *
 * ExperiencePatternChecker depends only on this interface, making it reusable
 * across all session modes:
 *
 *   Robotics  → ExperienceSource        (wraps ExperienceStore)
 *   Campaign  → CampaignLessonSource    (wraps campaign_lessons memory files)
 *   Agentic   → future implementation
 *
 * Design: listExperiences returns BOTH successes and failures.
 * Principle matching is done by the LLM caller — the source layer does not
 * pre-filter by outcome. Successes carry "replicate this pattern" principles;
 * failures carry "avoid this pitfall" principles. Both matter for reasoning.
 */

// ─────────────────────────────────────────────────────────────────────────────
// ExperienceMatch
// ─────────────────────────────────────────────────────────────────────────────

export interface ExperienceMatch {
  /** Stable identifier */
  id: string
  /** Short title (≤ 80 chars) */
  title: string
  /** Domain classification */
  domain: string
  /** Experiment outcome */
  outcome: 'success' | 'partial' | 'failure' | 'timeout'
  /**
   * Domain-agnostic abstract principle extracted at write time.
   * This is what the LLM uses for same-domain principle matching.
   * Falls back to outcome summary if not yet extracted.
   */
  abstractPrinciple: string
  /** Root cause or failure summary (present for non-success outcomes) */
  failureReason?: string
  /** Workarounds that resolved the issue */
  workarounds?: string[]
  /** Evidence strength for retrieval/ranking and prompt weighting. */
  confidenceTier?: string
  /** Supporting references such as logs, commits, reports, papers, or datasheets. */
  evidenceRefs?: string[]
  /** Number of independent observations supporting the lesson. */
  observationCount?: number
  /** Number of later observations that contradicted the lesson. */
  contradictionCount?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// List options
// ─────────────────────────────────────────────────────────────────────────────

export interface ExperienceListOpts {
  /**
   * Filter by domains (from QueryAnalyzer intent).
   * If omitted or empty, all domains are included.
   */
  domains?: string[]
  /**
   * Technical terms from the current task. Used to build a candidate pool
   * before LLM applicability judgment; not treated as a hard AND filter.
   */
  keywords?: string[]
  /** Maximum entries to return. Default: 12 */
  limit?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// IKnowledgeSource
// ─────────────────────────────────────────────────────────────────────────────

export interface IKnowledgeSource {
  /**
   * List recent experiences, optionally filtered by domain.
   * Returns both successes and failures — the caller's LLM decides which
   * principles apply to the current context.
   */
  listExperiences(opts?: ExperienceListOpts): Promise<ExperienceMatch[]>

  /**
   * Return a compact one-line summary for the Manifest layer (≤ 80 chars).
   * Example: "Experiences: 12 total (motion_planning:5, perception:3) | 3 failures"
   */
  getManifestLine(): Promise<string>
}
