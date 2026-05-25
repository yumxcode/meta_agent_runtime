import type { RoboticsProjectState, ActiveSubAgentRecord, RoboticsGitState } from '../types.js';
export declare class RoboticsProjectStore {
    static findByProjectDir(dir: string): Promise<RoboticsProjectState | null>;
    static save(state: RoboticsProjectState): Promise<void>;
    static touch(projectDir: string): Promise<void>;
    static appendProgress(projectDir: string, note: string): Promise<void>;
    static registerSubAgentTask(dir: string, record: ActiveSubAgentRecord): Promise<void>;
    static completeSubAgentTask(dir: string, taskId: string): Promise<void>;
    /**
     * Remove a stale sub-agent task that could not be reconciled on session resume.
     * Clears the task from activeSubAgentTasks, subAgentBranches, and forkPoints.
     * Does NOT add to completedSubAgentTaskIds — stale tasks were never finished.
     */
    static purgeStaleSubAgentTask(dir: string, taskId: string): Promise<void>;
    static updateGitState(dir: string, git: Partial<RoboticsGitState>): Promise<void>;
}
//# sourceMappingURL=RoboticsProjectStore.d.ts.map