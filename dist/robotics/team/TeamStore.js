import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { atomicWriteJson } from '../../core/persist/index.js';
import { TeamStateSchema, parseOrNull } from '../../core/persist/schemas.js';
const execFileAsync = promisify(execFile);
const TEAM_DIR = 'team';
const STATE_FILE = 'team.json';
const VALID_TASK_STATUSES = ['backlog', 'claimed', 'in_progress', 'blocked', 'review', 'done', 'paused', 'handoff', 'cancelled'];
const ACTIVE_TASK_STATUSES = new Set(['claimed', 'in_progress', 'blocked', 'review']);
/**
 * Single authoritative definition of "active" for a team task.
 *
 * Used consistently across TeamStore, dynamicSection, and CLI formatTeamState
 * so that prompt context, onboarding summary, and the board all agree.
 *
 * Active = the task is in progress or reserved and NOT yet done/cancelled/handoff.
 */
export function isActiveTask(task) {
    return ACTIVE_TASK_STATUSES.has(task.status);
}
function normalizeRepoPath(value) {
    return value
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '');
}
function patternBase(pattern) {
    const normalized = normalizeRepoPath(pattern);
    const wildcard = normalized.search(/[*?[\]{}]/);
    if (wildcard < 0) {
        // No wildcards — normalise to a directory prefix ending with '/'.
        // This prevents "src".startsWith("src") from falsely matching "src-other".
        return normalized.endsWith('/') ? normalized : `${normalized}/`;
    }
    const prefix = normalized.slice(0, wildcard);
    const slash = prefix.lastIndexOf('/');
    // Return '' when the wildcard is in the first path segment (e.g. "*.ts") —
    // no directory constraint, the pattern matches anywhere.
    return slash >= 0 ? prefix.slice(0, slash + 1) : '';
}
function pathMatchesPattern(path, pattern) {
    const p = normalizeRepoPath(path);
    const pat = normalizeRepoPath(pattern);
    if (!pat || pat === 'TBD')
        return false;
    if (pat === '**' || pat === '*')
        return true;
    if (!/[*?[\]{}]/.test(pat)) {
        return p === pat || p.startsWith(`${pat.replace(/\/$/, '')}/`);
    }
    const base = patternBase(pat);
    return base ? p.startsWith(base) : true;
}
function patternsOverlap(a, b) {
    const left = normalizeRepoPath(a);
    const right = normalizeRepoPath(b);
    if (!left || !right || left === 'TBD' || right === 'TBD')
        return false;
    if (pathMatchesPattern(left, right) || pathMatchesPattern(right, left))
        return true;
    const leftBase = patternBase(left);
    const rightBase = patternBase(right);
    if (!leftBase || !rightBase)
        return true;
    return leftBase.startsWith(rightBase) || rightBase.startsWith(leftBase);
}
function nowIso() {
    return new Date().toISOString();
}
function parseIssueNumber(url) {
    const match = url.match(/\/issues\/(\d+)(?:$|[/?#])/);
    return match ? Number.parseInt(match[1], 10) : undefined;
}
function githubLabelValue(value) {
    return value.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}
function defaultUnitId() {
    const user = process.env.USER || process.env.USERNAME || 'user';
    return `${user}-${hostname().split('.')[0] || 'machine'}`
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-');
}
function defaultState(projectDir, github) {
    const ts = nowIso();
    return {
        schemaVersion: '1.0',
        project: basename(projectDir) || 'robotics-project',
        github,
        goals: [
            'Define the shared robotics development target.',
            'Split work by module boundaries before implementation.',
        ],
        modules: [
            {
                name: 'robot-runtime',
                paths: ['src/**'],
                responsibilities: ['Core robot mode implementation and integration points.'],
            },
        ],
        tasks: [
            {
                id: 'TASK-001',
                title: 'Create the first team-scoped development task',
                status: 'backlog',
                module: 'robot-runtime',
                paths: ['src/**'],
                updatedAt: ts,
            },
        ],
        units: [],
        decisions: [
            'GitHub repository files under team/ are the shared source of truth for team mode MVP.',
        ],
        updatedAt: ts,
    };
}
function renderBoard(state) {
    const groups = ['backlog', 'claimed', 'in_progress', 'blocked', 'review', 'done', 'paused', 'handoff', 'cancelled'];
    const lines = ['# Team Board', ''];
    for (const status of groups) {
        const tasks = state.tasks.filter(t => t.status === status);
        lines.push(`## ${status}`);
        if (tasks.length === 0) {
            lines.push('');
            continue;
        }
        for (const task of tasks) {
            const owner = task.ownerUnit ? ` | Unit: ${task.ownerUnit}` : '';
            const mod = task.module ? ` | Module: ${task.module}` : '';
            const branch = task.branch ? ` | Branch: ${task.branch}` : '';
            const issue = task.githubIssueUrl ? ` | Issue: ${task.githubIssueUrl}` : '';
            lines.push(`- [${task.status === 'done' ? 'x' : ' '}] ${task.id} ${task.title}${owner}${mod}${branch}${issue}`);
        }
        lines.push('');
    }
    return `${lines.join('\n').trimEnd()}\n`;
}
function renderGoals(state) {
    return `# Team Goals\n\n${state.goals.map(g => `- ${g}`).join('\n')}\n`;
}
function renderModules(state) {
    const lines = ['# Team Modules', ''];
    for (const mod of state.modules) {
        lines.push(`## ${mod.name}`);
        lines.push(`Owner: ${mod.ownerUnit ?? 'unclaimed'}`);
        lines.push('Paths:');
        mod.paths.forEach(p => lines.push(`- ${p}`));
        lines.push('Responsibilities:');
        mod.responsibilities.forEach(r => lines.push(`- ${r}`));
        lines.push('');
    }
    return `${lines.join('\n').trimEnd()}\n`;
}
function renderUnits(state) {
    const lines = ['# Team Units', ''];
    for (const unit of state.units) {
        lines.push(`## ${unit.id}`);
        if (unit.human)
            lines.push(`Human: ${unit.human}`);
        lines.push(`Machine: ${unit.machine}`);
        lines.push(`Status: ${unit.status}`);
        lines.push(`Current task: ${unit.currentTask ?? 'none'}`);
        lines.push(`Last seen: ${unit.lastSeen}`);
        lines.push('');
    }
    if (state.units.length === 0)
        lines.push('No units joined yet.', '');
    return `${lines.join('\n').trimEnd()}\n`;
}
function renderDecisions(state) {
    return `# Team Decisions\n\n${state.decisions.map(d => `- ${d}`).join('\n')}\n`;
}
function renderActivity(line) {
    return `- ${line}\n`;
}
async function fileText(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch {
        return null;
    }
}
export class TeamStore {
    projectDir;
    unitId;
    constructor(projectDir, unitId = defaultUnitId()) {
        this.projectDir = projectDir;
        this.unitId = unitId;
    }
    get teamDir() {
        return join(this.projectDir, TEAM_DIR);
    }
    get statePath() {
        return join(this.teamDir, STATE_FILE);
    }
    async init(github) {
        const existing = await this.read();
        if (existing)
            return existing;
        const state = defaultState(this.projectDir, github);
        await this.writeAll(state, `team initialized by ${this.unitId}`);
        return state;
    }
    async join(github, human) {
        const state = await this.ensure(github);
        const existing = state.units.find(u => u.id === this.unitId);
        const unit = {
            id: this.unitId,
            human,
            machine: hostname(),
            status: 'active',
            currentTask: existing?.currentTask,
            lastSeen: nowIso(),
        };
        const originalUpdatedAt = state.updatedAt;
        state.units = [...state.units.filter(u => u.id !== this.unitId), unit];
        if (github)
            state.github = github;
        state.updatedAt = nowIso();
        await this.writeAll(state, `${this.unitId} joined team mode`, originalUpdatedAt);
        return state;
    }
    async claim(taskId) {
        const state = await this.ensure();
        const task = state.tasks.find(t => t.id.toLowerCase() === taskId.toLowerCase());
        if (!task)
            throw new Error(`Unknown team task: ${taskId}`);
        if (task.ownerUnit && task.ownerUnit !== this.unitId) {
            throw new Error(`${task.id} is already owned by ${task.ownerUnit}`);
        }
        // Guard against accidentally regressing an advanced status when re-claiming
        const advancedStatuses = ['in_progress', 'review', 'blocked', 'handoff'];
        if (advancedStatuses.includes(task.status) && task.ownerUnit === this.unitId) {
            throw new Error(`${task.id} is already at status '${task.status}'. ` +
                `Use /team task status ${task.id} <status> to change it explicitly.`);
        }
        const warnings = this.detectPathConflicts(state, task);
        const branch = this.makeBranchName(task);
        const originalUpdatedAt = state.updatedAt;
        task.ownerUnit = this.unitId;
        task.status = 'claimed'; // reservation only; startTask() → in_progress
        task.branch = task.branch ?? branch;
        task.updatedAt = nowIso();
        const unit = this.ensureUnit(state);
        unit.status = 'active';
        unit.currentTask = task.id;
        unit.lastSeen = nowIso();
        state.updatedAt = nowIso();
        await this.writeAll(state, `${this.unitId} claimed ${task.id}`, originalUpdatedAt);
        return { state, task, warnings };
    }
    /**
     * Transition a task from `claimed` (or `backlog`) → `in_progress`.
     * Call this when the unit actually begins making changes to the codebase,
     * as opposed to `claim()` which merely reserves the task.
     */
    async startTask(taskId) {
        const state = await this.ensure();
        const id = taskId || state.units.find(u => u.id === this.unitId)?.currentTask;
        if (!id)
            throw new Error('No task specified and this unit has no current task.');
        const task = state.tasks.find(t => t.id.toLowerCase() === id.toLowerCase());
        if (!task)
            throw new Error(`Unknown team task: ${id}`);
        if (task.ownerUnit && task.ownerUnit !== this.unitId) {
            throw new Error(`${task.id} is owned by ${task.ownerUnit}`);
        }
        if (!['claimed', 'backlog', 'paused'].includes(task.status)) {
            throw new Error(`${task.id} is at status '${task.status}'; ` +
                `use /team task status ${task.id} in_progress to advance it explicitly.`);
        }
        const originalUpdatedAt = state.updatedAt;
        task.status = 'in_progress';
        task.updatedAt = nowIso();
        const unit = this.ensureUnit(state);
        unit.currentTask = task.id;
        unit.status = 'active';
        unit.lastSeen = nowIso();
        state.updatedAt = nowIso();
        await this.writeAll(state, `${this.unitId} started ${task.id}`, originalUpdatedAt);
        return { state, task };
    }
    async addTask(input) {
        const state = await this.ensure();
        const id = input.id.trim().toUpperCase();
        if (!/^TASK-[A-Z0-9._-]+$/.test(id)) {
            throw new Error('Task id must look like TASK-001');
        }
        if (state.tasks.some(t => t.id.toLowerCase() === id.toLowerCase())) {
            throw new Error(`${id} already exists`);
        }
        const task = {
            id,
            title: input.title.trim(),
            status: 'backlog',
            module: input.module?.trim() || undefined,
            paths: input.paths?.map(p => p.trim()).filter(Boolean) ?? ['TBD'],
            updatedAt: nowIso(),
        };
        if (!task.title)
            throw new Error('Task title is required');
        const originalUpdatedAt = state.updatedAt;
        state.tasks.push(task);
        state.updatedAt = nowIso();
        await this.writeAll(state, `${this.unitId} added ${task.id}`, originalUpdatedAt);
        return { state, task };
    }
    async updateTaskStatus(taskId, status) {
        if (!VALID_TASK_STATUSES.includes(status)) {
            throw new Error(`Invalid task status: ${status}`);
        }
        const state = await this.ensure();
        const task = state.tasks.find(t => t.id.toLowerCase() === taskId.toLowerCase());
        if (!task)
            throw new Error(`Unknown team task: ${taskId}`);
        const originalUpdatedAt = state.updatedAt;
        task.status = status;
        task.updatedAt = nowIso();
        if (status === 'done' || status === 'cancelled') {
            for (const unit of state.units) {
                if (unit.currentTask === task.id) {
                    unit.currentTask = undefined;
                    unit.lastSeen = nowIso();
                }
            }
        }
        state.updatedAt = nowIso();
        await this.writeAll(state, `${this.unitId} moved ${task.id} to ${status}`, originalUpdatedAt);
        return { state, task };
    }
    async checkWorkspaceConflicts() {
        const state = await this.ensure();
        const changedFiles = await this.changedWorkspaceFiles();
        return this.checkPaths(changedFiles, state);
    }
    async checkPathsConflicts(paths) {
        const state = await this.ensure();
        const files = paths.map(path => this.toRepoPath(path)).filter(Boolean).map(normalizeRepoPath);
        return this.checkPaths(files, state);
    }
    /**
     * Return the files actually changed on `task.branch` relative to the base branch.
     *
     * Uses `git diff --name-only <base>...<branch>` which includes all commits
     * reachable from branch but not from base.  Falls back to an empty list when
     * the branch doesn't exist locally, git isn't available, or the task has no
     * recorded branch.
     */
    async actualChangedFilesForTask(task) {
        if (!task.branch)
            return [];
        try {
            const baseBranch = await this.defaultBaseBranch();
            const output = await this.gitOne(['diff', '--name-only', `${baseBranch}...${task.branch}`]).catch(() => '');
            return output
                .split('\n')
                .map(l => normalizeRepoPath(l.trim()))
                .filter(Boolean);
        }
        catch {
            return [];
        }
    }
    async branchForTask(taskId) {
        const state = await this.ensure();
        const task = this.resolveTaskForUnit(state, taskId);
        if (task.ownerUnit && task.ownerUnit !== this.unitId) {
            throw new Error(`${task.id} is owned by ${task.ownerUnit}; cannot switch this unit to its branch.`);
        }
        const branch = task.branch ?? this.makeBranchName(task);
        // Guard against git option-injection: a branch name like "--delete" would be
        // interpreted as a flag by git rather than a branch name.  execFileAsync does
        // NOT go through a shell so command injection is impossible, but git itself
        // parses leading-dash arguments as options before branch names.
        if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(branch)) {
            throw new Error(`Invalid branch name: "${branch}". Must contain only [a-zA-Z0-9/_.-] and must not start with a dash.`);
        }
        const previousBranch = await this.currentGitBranch();
        const branches = await this.gitLines(['branch', '--list', branch]);
        const created = branches.length === 0;
        if (created) {
            await execFileAsync('git', ['checkout', '-b', branch], { cwd: this.projectDir, timeout: 30_000 });
        }
        else {
            await execFileAsync('git', ['checkout', branch], { cwd: this.projectDir, timeout: 30_000 });
        }
        const originalUpdatedAt = state.updatedAt;
        task.ownerUnit = this.unitId;
        // Switching to a work branch means actual work is starting:
        // backlog (picked up directly) and claimed (reserved then branched) both → in_progress.
        task.status = ['backlog', 'claimed'].includes(task.status) ? 'in_progress' : task.status;
        task.branch = branch;
        task.updatedAt = nowIso();
        const unit = this.ensureUnit(state);
        unit.currentTask = task.id;
        unit.status = 'active';
        unit.lastSeen = nowIso();
        state.updatedAt = nowIso();
        await this.writeAll(state, `${this.unitId} switched to ${task.id} branch ${branch}`, originalUpdatedAt);
        return { state, task, branch, previousBranch, created };
    }
    async pushCurrentBranch() {
        const branch = await this.currentGitBranch();
        if (!branch)
            throw new Error('No current git branch to push.');
        let output = '';
        try {
            const result = await execFileAsync('git', ['push', '-u', 'origin', branch], { cwd: this.projectDir, timeout: 120_000 });
            output = `${result.stdout}${result.stderr}`.trim();
        }
        catch (err) {
            const e = err;
            throw new Error(`git push failed: ${(e.stderr || e.stdout || e.message || String(err)).trim()}`);
        }
        const upstream = await this.gitOne(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => undefined);
        return { branch, upstream, pushed: true, output };
    }
    async createPrDraft(taskId) {
        const state = await this.ensure();
        const task = this.resolveTaskForUnit(state, taskId);
        const branch = task.branch ?? await this.currentGitBranch();
        if (!branch)
            throw new Error(`No branch recorded for ${task.id}. Run /team branch ${task.id} first.`);
        const baseBranch = await this.defaultBaseBranch();
        const changedFiles = await this.changedFilesAgainst(baseBranch, branch);
        const title = `${task.id}: ${task.title}`;
        const body = [
            `Task: ${task.id}`,
            `Unit: ${this.unitId}`,
            `Module: ${task.module ?? 'n/a'}`,
            `Branch: ${branch}`,
            `Base: ${baseBranch}`,
            '',
            '## Summary',
            '- ',
            '',
            '## Touched paths',
            ...(changedFiles.length > 0 ? changedFiles.map(file => `- ${file}`) : task.paths.map(path => `- ${path}`)),
            '',
            '## Coordination notes',
            '- ',
            '',
            '## Risk',
            '- ',
        ].join('\n');
        await mkdir(join(this.teamDir, 'tasks'), { recursive: true });
        const filePath = join(this.teamDir, 'tasks', `${task.id}-pr.md`);
        await writeFile(filePath, `# ${title}\n\n${body}\n`, 'utf8');
        return { task, branch, baseBranch, title, body, filePath };
    }
    async createHandoff(taskId, note) {
        const state = await this.ensure();
        const task = this.resolveTaskForUnit(state, taskId);
        const branch = task.branch ?? await this.currentGitBranch() ?? 'unknown';
        const changedFiles = await this.changedWorkspaceFiles();
        const diffStat = await this.gitOne(['diff', '--stat']).catch(() => '');
        const nextSteps = note?.trim() || 'TBD';
        const content = [
            `# Handoff: ${task.id} ${task.title}`,
            '',
            `Unit: ${this.unitId}`,
            `Task: ${task.id}`,
            `Status: ${task.status}`,
            `Module: ${task.module ?? 'n/a'}`,
            `Branch: ${branch}`,
            `Created: ${nowIso()}`,
            '',
            '## Current State',
            '- ',
            '',
            '## Changed Files',
            ...(changedFiles.length > 0 ? changedFiles.map(file => `- ${file}`) : ['- none']),
            '',
            '## Diff Stat',
            diffStat.trim() ? `\`\`\`\n${diffStat.trim()}\n\`\`\`` : 'none',
            '',
            '## Next Steps',
            `- ${nextSteps}`,
            '',
            '## Risks / Blockers',
            '- ',
            '',
            '## Verification',
            '- ',
        ].join('\n');
        await mkdir(join(this.teamDir, 'handoffs'), { recursive: true });
        const filePath = join(this.teamDir, 'handoffs', `${task.id}-${this.unitId}-${Date.now().toString(36)}.md`);
        await writeFile(filePath, `${content}\n`, 'utf8');
        const originalUpdatedAt = state.updatedAt;
        task.status = 'handoff';
        task.updatedAt = nowIso();
        state.updatedAt = nowIso();
        await this.writeAll(state, `${this.unitId} created handoff for ${task.id}`, originalUpdatedAt);
        return { state, task, filePath, content };
    }
    /** Returns true when team.json exists for this project. */
    async exists() {
        return (await fileText(this.statePath)) !== null;
    }
    async onboardingSummary() {
        const state = await this.ensure();
        const activeTasks = state.tasks.filter(isActiveTask);
        const activeUnits = state.units.filter(u => u.status === 'active');
        const recommendedTasks = state.tasks
            .filter(t => !t.ownerUnit && t.status === 'backlog')
            .filter(t => !activeTasks.some(active => active.paths.some(p => t.paths.some(tp => patternsOverlap(p, tp)))))
            .slice(0, 5);
        return {
            project: state.project,
            github: state.github,
            goals: state.goals.slice(0, 5),
            activeUnits,
            modules: state.modules,
            recommendedTasks,
            activeTasks,
        };
    }
    async syncGitHubIssues(taskId) {
        const state = await this.ensure();
        const repo = await this.githubRepo();
        const tasks = taskId
            ? state.tasks.filter(t => t.id.toLowerCase() === taskId.toLowerCase())
            : state.tasks;
        if (taskId && tasks.length === 0)
            throw new Error(`Unknown team task: ${taskId}`);
        const results = [];
        for (const task of tasks) {
            const body = this.githubIssueBody(task);
            const labels = ['team-mode', `status:${githubLabelValue(task.status)}`];
            if (task.module)
                labels.push(`module:${githubLabelValue(task.module)}`);
            await this.ensureGitHubLabels(repo, labels);
            const existingIssueNumber = task.githubIssueNumber ?? (task.githubIssueUrl ? parseIssueNumber(task.githubIssueUrl) : undefined);
            if (existingIssueNumber) {
                await this.gh([
                    'issue', 'edit', String(existingIssueNumber),
                    '--repo', repo,
                    '--title', `${task.id}: ${task.title}`,
                    '--body', body,
                    '--add-label', labels.join(','),
                ]);
                if (task.status === 'done' || task.status === 'cancelled') {
                    await this.gh(['issue', 'close', String(existingIssueNumber), '--repo', repo, '--comment', `Team task moved to ${task.status}.`]).catch(() => '');
                }
                else {
                    await this.gh(['issue', 'reopen', String(existingIssueNumber), '--repo', repo]).catch(() => '');
                }
                task.githubIssueNumber = existingIssueNumber;
                task.updatedAt = nowIso();
                results.push({ taskId: task.id, issueNumber: existingIssueNumber, issueUrl: task.githubIssueUrl, action: 'updated' });
            }
            else {
                const url = (await this.gh([
                    'issue', 'create',
                    '--repo', repo,
                    '--title', `${task.id}: ${task.title}`,
                    '--body', body,
                    ...labels.flatMap(label => ['--label', label]),
                ])).trim();
                const issueNumber = parseIssueNumber(url);
                task.githubIssueNumber = issueNumber;
                task.githubIssueUrl = url;
                task.updatedAt = nowIso();
                results.push({ taskId: task.id, issueNumber, issueUrl: url, action: 'created' });
            }
        }
        const originalUpdatedAt = state.updatedAt;
        state.updatedAt = nowIso();
        await this.writeAll(state, `${this.unitId} synced ${results.length} GitHub issue(s)`, originalUpdatedAt);
        return results;
    }
    async addGitHubIssuesToProject(projectNumber, owner) {
        const state = await this.ensure();
        const repo = await this.githubRepo();
        const resolvedOwner = owner?.trim() || repo.split('/')[0];
        const added = [];
        const skipped = [];
        for (const task of state.tasks) {
            if (!task.githubIssueUrl) {
                skipped.push({ taskId: task.id, reason: 'task has no githubIssueUrl; run /team github issues sync first' });
                continue;
            }
            try {
                const output = await this.gh(['project', 'item-add', projectNumber, '--owner', resolvedOwner, '--url', task.githubIssueUrl]);
                added.push({ taskId: task.id, issueUrl: task.githubIssueUrl, output: output.trim() });
            }
            catch (err) {
                skipped.push({ taskId: task.id, reason: err instanceof Error ? err.message : String(err) });
            }
        }
        return { projectNumber, owner: resolvedOwner, added, skipped };
    }
    async checkPaths(changedFiles, state) {
        const currentTaskId = state.units.find(u => u.id === this.unitId)?.currentTask;
        const currentTask = currentTaskId
            ? state.tasks.find(t => t.id === currentTaskId)
            : undefined;
        const issues = [];
        if (!currentTask && changedFiles.some(p => !p.startsWith(`${TEAM_DIR}/`))) {
            issues.push({
                severity: 'warning',
                kind: 'no_current_task',
                message: 'Workspace has non-team file changes but this unit has no current team task.',
            });
        }
        for (const file of changedFiles) {
            if (file.startsWith(`${TEAM_DIR}/`))
                continue;
            if (currentTask && !currentTask.paths.some(pattern => pathMatchesPattern(file, pattern))) {
                issues.push({
                    severity: 'warning',
                    kind: 'task_scope',
                    message: `${file} is outside current task ${currentTask.id} paths.`,
                    path: file,
                    taskId: currentTask.id,
                });
            }
            for (const mod of state.modules) {
                if (!mod.ownerUnit || mod.ownerUnit === this.unitId)
                    continue;
                if (mod.paths.some(pattern => pathMatchesPattern(file, pattern))) {
                    issues.push({
                        severity: 'error',
                        kind: 'module_owner',
                        message: `${file} belongs to module ${mod.name}, owned by ${mod.ownerUnit}.`,
                        path: file,
                        module: mod.name,
                        ownerUnit: mod.ownerUnit,
                    });
                }
            }
        }
        // Build actual-files map for other active tasks that have a branch recorded.
        // Tasks without a branch fall back to pattern-based overlap (best-effort).
        const otherActive = state.tasks.filter(t => t.id !== currentTask?.id &&
            t.ownerUnit &&
            t.ownerUnit !== this.unitId &&
            ACTIVE_TASK_STATUSES.has(t.status));
        const actualFilesMap = new Map();
        await Promise.all(otherActive
            .filter(t => !!t.branch)
            .map(async (t) => {
            const files = await this.actualChangedFilesForTask(t);
            if (files.length > 0)
                actualFilesMap.set(t.id, files);
        }));
        for (const issue of await this.detectTaskOverlapIssues(state, currentTask, changedFiles, actualFilesMap)) {
            issues.push(issue);
        }
        return { unitId: this.unitId, currentTask, changedFiles, issues };
    }
    async addModule(input) {
        const state = await this.ensure();
        const name = input.name.trim();
        if (!name)
            throw new Error('Module name is required');
        if (state.modules.some(m => m.name.toLowerCase() === name.toLowerCase())) {
            throw new Error(`Module already exists: ${name}`);
        }
        const mod = {
            name,
            ownerUnit: input.ownerUnit?.trim() || undefined,
            paths: input.paths.map(p => p.trim()).filter(Boolean),
            responsibilities: input.responsibilities?.map(r => r.trim()).filter(Boolean) ?? [],
        };
        if (mod.paths.length === 0)
            throw new Error('Module paths are required');
        if (mod.responsibilities.length === 0)
            mod.responsibilities = ['TBD'];
        const originalUpdatedAt = state.updatedAt;
        state.modules.push(mod);
        state.updatedAt = nowIso();
        await this.writeAll(state, `${this.unitId} added module ${mod.name}`, originalUpdatedAt);
        return { state, module: mod };
    }
    async setModuleOwner(name, ownerUnit) {
        const state = await this.ensure();
        const mod = state.modules.find(m => m.name.toLowerCase() === name.toLowerCase());
        if (!mod)
            throw new Error(`Unknown team module: ${name}`);
        const originalUpdatedAt = state.updatedAt;
        mod.ownerUnit = ownerUnit?.trim() || undefined;
        state.updatedAt = nowIso();
        await this.writeAll(state, `${this.unitId} set module ${mod.name} owner to ${mod.ownerUnit ?? 'unclaimed'}`, originalUpdatedAt);
        return { state, module: mod };
    }
    async status() {
        return this.read();
    }
    async sync(options = {}) {
        const fetch = options.fetch ?? true;
        const updatePresence = options.updatePresence ?? true;
        const writeActivity = options.writeActivity ?? true;
        let gitFetched = false;
        let currentBranch;
        let upstreamBranch;
        let ahead;
        let behind;
        let remoteSummary;
        let remoteTeamChanges = [];
        if (fetch) {
            try {
                await execFileAsync('git', ['fetch', '--all', '--prune'], { cwd: this.projectDir, timeout: 30_000 });
                gitFetched = true;
            }
            catch {
                gitFetched = false;
            }
        }
        try {
            const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: this.projectDir, timeout: 5_000 });
            currentBranch = stdout.trim() || undefined;
        }
        catch { /* ignore */ }
        try {
            const { stdout } = await execFileAsync('git', ['status', '-sb'], { cwd: this.projectDir, timeout: 5_000 });
            remoteSummary = stdout.trim() || undefined;
        }
        catch { /* ignore */ }
        try {
            const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: this.projectDir, timeout: 5_000 });
            upstreamBranch = stdout.trim() || undefined;
        }
        catch { /* ignore */ }
        if (upstreamBranch) {
            try {
                const { stdout } = await execFileAsync('git', ['rev-list', '--left-right', '--count', `HEAD...${upstreamBranch}`], { cwd: this.projectDir, timeout: 5_000 });
                const [aheadText, behindText] = stdout.trim().split(/\s+/);
                ahead = Number.parseInt(aheadText ?? '0', 10);
                behind = Number.parseInt(behindText ?? '0', 10);
            }
            catch { /* ignore */ }
            try {
                const { stdout } = await execFileAsync('git', ['diff', '--name-status', `HEAD..${upstreamBranch}`, '--', TEAM_DIR], { cwd: this.projectDir, timeout: 5_000 });
                remoteTeamChanges = stdout
                    .split('\n')
                    .map(line => line.trim())
                    .filter(Boolean);
            }
            catch { /* ignore */ }
        }
        const state = await this.read();
        if (state && updatePresence) {
            // ensureUnit() creates the record if this unit hasn't joined yet,
            // so presence is always recorded regardless of prior join() call.
            const originalUpdatedAt = state.updatedAt;
            const unit = this.ensureUnit(state);
            unit.status = 'active';
            unit.lastSeen = nowIso();
            state.updatedAt = nowIso();
            await this.writeAll(state, writeActivity ? `${this.unitId} synced team state` : null, originalUpdatedAt);
        }
        return {
            gitFetched,
            currentBranch,
            upstreamBranch,
            ahead,
            behind,
            remoteSummary,
            remoteTeamChanges,
            state,
        };
    }
    /**
     * Restore the `team/` directory from the upstream branch.
     *
     * ⚠️  After a successful pull the restored files are STAGED but NOT committed.
     * Always follow up with `git add team/ && git commit -m "chore: sync team state"`
     * (or the equivalent) to record the update on the current branch.
     */
    async pullRemoteTeam() {
        const before = await this.sync({ fetch: true, updatePresence: false, writeActivity: false });
        const upstreamBranch = before.upstreamBranch;
        if (!upstreamBranch) {
            return {
                applied: false,
                reason: 'Current branch has no upstream branch.',
                upstreamBranch,
                changedFiles: [],
                sync: before,
                state: before.state,
            };
        }
        const localDirty = await this.localTeamChanges();
        if (localDirty.length > 0) {
            return {
                applied: false,
                reason: 'Local team files have uncommitted changes. Commit, stash, or resolve them before /team pull.',
                upstreamBranch,
                changedFiles: localDirty,
                sync: before,
                state: before.state,
            };
        }
        if (before.remoteTeamChanges.length === 0) {
            return {
                applied: true,
                upstreamBranch,
                changedFiles: [],
                sync: before,
                state: before.state,
            };
        }
        try {
            await execFileAsync('git', ['restore', '--source', upstreamBranch, '--', TEAM_DIR], { cwd: this.projectDir, timeout: 30_000 });
        }
        catch {
            await execFileAsync('git', ['checkout', upstreamBranch, '--', TEAM_DIR], { cwd: this.projectDir, timeout: 30_000 });
        }
        const state = await this.read();
        const after = await this.sync({ fetch: false, updatePresence: false, writeActivity: false });
        return {
            applied: true,
            upstreamBranch,
            changedFiles: before.remoteTeamChanges,
            sync: after,
            state,
        };
    }
    /**
     * Detect git merge conflicts in the working tree.
     *
     * Uses `git ls-files -u` which lists each unmerged (stage 1/2/3) entry.
     * Returns a structured report with categorised conflicts and step-by-step
     * guidance text ready to display in the REPL.
     */
    async detectMergeConflicts() {
        let conflictedPaths = [];
        try {
            // -u = unmerged, -z = NUL-separated, --abbrev = short sha1
            const { stdout } = await execFileAsync('git', ['ls-files', '-u', '-z'], { cwd: this.projectDir, timeout: 5_000 });
            const entries = stdout.split('\0').map(e => e.trim()).filter(Boolean);
            const seen = new Set();
            for (const entry of entries) {
                // Format: "<mode> <sha1> <stage>\t<path>"
                const tabIdx = entry.indexOf('\t');
                const path = tabIdx >= 0 ? entry.slice(tabIdx + 1) : entry.split(/\s+/).slice(3).join(' ');
                if (path && !seen.has(path)) {
                    seen.add(path);
                    conflictedPaths.push(normalizeRepoPath(path));
                }
            }
        }
        catch {
            conflictedPaths = [];
        }
        const conflicts = conflictedPaths.map(path => ({
            path,
            isTeamFile: path.startsWith(`${TEAM_DIR}/`),
            isTeamJson: path === `${TEAM_DIR}/${STATE_FILE}`,
        }));
        const teamJsonConflicted = conflicts.some(c => c.isTeamJson);
        const hasConflicts = conflicts.length > 0;
        const guidance = [];
        if (!hasConflicts) {
            guidance.push('工作区无 git 合并冲突。');
            return { hasConflicts, conflicts, teamJsonConflicted, guidance };
        }
        guidance.push(`检测到 ${conflicts.length} 个文件存在合并冲突：`);
        for (const c of conflicts) {
            const tag = c.isTeamJson ? ' [team状态文件]' : c.isTeamFile ? ' [team文件]' : '';
            guidance.push(`  - ${c.path}${tag}`);
        }
        guidance.push('');
        if (teamJsonConflicted) {
            guidance.push('▶ team.json 冲突（推荐策略）');
            guidance.push('  team/team.json 是共享状态文件，推荐直接使用远端版本（--theirs）：');
            guidance.push(`  $ git checkout --theirs -- ${TEAM_DIR}/${STATE_FILE}`);
            guidance.push(`  $ git add ${TEAM_DIR}/${STATE_FILE}`);
            guidance.push('  或运行 /team conflicts resolve 自动执行上述步骤。');
            guidance.push('');
        }
        const otherTeamConflicts = conflicts.filter(c => c.isTeamFile && !c.isTeamJson);
        if (otherTeamConflicts.length > 0) {
            guidance.push('▶ 其他 team/ 文件冲突（通常可用远端版本）');
            for (const c of otherTeamConflicts) {
                guidance.push(`  $ git checkout --theirs -- ${c.path}`);
                guidance.push(`  $ git add ${c.path}`);
            }
            guidance.push('');
        }
        const codeConflicts = conflicts.filter(c => !c.isTeamFile);
        if (codeConflicts.length > 0) {
            guidance.push('▶ 代码文件冲突处理步骤');
            guidance.push('  1. 用编辑器打开冲突文件，查找 <<<<<<<, =======, >>>>>>>');
            guidance.push('  2. 保留需要的代码，删除所有冲突标记');
            guidance.push('  3. git add <resolved-file>');
            guidance.push('  4. 所有冲突解决后执行：git commit');
            guidance.push('');
            guidance.push('  快速选边命令：');
            guidance.push('  $ git checkout --ours   -- <file>   # 保留本地版本');
            guidance.push('  $ git checkout --theirs -- <file>   # 使用远端版本');
            guidance.push('');
        }
        guidance.push('解决全部冲突后：git add . && git commit -m "merge: resolve conflicts"');
        return { hasConflicts, conflicts, teamJsonConflicted, guidance };
    }
    /**
     * Auto-resolve a conflicted team.json by accepting the remote ("theirs") version.
     *
     * Since team/team.json is the shared source of truth, "theirs" (the remote's version)
     * is almost always the correct choice.  After applying, the file is staged so the
     * caller only needs to `git commit`.
     */
    async resolveTeamJsonConflict() {
        const report = await this.detectMergeConflicts();
        if (!report.teamJsonConflicted) {
            return {
                resolved: false,
                strategy: 'none',
                message: 'team.json 没有合并冲突，无需解决。',
            };
        }
        try {
            await execFileAsync('git', ['checkout', '--theirs', '--', `${TEAM_DIR}/${STATE_FILE}`], { cwd: this.projectDir, timeout: 10_000 });
            await execFileAsync('git', ['add', '--', `${TEAM_DIR}/${STATE_FILE}`], { cwd: this.projectDir, timeout: 5_000 });
            return {
                resolved: true,
                strategy: 'theirs',
                message: `已使用 --theirs 策略解决 team.json 冲突，文件已 staged。\n` +
                    `请确认内容后执行：git commit -m "merge: resolve team.json conflict"`,
            };
        }
        catch (err) {
            const e = err;
            return {
                resolved: false,
                strategy: 'failed',
                message: `自动解决失败: ${(e.stderr ?? e.message ?? String(err)).trim()}\n` +
                    `请手动执行：git checkout --theirs -- ${TEAM_DIR}/${STATE_FILE} && git add ${TEAM_DIR}/${STATE_FILE}`,
            };
        }
    }
    async formatPromptContext() {
        const state = await this.read();
        if (!state)
            return null;
        const active = state.tasks.filter(isActiveTask);
        const mine = active.filter(t => t.ownerUnit === this.unitId);
        const others = active.filter(t => t.ownerUnit && t.ownerUnit !== this.unitId);
        const unclaimed = active.filter(t => !t.ownerUnit).slice(0, 8);
        return [
            '## Robotics Team Mode',
            '',
            `Unit: ${this.unitId}`,
            state.github ? `GitHub: ${state.github}` : null,
            `Updated: ${state.updatedAt}`,
            '',
            '### Goals',
            ...state.goals.slice(0, 5).map(g => `- ${g}`),
            '',
            '### Current Unit Tasks',
            ...(mine.length ? mine.map(t => `- ${t.id}: ${t.title} [${t.status}] ${t.branch ? `branch=${t.branch}` : ''}${t.githubIssueUrl ? ` issue=${t.githubIssueUrl}` : ''}`) : ['- none']),
            '',
            '### Other Active Work',
            ...(others.length ? others.slice(0, 12).map(t => `- ${t.id}: ${t.title} owner=${t.ownerUnit} module=${t.module ?? 'n/a'} paths=${t.paths.join(', ')}`) : ['- none']),
            '',
            '### Available Tasks',
            ...(unclaimed.length ? unclaimed.map(t => `- ${t.id}: ${t.title} module=${t.module ?? 'n/a'} paths=${t.paths.join(', ')}`) : ['- none']),
            '',
            '### Module Boundaries',
            ...state.modules.slice(0, 12).map(m => `- ${m.name}: owner=${m.ownerUnit ?? 'unclaimed'} paths=${m.paths.join(', ')}`),
            '',
            'Team mode rules: respect task ownership and module boundaries; before editing paths owned by another unit, surface the conflict and ask for coordination. Treat team/team.json and team/*.md as the shared GitHub-backed source of truth.',
            'After the /team entry guide selects work, continue normal robot development with this team context. If the user asks naturally to finish, hand off, sync, create a PR draft, or switch work, map that intent to the corresponding team action/CLI command such as /team done, /team handoff, /team pr, /team github issues sync, or /team use TASK-ID, asking for confirmation before status-changing or remote-affecting actions.',
        ].filter((s) => s !== null).join('\n');
    }
    async ensure(github) {
        return await this.read() ?? await this.init(github);
    }
    async read() {
        const raw = await fileText(this.statePath);
        if (!raw)
            return null;
        try {
            const json = JSON.parse(raw);
            // Zod safeParse validates structural integrity (field types, required keys).
            // Returns null for corrupt files, schema-version mismatches, or partial writes.
            return parseOrNull(TeamStateSchema, json);
        }
        catch {
            return null;
        }
    }
    async localTeamChanges() {
        try {
            const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--', TEAM_DIR], { cwd: this.projectDir, timeout: 5_000 });
            return stdout
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean);
        }
        catch {
            return [];
        }
    }
    /**
     * Persist team state atomically.
     *
     * Optimistic concurrency guard (P1-B): when `checkUpdatedAt` is provided the
     * current disk state is re-read immediately before writing.  If the on-disk
     * `updatedAt` differs from the expected value another process wrote between
     * our read and our write — we reject the write so the caller can retry.
     *
     * Only pass `checkUpdatedAt` for state-mutating operations (claim, start,
     * updateStatus, …).  Creation paths (init) leave it undefined.
     */
    async writeAll(state, activity, checkUpdatedAt) {
        if (checkUpdatedAt !== undefined) {
            const diskRaw = await fileText(this.statePath);
            if (diskRaw) {
                let diskUpdatedAt;
                try {
                    diskUpdatedAt = JSON.parse(diskRaw).updatedAt;
                }
                catch { /* corrupted on disk — allow write to overwrite */ }
                if (diskUpdatedAt !== undefined && diskUpdatedAt !== checkUpdatedAt) {
                    throw new Error(`[TeamStore] Concurrent modification: team.json was updated by another process ` +
                        `(expected updatedAt="${checkUpdatedAt}", found "${diskUpdatedAt}"). ` +
                        `Re-read the team state and retry the operation.`);
                }
            }
        }
        await mkdir(join(this.teamDir, 'handoffs'), { recursive: true });
        await mkdir(join(this.teamDir, 'tasks'), { recursive: true });
        // team.json is the source of truth — write atomically and await.
        await atomicWriteJson(this.statePath, state);
        // Markdown views (board, goals, modules, units, decisions) are human-readable
        // renderings generated from team.json.  They can be safely regenerated at any
        // time, so we write them fire-and-forget — errors are swallowed to avoid
        // blocking the caller on non-critical I/O.  (P2-C)
        void Promise.all([
            writeFile(join(this.teamDir, 'board.md'), renderBoard(state), 'utf8'),
            writeFile(join(this.teamDir, 'goals.md'), renderGoals(state), 'utf8'),
            writeFile(join(this.teamDir, 'modules.md'), renderModules(state), 'utf8'),
            writeFile(join(this.teamDir, 'units.md'), renderUnits(state), 'utf8'),
            writeFile(join(this.teamDir, 'decisions.md'), renderDecisions(state), 'utf8'),
        ]).catch(() => { });
        if (activity) {
            const MAX_ACTIVITY_ENTRIES = 200;
            const activityPath = join(this.teamDir, 'activity.md');
            // Activity log is also non-critical — fire-and-forget.
            void (async () => {
                const existing = await fileText(activityPath);
                const newEntry = `- [${nowIso()}] ${activity}`;
                let content;
                if (!existing) {
                    content = `# Team Activity\n\n${newEntry}\n`;
                }
                else {
                    const entryLines = existing.split('\n').filter(l => l.startsWith('- '));
                    const trimmed = entryLines.slice(-(MAX_ACTIVITY_ENTRIES - 1));
                    content = `# Team Activity\n\n${[...trimmed, newEntry].join('\n')}\n`;
                }
                await writeFile(activityPath, content, 'utf8');
            })().catch(() => { });
        }
    }
    detectPathConflicts(state, task) {
        // Sync variant used at claim time (no git data available yet); pattern-based only.
        return this.detectTaskOverlapIssuesByPattern(state, task).map(issue => issue.message);
    }
    /**
     * Async variant with actual-git-change awareness.
     *
     * Conflict detection strategy (per other task):
     *   1. If `actualFilesMap` contains real changed files for the other task AND
     *      we also have real changed files (`ourChangedFiles`): compare file sets
     *      directly.  This is the most precise check — only real overlaps fire.
     *   2. If only the other task has real files (we don't have ours, e.g. at claim
     *      time): check if any of the other task's actual files match our task.paths
     *      patterns.  More precise than pure pattern overlap.
     *   3. Fallback: pure pattern-to-pattern overlap (existing behaviour).
     */
    async detectTaskOverlapIssues(state, task, ourChangedFiles = [], actualFilesMap = new Map()) {
        if (!task)
            return [];
        const issues = [];
        const otherActive = state.tasks.filter(t => t.id !== task.id &&
            t.ownerUnit &&
            t.ownerUnit !== this.unitId &&
            ACTIVE_TASK_STATUSES.has(t.status));
        const ourFiles = ourChangedFiles.filter(f => !f.startsWith(`${TEAM_DIR}/`));
        for (const other of otherActive) {
            const otherActual = actualFilesMap.get(other.id);
            let overlapping = false;
            let detailSuffix = '';
            if (otherActual && otherActual.length > 0 && ourFiles.length > 0) {
                // Strategy 1: actual-vs-actual — file set intersection
                const ourSet = new Set(ourFiles);
                const shared = otherActual.filter(f => ourSet.has(f));
                overlapping = shared.length > 0;
                if (overlapping) {
                    const examples = shared.slice(0, 3).join(', ');
                    detailSuffix = ` (shared files: ${examples}${shared.length > 3 ? ', …' : ''})`;
                }
            }
            else if (otherActual && otherActual.length > 0) {
                // Strategy 2: other task's actual files vs our task's patterns
                overlapping = otherActual.some(f => task.paths.some(p => pathMatchesPattern(f, p)));
                if (overlapping)
                    detailSuffix = ' (actual branch files match task scope)';
            }
            else {
                // Strategy 3: pure pattern overlap (fallback when no branch data)
                overlapping = task.paths.some(p => other.paths.some(otherPath => patternsOverlap(p, otherPath)));
            }
            if (overlapping) {
                issues.push({
                    severity: 'warning',
                    kind: 'task_overlap',
                    message: `${task.id} path scope overlaps ${other.id} owned by ${other.ownerUnit}${detailSuffix}.`,
                    taskId: other.id,
                    ownerUnit: other.ownerUnit,
                });
            }
        }
        return issues;
    }
    /** Synchronous pattern-only variant used at claim time before git data is available. */
    detectTaskOverlapIssuesByPattern(state, task) {
        if (!task)
            return [];
        const issues = [];
        const claimed = state.tasks.filter(t => t.id !== task.id &&
            t.ownerUnit &&
            t.ownerUnit !== this.unitId &&
            ACTIVE_TASK_STATUSES.has(t.status));
        for (const other of claimed) {
            const overlapping = task.paths.some(p => other.paths.some(otherPath => patternsOverlap(p, otherPath)));
            if (overlapping) {
                issues.push({
                    severity: 'warning',
                    kind: 'task_overlap',
                    message: `${task.id} path scope overlaps ${other.id} owned by ${other.ownerUnit}.`,
                    taskId: other.id,
                    ownerUnit: other.ownerUnit,
                });
            }
        }
        return issues;
    }
    async changedWorkspaceFiles() {
        try {
            const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: this.projectDir, timeout: 5_000 });
            return stdout
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .map(line => normalizeRepoPath(line.slice(2).trim().split(' -> ').pop() ?? ''))
                .filter(Boolean);
        }
        catch {
            return [];
        }
    }
    ensureUnit(state) {
        let unit = state.units.find(u => u.id === this.unitId);
        if (!unit) {
            unit = {
                id: this.unitId,
                machine: hostname(),
                status: 'active',
                lastSeen: nowIso(),
            };
            state.units.push(unit);
        }
        return unit;
    }
    resolveTaskForUnit(state, taskId) {
        const id = taskId || state.units.find(u => u.id === this.unitId)?.currentTask;
        if (!id)
            throw new Error('No task specified and this unit has no current task.');
        const task = state.tasks.find(t => t.id.toLowerCase() === id.toLowerCase());
        if (!task)
            throw new Error(`Unknown team task: ${id}`);
        return task;
    }
    makeBranchName(task) {
        const slug = task.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 48);
        // When the title is mostly non-ASCII (e.g. all CJK), the slug becomes
        // meaninglessly short. Fall back to the task ID so the branch name still
        // carries useful information.
        const suffix = slug.length >= 3 ? slug : task.id.toLowerCase();
        return `${this.unitId}/${suffix}`;
    }
    async currentGitBranch() {
        return this.gitOne(['branch', '--show-current']).catch(() => undefined);
    }
    async defaultBaseBranch() {
        const originHead = await this.gitOne(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => undefined);
        if (originHead?.startsWith('origin/'))
            return originHead.slice('origin/'.length);
        const candidates = ['main', 'master'];
        for (const candidate of candidates) {
            const exists = await execFileAsync('git', ['rev-parse', '--verify', candidate], { cwd: this.projectDir, timeout: 5_000 })
                .then(() => true)
                .catch(() => false);
            if (exists)
                return candidate;
        }
        return 'main';
    }
    async changedFilesAgainst(baseBranch, branch) {
        const output = await this.gitOne(['diff', '--name-only', `${baseBranch}...${branch}`]).catch(() => '');
        return output.split('\n').map(line => line.trim()).filter(Boolean);
    }
    async gitOne(args) {
        const { stdout } = await execFileAsync('git', args, { cwd: this.projectDir, timeout: 30_000 });
        return stdout.trim();
    }
    async gitLines(args) {
        const out = await this.gitOne(args);
        return out.split('\n').map(line => line.trim()).filter(Boolean);
    }
    githubIssueBody(task) {
        return [
            `Task: ${task.id}`,
            `Status: ${task.status}`,
            `Unit: ${task.ownerUnit ?? 'unclaimed'}`,
            `Module: ${task.module ?? 'n/a'}`,
            `Branch: ${task.branch ?? 'n/a'}`,
            '',
            '## Scope',
            ...task.paths.map(path => `- ${path}`),
            '',
            '## Coordination',
            `This issue is managed by meta-agent team mode from \`team/team.json\`.`,
        ].join('\n');
    }
    async githubRepo() {
        if (this.projectDir) {
            const repo = await this.gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).catch(() => '');
            if (repo.trim())
                return repo.trim();
        }
        const state = await this.read();
        const url = state?.github;
        const match = url?.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
        if (match)
            return match[1];
        throw new Error('Could not resolve GitHub repo. Install/authenticate gh or set team.github to a GitHub repository URL.');
    }
    async ensureGitHubLabels(repo, labels) {
        await Promise.allSettled(labels.map(label => this.gh(['label', 'create', label, '--repo', repo, '--color', '6f42c1']).catch(() => '')));
    }
    async gh(args) {
        try {
            const { stdout } = await execFileAsync('gh', args, { cwd: this.projectDir, timeout: 120_000 });
            return stdout;
        }
        catch (err) {
            const e = err;
            throw new Error((e.stderr || e.stdout || e.message || String(err)).trim());
        }
    }
    toRepoPath(path) {
        const normalized = normalizeRepoPath(path);
        if (!isAbsolute(path))
            return normalized;
        const rel = relative(this.projectDir, path).replace(/\\/g, '/');
        if (rel && !rel.startsWith('..') && rel !== '.')
            return normalizeRepoPath(rel);
        return normalized;
    }
}
//# sourceMappingURL=TeamStore.js.map