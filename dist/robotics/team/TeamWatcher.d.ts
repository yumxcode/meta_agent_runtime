import type { TeamStore, TeamSyncSummary } from './TeamStore.js';
export interface TeamWatcherEvent {
    at: string;
    message: string;
}
export declare class TeamWatcher {
    private readonly store;
    private readonly intervalMs;
    private timer;
    private running;
    private lastState;
    private lastSignature;
    private lastRemoteSignature;
    private lastSync;
    /** ISO timestamp of when the last tick() completed successfully. */
    private lastSyncAt;
    private events;
    constructor(store: TeamStore, intervalMs?: number);
    start(): void;
    stop(): void;
    /**
     * Run a single sync tick now, returning the latest TeamSyncSummary.
     *
     * `fetch` defaults to `false`: the background timer and post-operation
     * refreshes should be cheap.  Callers responding to an explicit user action
     * (e.g. `/team sync`, `/team pull`) should set it to `true`; even then the
     * cooldown inside TeamStore.sync() may skip the actual `git fetch`.
     */
    forceSync(fetch?: boolean): Promise<TeamSyncSummary>;
    getRecentEvents(limit?: number): TeamWatcherEvent[];
    formatPromptContext(): string | null;
    private tick;
    private record;
    private recordRemoteDiff;
    private recordDiff;
}
//# sourceMappingURL=TeamWatcher.d.ts.map