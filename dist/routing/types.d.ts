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
 * Mode upgrade path (within a session):
 *   AGENTIC → CAMPAIGN   (never downgrade)
 *   AGENTIC → ROBOTICS   (robotics is a peer of campaign, not above it)
 */
export type SessionMode = 'agentic' | 'campaign' | 'robotics';
/**
 * 'auto'  — ModeDetector chooses based on prompt + environment.
 * Explicit values — user declares the mode; ModeDetector is bypassed.
 */
export type SessionModeHint = SessionMode | 'auto';
/** Numeric weight for mode comparison (higher = heavier). */
export declare const MODE_WEIGHT: Record<SessionMode, number>;
export type DetectionConfidence = 'explicit' | 'llm' | 'heuristic' | 'env' | 'default';
export interface ModeSignal {
    /** Human-readable description of what triggered this signal. */
    label: string;
    /** Which mode this signal points toward. */
    mode: SessionMode;
}
export interface ModeDetectionResult {
    mode: SessionMode;
    confidence: DetectionConfidence;
    /** All signals that influenced the decision. */
    signals: ModeSignal[];
}
export interface RouterOptions {
    /**
     * Explicit mode hint. Default: 'auto'.
     *
     * 'auto'     — ModeDetector runs on first submit().
     * 'agentic'  — force tool-use loop.
     * 'campaign' — force full campaign coordination.
     * 'robotics' — force robotics multi-agent orchestration.
     */
    mode?: SessionModeHint;
    /**
     * Whether to log mode detection decisions to stderr.
     * Default: false.
     */
    debugMode?: boolean;
    /**
     * Robot/platform name to bind for robotics mode sessions
     * (e.g. 'go2', 'franka_panda', 'f1').
     *
     * When set, RoboticsSession uses this name to load the hardware profile
     * from `~/.claude/meta-agent/robotics/hardware_profiles/<name>.json` and
     * inject it into the R4 prompt section.
     *
     * Typically sourced from the CLI `--robot` flag or interactive hardware
     * selection (stored as `opts.hardwareId`).
     */
    robot?: string;
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
    explicitResume?: boolean;
    /**
     * Called when the flash classifier suggests escalating from single-agent to
     * multi-agent mode.  The CLI implementation should print a confirmation prompt
     * and return true if the user agrees.  When absent, escalation is denied and
     * the session stays in single-agent mode.
     */
    onEscalationRequest?: (reason: string) => Promise<boolean>;
}
//# sourceMappingURL=types.d.ts.map