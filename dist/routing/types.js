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
/** Numeric weight for mode comparison (higher = heavier). */
export const MODE_WEIGHT = {
    agentic: 1,
    campaign: 2,
    robotics: 3,
};
//# sourceMappingURL=types.js.map