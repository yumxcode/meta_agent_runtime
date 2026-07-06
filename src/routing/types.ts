/**
 * Routing types — SessionMode and RouterOptions.
 *
 * Three execution modes, ordered by weight:
 *
 *   AGENTIC  — Full multi-turn tool-use loop (current MetaAgentSession).
 *              Default mode. Activated unless the caller explicitly selects a
 *              specialist mode. Campaign context is still injected when present.
 *
 *   CAMPAIGN — AGENTIC + KernelBridge (CC auto-compaction for long sessions)
 *              + CampaignMonitor awareness. Activated explicitly by the caller.
 *
 *   ROBOTICS — AGENTIC + ExperienceStore + GitWorkspaceManager + WorkflowLoader.
 *              Activated explicitly by the caller.
 *
 *   AUTO     — AGENTIC + autonomous execution (no per-tool confirmation) + a
 *              hard workspace jail (write/delete/replace strictly confined to
 *              the project working path; the jail cannot be unlocked by config).
 *              A sibling "flavour" of AGENTIC, not a heavier mode. Entered
 *              EXPLICITLY ONLY (--mode auto); never inferred from prompt wording
 *              or autonomy-intent signals — auto-inference would silently drop
 *              the jail.
 *
 * Mode selection is explicit: no prompt-based auto-detection is used by
 * SessionRouter. Omitting mode means AGENTIC.
 */

// ── SessionMode ───────────────────────────────────────────────────────────────

// Canonical mode union + weight table now live in core/modes.ts (single source
// of truth). Re-exported here so existing `routing/types` importers are unchanged.
export type { SessionMode } from '../core/modes.js'
export { MODE_WEIGHT } from '../core/modes.js'
import type { SessionMode } from '../core/modes.js'

// ── Router options ────────────────────────────────────────────────────────────

export interface RouterOptions {
  /**
   * Explicit mode. Default: 'agentic'.
   *
   * 'agentic'  — force tool-use loop.
   * 'campaign' — force full campaign coordination.
   * 'robotics' — force robotics multi-agent orchestration.
   * 'auto'     — force autonomous execution + hard workspace jail.
   */
  mode?: SessionMode

  /**
   * Whether to log mode selection decisions to stderr.
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
