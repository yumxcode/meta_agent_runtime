/**
 * RoboticsSession — the SessionImpl for mode='robotics'.
 *
 * Architecture (composition, not inheritance):
 *
 *   RoboticsSession
 *     ├─ inner: AgenticSession            ← handles the API loop and tools
 *     ├─ experienceStore: ExperienceStore  ← persistent robotics knowledge base
 *     ├─ hardwareProfile: HardwareProfile  ← robot specs + safety limits
 *     ├─ gitManager: GitWorkspaceManager  ← sub-agent branch/worktree management
 *     ├─ projectStore: RoboticsProjectStore ← session persistence + progress notes
 *     └─ sectionRegistry: SectionRegistry ← R1-R5 dynamic prompt sections
 *
 * On every submit():
 *   1. First call only: classify agent mode (single vs multi) via Haiku side-call.
 *      After classification, invalidate R1 cache so it re-renders with the correct
 *      mode, then gets memoized for all subsequent turns.
 *   2. Resolve R1-R5 sections → combined string
 *   3. Push into inner.setAppendSystemPrompt()
 *   4. Delegate to inner.submit()
 *   5. Touch projectStore (update lastActiveAt)
 *
 * Session persistence:
 *   - init() checks RoboticsProjectStore for an existing session in projectDir
 *   - If found (within 30-day window): restores state → R5 shows resume context
 *   - If not found: creates fresh state
 *   - agentMode is persisted in project state; resumed sessions keep prior mode.
 *
 * Workflow integration:
 *   - WorkflowLoader.load('robotics', projectDir) finds AGENT.md
 *   - If found: W1 section registered + workflow tools injected
 *
 * System prompt layout:
 *   AgenticSession.systemPrompt = buildStaticSystemPrompt()              (S1-S6, cached)
 *   AgenticSession.appendSystemPrompt = buildDynamicSections({           (refreshed per submit)
 *     mode: 'robotics',
 *     modeExtensions: [R1, R2, R3, R4, R5, (W1)],   ← injected after D4c
 *     ...
 *   })
 */
import type { ConversationMessage, MetaAgentEvent, MetaAgentTool } from '../core/types.js';
import type { MetaAgentConfig } from '../core/config.js';
import { ExperiencePendingStore } from './ExperiencePendingStore.js';
import type { RoboticsAgentMode } from './types.js';
export interface RoboticsSessionOptions extends MetaAgentConfig {
    /** Robot/platform name (e.g. 'go2', 'franka_panda'). Injected into R1 & R4. */
    robot?: string;
    /**
     * Project directory for git workspace management and session persistence.
     * Defaults to process.cwd().
     */
    projectDir?: string;
    /**
     * Agent orchestration mode override.
     *
     * - 'single' — disable sub-agent dispatching; main agent handles everything.
     * - 'multi'  — full multi-agent orchestration (experiment_dispatch, paper_search, git).
     * - 'auto'   — (default) classify via Haiku on first submit() using task context.
     *
     * When set explicitly, no Haiku side-call is made.
     * Persisted to project state; resumed sessions inherit the stored mode unless
     * an explicit override is provided here.
     */
    agentMode?: RoboticsAgentMode | 'auto';
}
export declare class RoboticsSession {
    private readonly inner;
    /** Last assembled R-section prompt, exposed for debugging. */
    private _lastSystemPrompt;
    private readonly bridge;
    private readonly store;
    /** Session-scoped pending experience buffer. Exposed so the CLI can drive review UI. */
    readonly pendingExperiences: ExperiencePendingStore;
    private readonly hwProfile;
    private readonly gitMgr;
    private readonly projectDir;
    private readonly robot;
    private readonly sectionRegistry;
    /** Explicit caller override; undefined means 'auto' (classify on first submit). */
    private readonly _modeOverride;
    private _state;
    private _resumedAt;
    private _workflowDef;
    private _workflowState;
    /** Resolved agent mode. Starts as 'multi' (safe default) until classified. */
    private _agentMode;
    /** True once mode has been classified or overridden; prevents re-classification. */
    private _modeClassified;
    /** Heartbeat timer — touches lastActiveAt every HEARTBEAT_INTERVAL_MS */
    private _heartbeatTimer;
    /** True after dispose() has been called — prevents double-cleanup */
    private _disposed;
    /** Session start timestamp — passed to buildDynamicSections() for D2 env_info. */
    private readonly _sessionStartMs;
    /** Mirrors MetaAgentSession.sessionId */
    readonly sessionId: string;
    /** Heartbeat interval: 30 s. If lastActiveAt is older than 3× this, session is stale. */
    static readonly HEARTBEAT_INTERVAL_MS = 30000;
    static readonly STALE_SESSION_TTL_MS: number;
    constructor(config?: RoboticsSessionOptions);
    /**
     * Initialise the session: restore or create project state, then register
     * all tools and dynamic sections.
     *
     * Must be called once before the first submit().
     * SessionRouter.robotics case calls this automatically.
     */
    init(): Promise<{
        resumed: boolean;
        sessionAgeMs?: number;
    }>;
    /**
     * Gracefully shut down the session.
     *
     * - Stops the heartbeat timer
     * - Cancels all in-flight sub-agent tasks via SubAgentBridge
     * - Force-removes all active git worktrees (data is safe on branch)
     * - Purges active task records from RoboticsProjectStore
     *
     * Safe to call multiple times (idempotent).
     * Called automatically by the CLI on SIGINT / SIGTERM / uncaughtException.
     */
    dispose(): Promise<void>;
    submit(prompt: string): AsyncGenerator<MetaAgentEvent>;
    registerTool(tool: MetaAgentTool): void;
    interrupt(): void;
    getMessages(): readonly ConversationMessage[];
    getUsage(): import("../index.js").TokenUsage;
    getEstimatedCost(): number;
    getLastSystemPrompt(): string | null;
    getSessionId(): string;
    /**
     * Clean up resources (SubAgentBridge listeners + timers).
     * Call when the session ends to prevent memory leaks.
     */
    destroy(): void;
    /**
     * Return the robotics-specific sections (R1-R5, + optional W1) to be injected
     * as modeExtensions into buildDynamicSections().
     *
     * D4c (tool_invocation_protocol) is no longer included here — it is emitted by
     * buildDynamicSections() itself (robotics variant: general rules only, no V&V).
     */
    private _getRoboticsExtensions;
    /**
     * Prime the SectionRegistry by resolving sections once so memoized ones
     * are warm before the first submit().
     */
    private _buildSections;
    /**
     * Classify whether this session should use single-agent or multi-agent mode.
     *
     * Uses a one-shot Haiku call (~300–500 ms, ~$0.00012) with:
     *   - The user's first prompt
     *   - Robot name (if known)
     *   - AGENT.md content (if present, from D1c)
     *   - Existing experience count (signals project maturity)
     *
     * On any error or timeout, falls back to 'multi' (conservative: full capability).
     *
     * After classification:
     *   - Sets _agentMode and _modeClassified
     *   - Invalidates the R1 section cache so next resolveToString() renders
     *     the correct single/multi variant, then memoizes it for all future turns
     *   - Persists the mode to project state for session resumption
     */
    private _classifyAgentMode;
}
//# sourceMappingURL=RoboticsSession.d.ts.map