export type RoboticsDomain = 'motion_planning' | 'perception' | 'manipulation' | 'locomotion' | 'navigation' | 'simulation' | 'hardware_interface' | 'deployment' | 'calibration' | 'general';
export declare const ROBOTICS_DOMAINS: RoboticsDomain[];
export type RoboticsAgentRole = 'orchestrator' | 'paper_search' | 'experiment' | 'code' | 'analysis' | 'deployment';
export type KnowledgeConfidenceTier = 'observed' | 'reproduced' | 'derived' | 'reported' | 'hypothesis';
export declare const KNOWLEDGE_CONFIDENCE_TIERS: KnowledgeConfidenceTier[];
export type KnowledgeScope = 'global' | 'robot' | 'code';
export declare const KNOWLEDGE_SCOPES: KnowledgeScope[];
export type PrincipleAbstractionLevel = 'physical' | 'system' | 'algorithmic' | 'statistical' | 'operational';
export declare const PRINCIPLE_ABSTRACTION_LEVELS: PrincipleAbstractionLevel[];
export interface PrincipleEntry {
    id: string;
    schemaVersion: '1.0';
    createdAt: number;
    updatedAt: number;
    title: string;
    statement: string;
    mechanism: string;
    firstPrinciplesSupport: string[];
    domains: RoboticsDomain[];
    abstractionLevel: PrincipleAbstractionLevel;
    preconditions: string[];
    applicabilityBounds: string[];
    nonApplicableWhen: string[];
    derivedFromExperienceIds: string[];
    anchoredByPhysicalAnchorIds: string[];
    evidenceRefs: string[];
    invalidatedAssumptions: string[];
    counterExamples: string[];
    confidenceTier: KnowledgeConfidenceTier;
    observationCount: number;
    contradictionCount: number;
    promotionReason: 'confidence_threshold' | 'explicit_user_request';
    sourceExperienceId?: string;
    lastVerifiedAt?: number;
}
export interface PrincipleSearchQuery {
    domain?: RoboticsDomain;
    abstractionLevel?: PrincipleAbstractionLevel;
    experienceId?: string;
    anchorId?: string;
    keyword?: string;
    limit?: number;
}
export interface ExperienceOutcome {
    success: boolean;
    summary: string;
    failureReason?: string;
    workarounds?: string[];
}
export interface ExperienceEntry {
    id: string;
    schemaVersion: '1.0';
    createdAt: number;
    updatedAt: number;
    domain: RoboticsDomain;
    algorithm?: string;
    tags: string[];
    robot?: string;
    difficulty: 'low' | 'medium' | 'high';
    title: string;
    problem: string;
    solution: string;
    outcome: ExperienceOutcome;
    /**
     * Same-domain abstract principle extracted by flash model at write time.
     * Used for same-domain principle matching in ExperiencePatternChecker.
     * Example: "Spatial resolution × map size determines peak memory; estimate before coding."
     */
    abstractPrinciple?: string;
    /** How strongly this experience should be trusted when retrieved. */
    confidenceTier?: KnowledgeConfidenceTier;
    /** Experiment log, commit, report, paper, datasheet, or other supporting references. */
    evidenceRefs?: string[];
    /** Number of independent observations supporting this lesson. Defaults to 1. */
    observationCount?: number;
    /** Number of later observations that contradicted this lesson. Defaults to 0. */
    contradictionCount?: number;
    /** Assumptions this experience falsified. Especially important for failures. */
    invalidatedAssumptions?: string[];
    /** Last time the lesson was checked against observation or source evidence. */
    lastVerifiedAt?: number;
    metrics?: Record<string, number | string>;
    sourceTaskId?: string;
    sourceSessionId?: string;
    /** Reviewed principles promoted from or linked to this concrete experience. */
    principleIds?: string[];
    relatedPapers?: string[];
    fullReport?: string;
}
export interface ExperienceSearchQuery {
    domain?: RoboticsDomain;
    tags?: string[];
    algorithm?: string;
    robot?: string;
    keyword?: string;
    successOnly?: boolean;
    limit?: number;
}
export declare function makeExperienceId(): string;
export declare function makePrincipleId(): string;
export interface PhysicalAnchorEntry {
    id: string;
    schemaVersion: '1.0';
    createdAt: number;
    updatedAt: number;
    domain: RoboticsDomain;
    /** Scope controls where this anchor should be considered applicable. */
    scope: KnowledgeScope;
    robot?: string;
    title: string;
    /** Concrete physical/device fact the model should not infer away. */
    fact: string;
    /** Mechanism explaining why the fact matters, if known. */
    mechanism?: string;
    /** Operational implication for planning/debugging. */
    implication: string;
    tags: string[];
    confidenceTier: KnowledgeConfidenceTier;
    evidenceRefs: string[];
    source?: string;
    lastVerifiedAt?: number;
    invalidates?: string[];
}
export interface PhysicalAnchorSearchQuery {
    domain?: RoboticsDomain;
    scope?: KnowledgeScope;
    robot?: string;
    tags?: string[];
    keyword?: string;
    limit?: number;
}
export declare function makePhysicalAnchorId(): string;
export interface ExperimentSpec {
    title: string;
    hypothesis: string;
    environment: string;
    procedure: string;
    successCriteria: string;
    maxTurns?: number;
    timeoutMs?: number;
}
export interface ExperimentSummary {
    specTitle: string;
    outcome: 'success' | 'partial' | 'failure' | 'timeout';
    metrics: Record<string, number | string>;
    keyFindings: string[];
    failureAnalysis?: string;
    nextSuggestions: string[];
    /** Pending ID returned by experience_write; becomes an ExperienceStore ID only after review approval. */
    pendingExperienceId?: string;
    branchName?: string;
    durationMs: number;
    turnsUsed: number;
}
export interface HardwareProfileData {
    schemaVersion: '1.0';
    name: string;
    platform: string;
    compute: string;
    os?: string;
    actuators?: string;
    sensors?: string;
    safetyLimits: Record<string, string | number>;
    knownIssues?: string[];
    notes?: string;
    updatedAt: number;
}
export interface RoboticsGitState {
    enabled: boolean;
    mainBranch: string;
    subAgentBranches: Record<string, string>;
    forkPoints: Record<string, string>;
}
export interface ActiveSubAgentRecord {
    taskId: string;
    role: RoboticsAgentRole;
    title: string;
    branchName?: string;
    worktreePath?: string;
    spawnedAt: number;
    lastCheckpointAt?: number;
    /**
     * Why this sub-agent was dispatched (one sentence).
     * Stored so R3 can remind the orchestrator of the causal context.
     */
    purpose?: string;
    /**
     * What the orchestrator (main agent) will do once this task completes.
     * Required for experiment_dispatch — prevents orphan tasks with no result handling.
     * Displayed in R3 every turn so the agent never forgets its commitment.
     */
    on_complete?: string;
}
/**
 * single — main agent handles everything directly; no sub-agent dispatch.
 *          R1 omits multi-agent roles and Git coordination protocol.
 * multi  — full multi-agent orchestration; experiment_dispatch, paper_search,
 *          Git worktree isolation, and noise-isolation protocol all active.
 *
 * Classified by flash model on first submit() using task context + AGENT.md signals.
 * Persisted in project state so resumed sessions keep the same mode.
 */
export type RoboticsAgentMode = 'single' | 'multi';
export interface RoboticsProjectState {
    schemaVersion: '1.0';
    sessionId: string;
    projectDir: string;
    robot?: string;
    createdAt: number;
    lastActiveAt: number;
    currentPhase?: string;
    progressNotes: string[];
    activeSubAgentTasks: ActiveSubAgentRecord[];
    completedSubAgentTaskIds: string[];
    git: RoboticsGitState;
    /** Classified on first submit; persisted so resumed sessions stay in same mode. */
    agentMode?: RoboticsAgentMode;
    /**
     * User-set star flag.  Starred sessions are exempt from 7-day auto-purge.
     * Defaults to false (not starred).
     */
    starred?: boolean;
    /**
     * User-defined labels for grouping and filtering sessions.
     * e.g. ['go2', 'mpc', 'sprint-3']
     */
    tags?: string[];
}
export interface RoboticsProjectSummary {
    projectDir: string;
    sessionId: string;
    robot?: string;
    createdAt: number;
    lastActiveAt: number;
    starred: boolean;
    tags: string[];
    currentPhase?: string;
    agentMode?: RoboticsAgentMode;
    /** Age in days since last activity. */
    idleDays: number;
}
//# sourceMappingURL=types.d.ts.map