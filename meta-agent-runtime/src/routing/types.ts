/**
 * Routing types — SessionMode and detection machinery.
 *
 * Four execution modes, ordered by weight:
 *
 *   DIRECT   — Single Anthropic API call. No tools, no agentic loop.
 *              For Q&A, discussion, code review — anything that doesn't
 *              require tool execution. Implemented via MetaAgentSession
 *              with an empty tool registry (exits after one turn naturally).
 *
 *   AGENTIC  — Full multi-turn tool-use loop (current MetaAgentSession).
 *              Activated when tools are registered or prompt signals intent
 *              to use tools. Campaign context is still injected when present.
 *
 *   CAMPAIGN — AGENTIC + KernelBridge (CC auto-compaction for long sessions)
 *              + CampaignMonitor awareness. Activated explicitly when DOE /
 *              Pareto / multi-fidelity signals are detected.
 *
 *   ROBOTICS — AGENTIC + ExperienceStore + GitWorkspaceManager + WorkflowLoader.
 *              Activated when robotics-domain signals are detected (ROS, SLAM,
 *              gait, manipulation, sim-to-real, RL-for-robots, etc.).
 *
 * Mode upgrade path (within a session):
 *   DIRECT → AGENTIC → CAMPAIGN   (never downgrade)
 *   DIRECT → AGENTIC → ROBOTICS   (robotics is a peer of campaign, not above it)
 */

// ── SessionMode ───────────────────────────────────────────────────────────────

export type SessionMode = 'direct' | 'agentic' | 'campaign' | 'robotics'

/**
 * 'auto'  — ModeDetector chooses based on prompt + environment.
 * Explicit values — user declares the mode; ModeDetector is bypassed.
 */
export type SessionModeHint = SessionMode | 'auto'

/** Numeric weight for mode comparison (higher = heavier). */
export const MODE_WEIGHT: Record<SessionMode, number> = {
  direct:   0,
  agentic:  1,
  campaign: 2,
  robotics: 3,
}

// ── Detection result ──────────────────────────────────────────────────────────

export type DetectionConfidence =
  | 'explicit'   // caller set mode directly — no heuristics needed
  | 'llm'        // Haiku one-shot classification
  | 'heuristic'  // keyword/pattern match in the prompt
  | 'env'        // active campaigns on disk → minimum agentic
  | 'default'    // no signals found; fell back to AGENTIC

export interface ModeSignal {
  /** Human-readable description of what triggered this signal. */
  label: string
  /** Which mode this signal points toward. */
  mode: SessionMode
}

export interface ModeDetectionResult {
  mode: SessionMode
  confidence: DetectionConfidence
  /** All signals that influenced the decision. */
  signals: ModeSignal[]
}

// ── Router options ────────────────────────────────────────────────────────────

export interface RouterOptions {
  /**
   * Explicit mode hint. Default: 'auto'.
   *
   * 'auto'     — ModeDetector runs on first submit().
   * 'direct'   — force single-turn, no tools.
   * 'agentic'  — force tool-use loop.
   * 'campaign' — force full campaign coordination.
   * 'robotics' — force robotics multi-agent orchestration.
   */
  mode?: SessionModeHint

  /**
   * Whether to log mode detection decisions to stderr.
   * Default: false.
   */
  debugMode?: boolean
}
