import { createHash } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import { atomicWriteJson, readJsonFile } from '../../core/persist/index.js';
const PROJECTS_ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'projects');
const RESUME_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_PROGRESS_NOTES = 10;
function projectHash(projectDir) {
    return createHash('sha1').update(projectDir).digest('hex').slice(0, 16);
}
function projectBucketDir(dir) {
    return join(PROJECTS_ROOT, projectHash(dir));
}
function stateFile(dir) {
    return join(projectBucketDir(dir), 'state.json');
}
export class RoboticsProjectStore {
    static async findByProjectDir(dir) {
        const state = await readJsonFile(stateFile(dir));
        if (!state || state.schemaVersion !== '1.0')
            return null;
        if (Date.now() - state.lastActiveAt > RESUME_WINDOW_MS)
            return null;
        return state;
    }
    static async save(state) {
        await atomicWriteJson(stateFile(state.projectDir), state);
    }
    static async touch(projectDir) {
        const state = await RoboticsProjectStore.findByProjectDir(projectDir);
        if (state) {
            state.lastActiveAt = Date.now();
            await RoboticsProjectStore.save(state);
        }
    }
    static async appendProgress(projectDir, note) {
        const state = await RoboticsProjectStore.findByProjectDir(projectDir);
        if (!state)
            return;
        state.progressNotes.push(`[${new Date().toISOString().slice(0, 16)}] ${note}`);
        if (state.progressNotes.length > MAX_PROGRESS_NOTES) {
            state.progressNotes = state.progressNotes.slice(-MAX_PROGRESS_NOTES);
        }
        await RoboticsProjectStore.save(state);
    }
    static async registerSubAgentTask(dir, record) {
        const state = await RoboticsProjectStore.findByProjectDir(dir);
        if (!state)
            return;
        state.activeSubAgentTasks = state.activeSubAgentTasks.filter(t => t.taskId !== record.taskId);
        state.activeSubAgentTasks.push(record);
        await RoboticsProjectStore.save(state);
    }
    static async completeSubAgentTask(dir, taskId) {
        const state = await RoboticsProjectStore.findByProjectDir(dir);
        if (!state)
            return;
        state.activeSubAgentTasks = state.activeSubAgentTasks.filter(t => t.taskId !== taskId);
        if (!state.completedSubAgentTaskIds.includes(taskId)) {
            state.completedSubAgentTaskIds.push(taskId);
        }
        await RoboticsProjectStore.save(state);
    }
    /**
     * Remove a stale sub-agent task that could not be reconciled on session resume.
     * Clears the task from activeSubAgentTasks, subAgentBranches, and forkPoints.
     * Does NOT add to completedSubAgentTaskIds — stale tasks were never finished.
     */
    static async purgeStaleSubAgentTask(dir, taskId) {
        const state = await RoboticsProjectStore.findByProjectDir(dir);
        if (!state)
            return;
        state.activeSubAgentTasks = state.activeSubAgentTasks.filter(t => t.taskId !== taskId);
        delete state.git.subAgentBranches[taskId];
        delete state.git.forkPoints[taskId];
        await RoboticsProjectStore.save(state);
    }
    static async updateGitState(dir, git) {
        const state = await RoboticsProjectStore.findByProjectDir(dir);
        if (!state)
            return;
        state.git = {
            ...state.git,
            ...git,
            subAgentBranches: { ...state.git.subAgentBranches, ...(git.subAgentBranches ?? {}) },
            forkPoints: { ...state.git.forkPoints, ...(git.forkPoints ?? {}) },
        };
        await RoboticsProjectStore.save(state);
    }
}
//# sourceMappingURL=RoboticsProjectStore.js.map