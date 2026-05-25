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
    forceSync(fetch?: boolean): Promise<TeamSyncSummary>;
    getRecentEvents(limit?: number): TeamWatcherEvent[];
    formatPromptContext(): string | null;
    private tick;
    private record;
    private recordRemoteDiff;
    private recordDiff;
}
//# sourceMappingURL=TeamWatcher.d.ts.map