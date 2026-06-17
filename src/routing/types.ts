/**
 * Routing types — SessionMode and detection machinery.
 *
 * Three execution modes, ordered by weight:
 *
 *   AGENTIC  — Full multi-turn tool-use loop (current MetaAgentSession).
 *              Default mode. Activated when tools are registered or prompt
 *              signals intent to use tools. Campaign context is still injected
 *              when present.
 *
 *   CAMPAIGN — AGENTIC + KernelBridge (CC auto-compaction for long sessions)
 *              + CampaignMonitor awareness. Activated explicitly when DOE /
 *              Pareto / multi-fidelity signals are detected.
 *
 *   ROBOTICS — AGENTIC + ExperienceStore + GitWorkspaceManager + WorkflowLoader.
 *              Activated when robotics-domain signals are detected (ROS, SLAM,
 *              gait, manipulation, sim-to-real, RL-for-robots, etc.).
 *
 *   AUTO     — AGENTIC + autonomous execution (no per-tool confirmation) + a
 *              hard workspace jail (write/delete/replace strictly confined to
 *              the project working path; the jail cannot be unlocked by config).
 *              A sibling "flavour" of AGENTIC, not a heavier mode. Activated
 *              explicitly (--mode auto) or on strong autonomy-intent signals.
 *
 * Mode upgrade path (within a session):
 *   AGENTIC → CAMPAIGN   (never downgrade)
 *   AGENTIC → ROBOTICS   (robotics is a peer of campaign, not above it)
 *   AUTO is explicit-only and NOT auto-upgraded once declared (see SessionRouter
 *   `_raiseMode` explicit lock) — upgrading would drop the jail.
 */

// ── SessionMode ───────────────────────────────────────────────────────────────

// Canonical mode union + weight table now live in core/modes.ts (single source
// of truth). Re-exported here so existing `routing/types` importers are unchanged.
export type { SessionMode } from '../core/modes.js'
export { MODE_WEIGHT } from '../core/modes.js'
import type { SessionMode } from '../core/modes.js'

/**
 * 'detect' — ModeDetector chooses based on prompt + environment (the default).
 * Explicit values — user declares the mode; ModeDetector is bypassed.
 *
 * NOTE: the auto-detect sentinel is 'detect', NOT 'auto'. 'auto' is now a real
 * SessionMode (the autonomous + jailed flavour), so the detect sentinel was
 * renamed to free the name.
 */
export type SessionModeHint = SessionMode | 'detect'

// ── Detection result ──────────────────────────────────────────────────────────

export type DetectionConfidence =
  | 'explicit'   // caller set mode directly — no heuristics needed
  | 'llm'        // flash model one-shot classification
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
   * Explicit mode hint. Default: 'detect'.
   *
   * 'detect'   — ModeDetector runs on first submit() (the default).
   * 'agentic'  — force tool-use loop.
   * 'campaign' — force full campaign coordination.
   * 'robotics' — force robotics multi-agent orchestration.
   * 'auto'     — force autonomous execution + hard workspace jail.
   */
  mode?: SessionModeHint

  /**
   * Whether to log mode detection decisions to stderr.
   * Default: false.
   */
  debugMode?: boolean

  /**
   * Robot/platform name to bind for robotics mode sessions
   * (e.g. 'go2', 'franka_panda', 'f1').
   *
   * When set, RoboticsSession uses this name to load the hardware profile
   * from `~/.meta-agent/robotics/hardware_profiles/<name>.json` and
   * inject it into the R4 prompt section.
   *
   * Typically sourced from the CLI `--robot` flag or interactive hardware
   * selection (stored as `opts.hardwareId`).
   */
  robot?: string

  /**
   * Whether the user explicitly chose to resume a previous robotics session
   * (e.g. via --resume flag or the interactive session picker).
   *
   * When true, RoboticsSession shows the resume banner and injects previous
   * progress notes into R5.  When false (default), prior project state is
   * still loaded for continuity (git state, agent mode) but R5 is suppressed
   * so a fresh start in the same workspace doesn't pollute the context with
   * stale progress from earlier sessions.
   */
  explicitResume?: boolean

  /**
   * The specific robotics session id the user picked to resume (from the
   * session picker or `--resume <id>`).  When set, RoboticsSession binds R5 /
   * project state to THIS session via findBySession() rather than the most
   * recently active session in the workspace.  Ignored unless explicitResume.
   */
  resumeSessionId?: string

  /**
   * Called when the flash classifier suggests escalating from single-agent to
   * multi-agent mode.  The CLI implementation should print a confirmation prompt
   * and return true if the user agrees.  When absent, escalation is denied and
   * the session stays in single-agent mode.
   */
  onEscalationRequest?: (reason: string) => Promise<boolean>
}
