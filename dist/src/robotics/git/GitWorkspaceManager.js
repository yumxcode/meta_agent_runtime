import { execFile } from 'child_process';
import { promisify } from 'util';
import { stat, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
const execFileAsync = promisify(execFile);
const WORKTREE_BASE = join(homedir(), '.cache', 'meta-agent', 'worktrees');
export class GitWorkspaceManager {
    projectDir;
    worktreeBaseDir;
    constructor(projectDir, worktreeBaseDir) {
        this.projectDir = projectDir;
        this.worktreeBaseDir = worktreeBaseDir ?? WORKTREE_BASE;
    }
    get enabled() {
        return existsSync(join(this.projectDir, '.git'));
    }
    async detectGitState() {
        if (!this.enabled)
            return { enabled: false, mainBranch: 'main', subAgentBranches: {}, forkPoints: {} };
        try {
            const branch = (await this._git(['symbolic-ref', '--short', 'HEAD'])).trim();
            return { enabled: true, mainBranch: branch, subAgentBranches: {}, forkPoints: {} };
        }
        catch {
            return { enabled: false, mainBranch: 'main', subAgentBranches: {}, forkPoints: {} };
        }
    }
    async createWorktreeForTask(taskId, role) {
        const branchName = `sub/${taskId}/${role}`;
        const worktreePath = join(this.worktreeBaseDir, taskId);
        const forkPoint = (await this._git(['rev-parse', 'HEAD'])).trim();
        await mkdir(this.worktreeBaseDir, { recursive: true });
        // Create branch from current HEAD
        await this._git(['checkout', '-b', branchName]);
        // Return to original branch
        await this._git(['checkout', '-']);
        // Create worktree pointing to new branch
        await this._git(['worktree', 'add', worktreePath, branchName]);
        return { taskId, role, branchName, worktreePath, forkPoint, createdAt: Date.now() };
    }
    async syncMainToTask(taskId, branchName) {
        const worktreePath = join(this.worktreeBaseDir, taskId);
        if (!(await this._worktreeExists(worktreePath))) {
            throw new Error(`Worktree not found for task ${taskId}`);
        }
        try {
            await this._gitIn(worktreePath, ['rebase', 'main']);
            const ahead = parseInt((await this._gitIn(worktreePath, ['rev-list', '--count', 'main..HEAD'])).trim(), 10);
            const behind = parseInt((await this._gitIn(worktreePath, ['rev-list', '--count', 'HEAD..main'])).trim(), 10);
            return { branchName, commitsAhead: ahead, commitsBehind: behind, hasConflicts: false };
        }
        catch {
            await this._gitIn(worktreePath, ['rebase', '--abort']).catch(() => undefined);
            return { branchName, commitsAhead: 0, commitsBehind: 0, hasConflicts: true };
        }
    }
    async mergeTaskBranch(taskId, branchName, opts) {
        const msg = opts.message ?? `feat: sub-agent ${branchName} results`;
        switch (opts.strategy) {
            case 'squash':
                await this._git(['merge', '--squash', branchName]);
                await this._git(['commit', '-m', msg]);
                break;
            case 'merge':
                await this._git(['merge', '--no-ff', '-m', msg, branchName]);
                break;
            case 'cherry-pick':
                if (!opts.commitHashes?.length)
                    throw new Error('cherry-pick requires commitHashes');
                await this._git(['cherry-pick', ...opts.commitHashes]);
                break;
        }
        const commitHash = (await this._git(['rev-parse', 'HEAD'])).trim();
        return { merged: true, commitHash };
    }
    async getTaskDiff(taskId, branchName) {
        try {
            return await this._git(['diff', 'main...', branchName, '--stat']);
        }
        catch {
            return 'Could not compute diff';
        }
    }
    async getTaskBranchStatus(taskId, branchName) {
        try {
            const [aheadRaw, behindRaw, msgRaw, dateRaw] = await Promise.all([
                this._git(['rev-list', '--count', `main..${branchName}`]),
                this._git(['rev-list', '--count', `${branchName}..main`]),
                this._git(['log', '-1', '--format=%s', branchName]),
                this._git(['log', '-1', '--format=%at', branchName]),
            ]);
            return {
                commitsAhead: parseInt(aheadRaw.trim(), 10),
                commitsBehind: parseInt(behindRaw.trim(), 10),
                lastCommitMessage: msgRaw.trim(),
                lastCommitAt: parseInt(dateRaw.trim(), 10) * 1000,
            };
        }
        catch {
            return { commitsAhead: 0, commitsBehind: 0, lastCommitMessage: '', lastCommitAt: 0 };
        }
    }
    async removeWorktree(taskId, opts = {}) {
        const worktreePath = join(this.worktreeBaseDir, taskId);
        await this._git(['worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
        if (opts.deleteBranch && opts.branchName) {
            await this._git(['branch', '-D', opts.branchName]).catch(() => undefined);
        }
    }
    /**
     * Reconcile persisted worktree records against disk on session resume.
     *
     * For each recorded sub-agent branch:
     *   - If the worktree directory exists and is healthy → keep it as-is.
     *   - If missing → try to restore via `git worktree add`.
     *   - If restore also fails (branch deleted, repo moved, etc.) → treat the
     *     task as stale and return its ID so the caller can purge it from state.
     *
     * Returns the list of stale task IDs that could not be reconciled.
     * The caller is responsible for removing them from RoboticsProjectStore.
     */
    async reconcileWorktrees(gitState) {
        const staleTaskIds = [];
        for (const [taskId, branchName] of Object.entries(gitState.subAgentBranches)) {
            const worktreePath = join(this.worktreeBaseDir, taskId);
            try {
                await stat(worktreePath);
                await this._gitIn(worktreePath, ['status']);
                // Healthy — nothing to do
            }
            catch {
                // Worktree missing — try to restore
                const restored = await this._git(['worktree', 'add', worktreePath, branchName])
                    .then(() => true)
                    .catch(() => false);
                if (!restored) {
                    // Cannot restore — mark stale for cleanup
                    staleTaskIds.push(taskId);
                }
            }
        }
        return staleTaskIds;
    }
    async _git(args) {
        return this._gitIn(this.projectDir, args);
    }
    async _gitIn(cwd, args) {
        const { stdout } = await execFileAsync('git', args, { cwd });
        return stdout;
    }
    async _worktreeExists(path) {
        try {
            await stat(path);
            return true;
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=GitWorkspaceManager.js.map