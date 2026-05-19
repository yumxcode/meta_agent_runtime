/**
 * Campaign Plugin Framework — Core Types
 *
 * Defines the CampaignPlugin<TPhase, TState, TParams> interface that every
 * campaign type must implement.  The framework is intentionally agnostic about
 * the specific phases and state shape — those are owned by each plugin.
 *
 * Design goals:
 *  - Registration Pattern now (zero dynamic loading overhead)
 *  - Interface-stable for future true plugin loading (loadExternalPlugin)
 *  - Minimal disruption to existing DOE code (CampaignStateStore stays as-is)
 *  - First-class state migration from day one
 *
 * Directory layout:
 *   src/campaign/         ← framework (this file, registry, generic store)
 *   src/campaigns/doe/    ← DOE plugin (wraps existing CampaignStateStore)
 *   src/campaigns/paper-repro/  ← PaperRepro plugin
 *   src/campaigns/index.ts      ← registration entrypoint (import at startup)
 */
import type { MetaAgentTool } from '../core/types.js';
export interface PhaseDefinition<TPhase extends string> {
    /** Phase where every new campaign begins */
    initial: TPhase;
    /** Phases that are final — no further transitions allowed */
    terminal: readonly TPhase[];
    /**
     * Phases where the system pauses and waits for explicit human input
     * before transitioning.  The main agent should present these to the user.
     */
    humanCheckpoints: readonly TPhase[];
    /**
     * Phases that run autonomously (sub-agents, background workers, etc.).
     * The main agent should not prompt the user while in these phases.
     */
    machinePhases: readonly TPhase[];
    /**
     * Valid phase transitions.  Enforced by the store's transitionPhase().
     * Plugins should include all forward AND recovery transitions.
     */
    transitions: Partial<Record<TPhase, readonly TPhase[]>>;
    /** Human-readable labels used in capsule / status lines / UI */
    labels: Record<TPhase, string>;
}
/**
 * The framework only needs these five operations to manage a campaign's
 * lifecycle.  Plugins may expose richer APIs via their concrete store types
 * (e.g. CampaignStateStore for DOE), but the Campaign Framework uses only
 * this interface.
 */
export interface ICampaignStore<TPhase extends string, TState extends object> {
    readonly campaignId: string;
    readonly projectName: string;
    /** Current phase — authoritative on-disk value */
    getPhase(): Promise<TPhase>;
    /** Plugin-specific business state */
    getState(): Promise<TState>;
    /**
     * Persist a partial state update (deep-merged with existing state).
     * Implementations must serialise concurrent calls.
     */
    updateState(patch: Partial<TState>): Promise<void>;
    /**
     * Atomically advance the phase.  Must reject if the transition is not
     * in PhaseDefinition.transitions[currentPhase].
     */
    transitionPhase(to: TPhase): Promise<void>;
    /**
     * Mark the campaign as failed, recording a human-readable reason.
     * Equivalent to transitionPhase('FAILED') + updateState({ failureReason }).
     */
    markFailed(reason: string): Promise<void>;
}
/**
 * Written by GenericCampaignStore as <campaignDir>/state.json.
 * DOE campaigns use their own PersistedCampaignState format (unchanged).
 *
 * The businessState field is opaque to the framework — each plugin owns
 * its shape and validates it via CampaignPlugin.validateState().
 */
export interface GenericPersistedState<TPhase extends string, TState extends object> {
    /** Bump when the wrapper format changes (not business state) */
    schemaVersion: string;
    /** Matches CampaignPlugin.type — used to dispatch to the right plugin on load */
    pluginType: string;
    /** Matches CampaignPlugin.version — used to decide whether migration is needed */
    pluginVersion: string;
    campaignId: string;
    projectName: string;
    phase: TPhase;
    createdAt: string;
    updatedAt: string;
    /** Plugin-specific state — opaque to the framework */
    businessState: TState;
    /** Sub-agent / worker task tracking */
    pendingTaskIds: string[];
    completedTaskIds: string[];
    failedTaskIds: string[];
    /** Non-null when phase is FAILED/BLOCKED */
    failureReason?: string;
}
export declare const GENERIC_SCHEMA_VERSION: "1.0";
/**
 * @typeParam TPhase  - Union of string literals for this campaign's phases
 * @typeParam TState  - Plugin-specific business state shape (persisted)
 * @typeParam TParams - Parameters accepted by createInitialState (e.g. from user input)
 */
export interface CampaignPlugin<TPhase extends string, TState extends object, TParams extends object = Record<string, unknown>> {
    /** Stable lowercase identifier — used as discriminant in persisted state */
    readonly type: string;
    /**
     * SemVer string.  When the plugin loads an existing campaign and detects
     * a version mismatch, it calls migrateState() before using the state.
     */
    readonly version: string;
    /** Displayed in the UI and capsule headers */
    readonly displayName: string;
    /** One-line description for the campaign picker */
    readonly description: string;
    readonly phases: PhaseDefinition<TPhase>;
    /**
     * Create the initial business state for a brand-new campaign.
     * Called once, at campaign creation time.
     */
    createInitialState(params: TParams): TState;
    /**
     * Type guard — validates that an unknown value conforms to TState.
     * Used when loading state from disk to catch corruption early.
     */
    validateState(raw: unknown): raw is TState;
    /**
     * Migrate state persisted by an older plugin version.
     * Optional: if absent, the framework will error on version mismatch
     * rather than silently using stale state.
     *
     * @param oldState   - Raw parsed JSON from disk (unknown shape)
     * @param fromVersion - Plugin version that wrote the state
     */
    migrateState?(oldState: unknown, fromVersion: string): TState;
    /**
     * Build the ≤500-token markdown context block injected into D10.
     * Must be deterministic and synchronous — called on every session resume.
     *
     * @param state - Current business state (already validated)
     * @param phase - Current phase
     * @returns Markdown string for the "Active Campaign" section
     */
    buildCapsule(state: TState, phase: TPhase): string;
    /**
     * Return phase-specific guidance for the main agent (D10 section).
     * The returned string is injected verbatim below the campaign summary.
     *
     * @param phase - Current phase
     * @param state - Current business state
     */
    buildPhaseGuidance(phase: TPhase, state: TState): string;
    /**
     * Tools that are only available when this campaign type is active.
     * The framework registers these alongside the global tool set at session
     * start and removes them when the campaign completes.
     */
    readonly tools: readonly MetaAgentTool[];
    /**
     * Called by the store immediately AFTER a phase transition is persisted.
     * Use for side-effects: starting background workers, sending notifications,
     * creating sub-agent tasks, etc.
     *
     * Must not throw — errors are logged and swallowed by the framework.
     */
    onPhaseEnter?(phase: TPhase, state: TState): Promise<void>;
    /**
     * Called by the store immediately BEFORE a phase transition is persisted.
     * Use for cleanup: stopping timers, writing interim reports, etc.
     *
     * Must not throw — errors are logged and swallowed by the framework.
     */
    onPhaseExit?(phase: TPhase, state: TState): Promise<void>;
    /**
     * Generate the final human-readable report when the campaign reaches
     * a terminal phase.  If absent, the framework skips report generation.
     *
     * @param state - Final business state
     * @returns Markdown string written to <campaignDir>/final-report.md
     */
    buildFinalReport?(state: TState): string;
}
export type AnyPlugin = CampaignPlugin<any, any, any>;
//# sourceMappingURL=types.d.ts.map