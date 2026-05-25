/**
 * GenericCampaignStore<TPhase, TState>
 *
 * A reusable, file-backed ICampaignStore for any campaign type EXCEPT DOE
 * (which keeps its own CampaignStateStore to avoid migration risk).
 *
 * On-disk layout:
 *   ~/.claude/meta-agent/campaigns/<campaignId>/state.json
 *
 * Concurrency model:
 *   Identical to CampaignStateStore — a per-instance promise chain (_lock)
 *   serialises all mutations.  Reads are non-locking but re-read from disk
 *   to stay consistent after external modifications.
 *
 * Atomic writes:
 *   state.json is written to a .tmp file first, then renamed — same pattern
 *   as CampaignStateStore to survive process crashes.
 */
import type { ICampaignStore } from './types.js';
export declare class GenericCampaignStore<TPhase extends string, TState extends object> implements ICampaignStore<TPhase, TState> {
    readonly campaignId: string;
    readonly projectName: string;
    private readonly campaignDir;
    private readonly pluginType;
    /** Serialise all write operations — matches CampaignStateStore pattern */
    private _lock;
    private constructor();
    /**
     * Create a brand-new campaign on disk and return its store.
     * Throws if a campaign with the same ID already exists.
     */
    static create<TPhase extends string, TState extends object>(campaignId: string, projectName: string, pluginType: string, pluginVersion: string, initialState: TState, initialPhase: TPhase): Promise<GenericCampaignStore<TPhase, TState>>;
    /**
     * Open an existing campaign from disk.
     * Runs validateState() and migrateState() if the plugin version changed.
     */
    static open<TPhase extends string, TState extends object>(campaignId: string): Promise<GenericCampaignStore<TPhase, TState>>;
    getPhase(): Promise<TPhase>;
    getState(): Promise<TState>;
    updateState(patch: Partial<TState>): Promise<void>;
    transitionPhase(to: TPhase): Promise<void>;
    markFailed(reason: string): Promise<void>;
    addPendingTask(taskId: string): Promise<void>;
    completeTask(taskId: string): Promise<void>;
    failTask(taskId: string): Promise<void>;
    private _withLock;
    private _read;
    private _writeAtomic;
}
export interface GenericCampaignSummary {
    campaignId: string;
    projectName: string;
    pluginType: string;
    phase: string;
    updatedAt: string;
    failureReason?: string;
}
/**
 * Scan CAMPAIGNS_DIR and return a lightweight summary of every persisted
 * generic campaign.  Skips directories that don't contain a valid state.json.
 */
export declare function listGenericCampaigns(): Promise<GenericCampaignSummary[]>;
//# sourceMappingURL=store.d.ts.map