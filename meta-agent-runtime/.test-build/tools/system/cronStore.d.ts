/**
 * In-process cron job store.
 *
 * Implements a lightweight cron scheduler using Node's setInterval.
 * Each job is keyed by a UUID.  Jobs run within the current process for the
 * lifetime of the session (or until explicitly deleted).
 *
 * Design mirrors CC's ScheduleCronTool (CronCreateTool / CronDeleteTool /
 * CronListTool) but uses pure Node instead of a cron library dependency.
 */
export interface CronJob {
    id: string;
    expression: string;
    description: string;
    sessionId: string;
    createdAt: Date;
    lastRunAt: Date | null;
    runCount: number;
    active: boolean;
}
type CronCallback = () => void | Promise<void>;
export declare function createCronJob(expression: string, description: string, sessionId: string, callback: CronCallback): CronJob;
export declare function deleteCronJob(id: string): boolean;
/**
 * Cancel and remove all cron jobs belonging to a session.
 *
 * Call this when a session ends to prevent dangling setInterval callbacks
 * from accumulating in the module-level store (memory leak + wasted CPU).
 * Returns the number of jobs that were cancelled.
 */
export declare function deleteJobsForSession(sessionId: string): number;
export declare function listCronJobs(sessionId?: string): CronJob[];
export {};
//# sourceMappingURL=cronStore.d.ts.map