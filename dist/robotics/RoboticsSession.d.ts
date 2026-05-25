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
import { type TeamModuleAddInput, type TeamSyncSummary, type TeamTaskAddInput, type TeamTaskStatus } from './team/TeamStore.js';
import { type TeamWatcherEvent } from './team/TeamWatcher.js';
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
    private readonly teamStore;
    private readonly teamWatcher;
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
    /** #11: Guard against concurrent submit() calls on the same RoboticsSession. */
    private _submitInFlight;
    /**
     * Plan B context boundary — set once after task claim when the session has prior history.
     * Injected as the first section in _getRoboticsExtensions() to anchor the AI's perception
     * of where this task starts.
     */
    private _teamContextBoundary;
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
    teamInit(github?: string): Promise<import("./team/TeamStore.js").TeamState>;
    teamJoin(github?: string, human?: string): Promise<import("./team/TeamStore.js").TeamState>;
    teamClaim(taskId: string): Promise<{
        state: import("./team/TeamStore.js").TeamState;
        task: import("./team/TeamStore.js").TeamTask;
        warnings: string[];
    }>;
    /** Transition a claimed/backlog task to in_progress (begin active work). */
    teamStart(taskId?: string): Promise<{
        state: import("./team/TeamStore.js").TeamState;
        task: import("./team/TeamStore.js").TeamTask;
    }>;
    teamTaskAdd(input: TeamTaskAddInput): Promise<{
        state: import("./team/TeamStore.js").TeamState;
        task: import("./team/TeamStore.js").TeamTask;
    }>;
    teamTaskStatus(taskId: string, status: TeamTaskStatus): Promise<{
        state: import("./team/TeamStore.js").TeamState;
        task: import("./team/TeamStore.js").TeamTask;
    }>;
    teamModuleAdd(input: TeamModuleAddInput): Promise<{
        state: import("./team/TeamStore.js").TeamState;
        module: import("./team/TeamStore.js").TeamModule;
    }>;
    teamModuleOwner(name: string, ownerUnit?: string): Promise<{
        state: import("./team/TeamStore.js").TeamState;
        module: import("./team/TeamStore.js").TeamModule;
    }>;
    teamCheck(): Promise<import("./team/TeamStore.js").TeamConflictReport>;
    teamCheckPaths(paths: string[]): Promise<import("./team/TeamStore.js").TeamConflictReport>;
    teamBranch(taskId?: string): Promise<import("./team/TeamStore.js").TeamBranchResult>;
    teamPush(): Promise<import("./team/TeamStore.js").TeamPushResult>;
    teamPr(taskId?: string): Promise<import("./team/TeamStore.js").TeamPrDraftResult>;
    teamHandoff(taskId?: string, note?: string): Promise<import("./team/TeamStore.js").TeamHandoffResult>;
    teamOnboarding(): Promise<import("./team/TeamStore.js").TeamOnboardingSummary>;
    teamGitHubIssuesSync(taskId?: string): Promise<import("./team/TeamStore.js").TeamGitHubIssueSyncResult[]>;
    teamGitHubProjectAdd(projectNumber: string, owner?: string): Promise<import("./team/TeamStore.js").TeamGitHubProjectResult>;
    teamStatus(): Promise<import("./team/TeamStore.js").TeamState | null>;
    teamSync(): Promise<TeamSyncSummary>;
    teamPull(): Promise<import("./team/TeamStore.js").TeamPullResult>;
    teamConflicts(): Promise<import("./team/TeamStore.js").MergeConflictReport>;
    teamResolveTeamJson(): Promise<import("./team/TeamStore.js").TeamJsonResolveResult>;
    /**
     * Plan B: context boundary.
     * Called once after task claim when the session has prior conversation history.
     *
     * mode='background' — prior conversation is the origin of this task; AI may reference it
     *   as background context but must not describe it as task work-in-progress.
     * mode='unrelated'  — prior conversation is unrelated; AI must not attribute it to this task.
     */
    teamSetContextBoundary(mode: 'background' | 'unrelated', taskId: string): Promise<void>;
    teamWatcherPoll(): Promise<TeamWatcherEvent[]>;
    teamWatcherEvents(): TeamWatcherEvent[];
    /**
     * @deprecated Use dispose() for full cleanup (heartbeat, watcher, worktrees, bridge).
     * This alias remains for backward compatibility and now delegates to dispose().
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