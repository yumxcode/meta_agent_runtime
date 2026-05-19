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
/** Numeric weight for mode comparison (higher = heavier). */
export const MODE_WEIGHT = {
    direct: 0,
    agentic: 1,
    campaign: 2,
    robotics: 3,
};
//# sourceMappingURL=types.js.map