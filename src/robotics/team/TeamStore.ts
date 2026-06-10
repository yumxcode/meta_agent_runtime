/**
 * TeamStore (v2.0) — shared lab notebook persistence.
 *
 * Three entities (see types.ts): unit, task, attempt.  All mutations land in
 * `team/team.json` atomically; derived markdown views (board.md, log.md,
 * goals.md, README.md) are regenerated from team.json on every write.
 *
 * Concurrency model:
 *   - team.json is the only source of truth.
 *   - Writes use optimistic concurrency: the caller's `updatedAt` snapshot
 *     is re-checked against disk just before write; mismatch → throw and
 *     the caller retries.
 *   - attempts[] is append-only inside note() — concurrent notes from
 *     different units race on the same JSON file, but conflicts are rare
 *     and the retry is cheap.
 *
 * Exclusive ownership:
 *   - `task.ownerUnit` is the lock.  take() refuses to override an existing
 *     owner; steal() is the explicit escape hatch (records an audit attempt).
 */

import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { mkdir, readFile } from 'node:fs/promises'
import { atomicWriteFile, atomicWriteJson, withFileLock } from '../../core/persist/index.js'
import { migrateTeamState } from '../../core/persist/schemas.js'
import {
  STALE_CLAIM_MS,
  TASK_KIND_LABELS,
  VALID_TASK_KINDS,
  VALID_TASK_STATUSES,
  isActiveTask,
  isStaleClaim,
  type TeamAttempt,
  type TeamState,
  type TeamTask,
  type TeamTaskKind,
  type TeamTaskStatus,
  type TeamUnit,
} from './types.js'
import {
  renderBoard,
  renderGoals,
  renderLog,
  renderReadme,
} from './render.js'

const execFileAsync = promisify(execFile)

export {
  STALE_CLAIM_MS,
  TASK_KIND_LABELS,
  VALID_TASK_KINDS,
  VALID_TASK_STATUSES,
  isActiveTask,
  isStaleClaim,
  type TeamAttempt,
  type TeamState,
  type TeamTask,
  type TeamTaskKind,
  type TeamTaskStatus,
  type TeamUnit,
}

const TEAM_DIR = 'team'
const STATE_FILE = 'team.json'
const FETCH_COOLDOWN_MS = 10 * 60 * 1000

// ── Result types ─────────────────────────────────────────────────────────────

export interface TeamTaskAddInput {
  id: string
  title: string
  /** Optional lane tag: algo | exp | deploy. */
  kind?: TeamTaskKind
}

export interface TeamPublishState {
  /** Uncommitted changes under team/ (git status --porcelain lines). */
  dirty: string[]
  /** Local commits touching team/ that the upstream doesn't have yet. */
  unpushedCommits: number
  /** False when the project isn't a git repo (publishing not applicable). */
  isGitRepo: boolean
}

export interface TeamPushResult {
  committed: boolean
  pushed: boolean
  message: string
}

export interface TeamSyncOptions {
  fetch?: boolean
  updatePresence?: boolean
  forceFetch?: boolean
}

export interface TeamSyncSummary {
  gitFetched: boolean
  currentBranch?: string
  upstreamBranch?: string
  ahead?: number
  behind?: number
  remoteSummary?: string
  remoteTeamChanges: string[]
  state: TeamState | null
}

export interface TeamPullResult {
  applied: boolean
  reason?: string
  upstreamBranch?: string
  changedFiles: string[]
  sync: TeamSyncSummary
  state: TeamState | null
}

export interface MergeConflict {
  path: string
  isTeamFile: boolean
  isTeamJson: boolean
}

export interface MergeConflictReport {
  hasConflicts: boolean
  conflicts: MergeConflict[]
  teamJsonConflicted: boolean
  guidance: string[]
}

export interface TeamJsonResolveResult {
  resolved: boolean
  strategy: 'theirs' | 'none' | 'failed'
  message: string
}

export interface TeamNoteInput {
  taskId: string
  direction: string
  outcome: string
  ref?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Thrown when team mode would be created/used without a GitHub binding.
 * GitHub is the team SSOT: every board must be tied to exactly one repo.
 */
export class TeamGithubRequiredError extends Error {
  override name = 'TeamGithubRequiredError'
  constructor(message?: string) {
    super(
      message ??
      'Team mode 要求绑定 GitHub 仓库（团队共享状态的唯一事实源）。\n' +
      '用法: /team init <github-repo-url>（如 https://github.com/org/repo），\n' +
      '或先 git remote add origin git@github.com:org/repo.git 后重试（将自动检测）。',
    )
  }
}

/**
 * Normalize any GitHub remote form to a canonical https URL:
 *   git@github.com:org/repo.git      → https://github.com/org/repo
 *   https://github.com/org/repo.git  → https://github.com/org/repo
 *   github.com/org/repo              → https://github.com/org/repo
 * Returns null for anything that is not a github.com repo reference.
 */
export function normalizeGithubUrl(raw: string | undefined): string | null {
  if (!raw) return null
  const m = raw.trim().match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
  if (!m) return null
  return `https://github.com/${m[1]}/${m[2]}`
}

function defaultUnitId(): string {
  const user = process.env.USER || process.env.USERNAME || 'user'
  return `${user}-${hostname().split('.')[0] || 'machine'}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
}

function defaultState(projectDir: string, github?: string): TeamState {
  const ts = nowIso()
  return {
    schemaVersion: '2.0',
    project: basename(projectDir) || 'robotics-project',
    github,
    goals: [
      'Describe what this team is trying to achieve.',
      'Replace this with one to three concrete project-level goals.',
    ],
    tasks: [],
    units: [],
    updatedAt: ts,
  }
}

async function fileText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

// ── TeamStore ────────────────────────────────────────────────────────────────

export class TeamStore {
  readonly unitId: string
  private _lastFetchAt = 0

  constructor(private readonly projectDir: string, unitId = defaultUnitId()) {
    this.unitId = unitId
  }

  get teamDir(): string { return join(this.projectDir, TEAM_DIR) }
  get statePath(): string { return join(this.teamDir, STATE_FILE) }

  msSinceLastFetch(): number {
    return this._lastFetchAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this._lastFetchAt
  }

  /** Returns true when team.json exists for this project. */
  async exists(): Promise<boolean> {
    return (await fileText(this.statePath)) !== null
  }

  async status(): Promise<TeamState | null> {
    return this.read()
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Resolve the mandatory GitHub binding (team SSOT):
   * explicit URL wins (validated + normalized); otherwise auto-detect from the
   * project's `origin` remote; otherwise throw TeamGithubRequiredError.
   */
  private async _resolveGithub(explicit?: string): Promise<string> {
    if (explicit !== undefined && explicit.trim() !== '') {
      const normalized = normalizeGithubUrl(explicit)
      if (!normalized) {
        throw new TeamGithubRequiredError(
          `"${explicit}" 不是有效的 GitHub 仓库地址。` +
          `需形如 https://github.com/org/repo 或 git@github.com:org/repo.git。`,
        )
      }
      return normalized
    }
    const detected = await this.detectGithubRemote()
    if (detected) return detected
    throw new TeamGithubRequiredError()
  }

  /** Auto-detect the GitHub repo from the `origin` remote (normalized https). */
  async detectGithubRemote(): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(
        'git', ['remote', 'get-url', 'origin'],
        { cwd: this.projectDir, timeout: 5_000 },
      )
      return normalizeGithubUrl(stdout.trim()) ?? undefined
    } catch {
      return undefined
    }
  }

  async init(github?: string): Promise<TeamState> {
    const existing = await this.read()
    if (existing) {
      // Backfill legacy boards created before the GitHub-SSOT rule.
      if (!existing.github) {
        const resolved = await this._resolveGithub(github)
        const originalUpdatedAt = existing.updatedAt
        existing.github = resolved
        existing.updatedAt = nowIso()
        await this.writeAll(existing, originalUpdatedAt)
      }
      return existing
    }
    const resolved = await this._resolveGithub(github)
    const state = defaultState(this.projectDir, resolved)
    await this.writeAll(state)
    return state
  }

  async join(github?: string, human?: string): Promise<TeamState> {
    const state = await this.ensure(github)
    const existing = state.units.find(u => u.id === this.unitId)
    const unit: TeamUnit = {
      id: this.unitId,
      human,
      machine: hostname(),
      status: 'active',
      currentTask: existing?.currentTask,
      lastSeen: nowIso(),
    }
    const originalUpdatedAt = state.updatedAt
    state.units = [...state.units.filter(u => u.id !== this.unitId), unit]
    // Explicit URL on join rebinds (validated); invalid input is rejected
    // rather than silently stored.
    if (github) {
      const normalized = normalizeGithubUrl(github)
      if (!normalized) {
        throw new TeamGithubRequiredError(
          `"${github}" 不是有效的 GitHub 仓库地址，join 已中止。`,
        )
      }
      state.github = normalized
    }
    state.updatedAt = nowIso()
    await this.writeAll(state, originalUpdatedAt)
    return state
  }

  // ── Task mutations ────────────────────────────────────────────────────────

  async addTask(input: TeamTaskAddInput): Promise<{ state: TeamState; task: TeamTask }> {
    const state = await this.ensure()
    // GitHub is the team SSOT — no task may be created on an unbound board.
    // (ensure→init enforces this for new boards; this guard catches legacy
    // team.json files written before the rule, backfilling when detectable.)
    if (!state.github) {
      const detected = await this.detectGithubRemote()
      if (!detected) {
        throw new TeamGithubRequiredError(
          '当前 team 板尚未绑定 GitHub 仓库，无法创建任务。\n' +
          '运行 /team init <github-repo-url> 绑定（GitHub 是 team 协作的唯一事实源）。',
        )
      }
      state.github = detected   // persisted by the writeAll below
    }
    const id = input.id.trim().toUpperCase()
    if (!/^TASK-[A-Z0-9._-]+$/.test(id)) {
      throw new Error('Task id must look like TASK-001')
    }
    if (state.tasks.some(t => t.id.toLowerCase() === id.toLowerCase())) {
      throw new Error(`${id} already exists`)
    }
    if (!input.title.trim()) throw new Error('Task title is required')
    if (input.kind !== undefined && !VALID_TASK_KINDS.includes(input.kind)) {
      throw new Error(`Invalid task kind: ${input.kind} (valid: ${VALID_TASK_KINDS.join('|')})`)
    }
    const task: TeamTask = {
      id,
      title: input.title.trim(),
      status: 'open',
      ...(input.kind ? { kind: input.kind } : {}),
      attempts: [],
      updatedAt: nowIso(),
    }
    const originalUpdatedAt = state.updatedAt
    state.tasks.push(task)
    state.updatedAt = nowIso()
    await this.writeAll(state, originalUpdatedAt)
    return { state, task }
  }

  /**
   * Exclusively claim a task.  Fails fast if another unit already owns it.
   * Re-taking your own claim is a no-op (returns the same task).
   */
  async take(taskId: string): Promise<{ state: TeamState; task: TeamTask }> {
    const state = await this.ensure()
    const task = this.requireTask(state, taskId)
    if (task.ownerUnit && task.ownerUnit !== this.unitId) {
      throw new Error(this.formatOwnedError(task))
    }
    if (task.status === 'done') {
      throw new Error(`${task.id} 已 done，无法领取。`)
    }
    if (task.ownerUnit === this.unitId) {
      // Same-owner re-take is largely a no-op, but:
      //   - if currentTask drifted (cleared via drop elsewhere), restore it
      //   - if the task is paused, treat re-take as "resume" → open
      const unit = this.ensureUnit(state)
      const wasPaused = task.status === 'paused'
      if (unit.currentTask !== task.id || wasPaused) {
        const originalUpdatedAt = state.updatedAt
        if (wasPaused) {
          task.status = 'open'
          task.updatedAt = nowIso()
        }
        unit.currentTask = task.id
        unit.lastSeen = nowIso()
        state.updatedAt = nowIso()
        await this.writeAll(state, originalUpdatedAt)
      }
      return { state, task }
    }
    const originalUpdatedAt = state.updatedAt
    task.ownerUnit = this.unitId
    task.status = task.status === 'paused' ? 'open' : task.status
    task.claimedAt = nowIso()
    task.updatedAt = nowIso()
    const unit = this.ensureUnit(state)
    unit.currentTask = task.id
    unit.status = 'active'
    unit.lastSeen = nowIso()
    state.updatedAt = nowIso()
    await this.writeAll(state, originalUpdatedAt)
    return { state, task }
  }

  /**
   * All ACTIVE tasks this unit owns, plus the current focus (unit.currentTask
   * when it points at one of them). Multi-ownership is first-class: a unit may
   * hold several tasks; `focus` is the one it is actively pushing right now.
   */
  async ownedActiveTasks(): Promise<{ owned: TeamTask[]; focusId?: string }> {
    const state = await this.read()
    if (!state) return { owned: [] }
    const owned = state.tasks.filter(t => t.ownerUnit === this.unitId && t.status !== 'done')
    const current = state.units.find(u => u.id === this.unitId)?.currentTask
    const focusId = current && owned.some(t => t.id === current) ? current : undefined
    return { owned, focusId }
  }

  /**
   * Switch this unit's focus to a task it already owns.
   * Focus is what no-arg /team done and /team drop act on.
   */
  async focus(taskId: string): Promise<{ state: TeamState; task: TeamTask }> {
    const state = await this.ensure()
    const task = this.requireTask(state, taskId)
    if (task.ownerUnit !== this.unitId) {
      throw new Error(`${task.id} 不是你持有的任务（owner=${task.ownerUnit ?? '无'}），无法设为 focus。先 /team take。`)
    }
    if (task.status === 'done') {
      throw new Error(`${task.id} 已 done，无法设为 focus。`)
    }
    const originalUpdatedAt = state.updatedAt
    const unit = this.ensureUnit(state)
    unit.currentTask = task.id
    unit.lastSeen = nowIso()
    state.updatedAt = nowIso()
    await this.writeAll(state, originalUpdatedAt)
    return { state, task }
  }

  /**
   * Resolve "which of MY tasks did you mean" for no-arg done/drop:
   *   explicit id → as-is; else focus; else the single owned task;
   *   else throw with the owned list so the user can be explicit.
   * This replaces the old single-currentTask assumption that could silently
   * act on the wrong task once a unit holds more than one.
   */
  async requireOwnTaskId(explicit?: string): Promise<string> {
    if (explicit?.trim()) return explicit.trim()
    const { owned, focusId } = await this.ownedActiveTasks()
    if (focusId) return focusId
    if (owned.length === 1) return owned[0]!.id
    if (owned.length === 0) {
      throw new Error('你当前没有持有任何任务。先 /team take <task-id>。')
    }
    throw new Error(
      `你持有 ${owned.length} 个任务（${owned.map(t => t.id).join(', ')}）且 focus 不明确，` +
      `请显式指定任务 id，或先 /team focus <task-id>。`,
    )
  }

  /**
   * Release a task.  Only the current owner can drop.  Sets ownerUnit=null
   * and clears the recorded claimedAt.
   * No-arg resolution: focus → single owned task → error (never guesses
   * among multiple owned tasks).
   */
  async drop(taskId?: string): Promise<{ state: TeamState; task: TeamTask }> {
    const id = await this.requireOwnTaskId(taskId)
    const state = await this.ensure()
    const task = this.requireTask(state, id)
    if (task.ownerUnit && task.ownerUnit !== this.unitId) {
      throw new Error(`${task.id} 被 ${task.ownerUnit} 持有，无法 drop。需要交接请用 /team steal。`)
    }
    if (!task.ownerUnit) return { state, task }
    const originalUpdatedAt = state.updatedAt
    task.ownerUnit = undefined
    task.claimedAt = undefined
    task.updatedAt = nowIso()
    const unit = this.ensureUnit(state)
    if (unit.currentTask === task.id) {
      unit.currentTask = undefined
      unit.lastSeen = nowIso()
    }
    state.updatedAt = nowIso()
    await this.writeAll(state, originalUpdatedAt)
    return { state, task }
  }

  /**
   * Forcibly take a task already owned by someone else.  Writes an audit
   * entry to attempts[] so the prior owner can see why.
   */
  async steal(taskId: string, reason?: string): Promise<{ state: TeamState; task: TeamTask; previousOwner?: string }> {
    const state = await this.ensure()
    const task = this.requireTask(state, taskId)
    const previousOwner = task.ownerUnit
    if (!previousOwner) {
      // Equivalent to plain take().
      return { ...(await this.take(taskId)), previousOwner: undefined }
    }
    if (previousOwner === this.unitId) {
      return { state, task, previousOwner: undefined }
    }
    const originalUpdatedAt = state.updatedAt
    const claimedAgo = task.claimedAt
      ? `${Math.round((Date.now() - Date.parse(task.claimedAt)) / 86_400_000)}d ago`
      : 'unknown'
    task.attempts.push({
      at: nowIso(),
      unit: this.unitId,
      direction: `stolen from ${previousOwner}`,
      outcome: reason?.trim() || `previously claimed ${claimedAgo}; no reason given`,
    })
    task.ownerUnit = this.unitId
    task.claimedAt = nowIso()
    task.updatedAt = nowIso()
    const unit = this.ensureUnit(state)
    unit.currentTask = task.id
    unit.status = 'active'
    unit.lastSeen = nowIso()
    state.updatedAt = nowIso()
    await this.writeAll(state, originalUpdatedAt)
    return { state, task, previousOwner }
  }

  /**
   * Append a single attempt entry to a task's log.  Only the owner can
   * record attempts (forces "if you want to write here, take it first").
   */
  async note(input: TeamNoteInput): Promise<{ state: TeamState; task: TeamTask; attempt: TeamAttempt }> {
    const direction = input.direction.trim()
    const outcome = input.outcome.trim()
    if (!direction) throw new Error('note direction is required')
    if (!outcome) throw new Error('note outcome is required')
    const state = await this.ensure()
    const task = this.requireTask(state, input.taskId)
    if (!task.ownerUnit) {
      throw new Error(`${task.id} 当前无人持有；先 /team take ${task.id} 再记录。`)
    }
    if (task.ownerUnit !== this.unitId) {
      throw new Error(`${task.id} 属于 ${task.ownerUnit}，你不是 owner，无法 note。`)
    }
    const originalUpdatedAt = state.updatedAt
    const attempt: TeamAttempt = {
      at: nowIso(),
      unit: this.unitId,
      direction,
      outcome,
      ref: input.ref?.trim() || undefined,
    }
    task.attempts.push(attempt)
    task.updatedAt = nowIso()
    const unit = this.ensureUnit(state)
    unit.lastSeen = nowIso()
    state.updatedAt = nowIso()
    await this.writeAll(state, originalUpdatedAt)
    return { state, task, attempt }
  }

  /**
   * Transition a task's status (open ⇄ paused, or → done).
   * Only the owner can change status; clears ownership when marking done.
   */
  async updateTaskStatus(taskId: string, status: TeamTaskStatus): Promise<{ state: TeamState; task: TeamTask }> {
    if (!VALID_TASK_STATUSES.includes(status)) {
      throw new Error(`Invalid task status: ${status}`)
    }
    const state = await this.ensure()
    const task = this.requireTask(state, taskId)
    if (task.ownerUnit && task.ownerUnit !== this.unitId) {
      throw new Error(`${task.id} 属于 ${task.ownerUnit}，无法更改状态。`)
    }
    const originalUpdatedAt = state.updatedAt
    task.status = status
    task.updatedAt = nowIso()
    if (status === 'done') {
      // done releases the lock so the task can't visually clutter "active".
      task.ownerUnit = undefined
      task.claimedAt = undefined
      for (const unit of state.units) {
        if (unit.currentTask === task.id) {
          unit.currentTask = undefined
          unit.lastSeen = nowIso()
        }
      }
    }
    state.updatedAt = nowIso()
    await this.writeAll(state, originalUpdatedAt)
    return { state, task }
  }

  // ── Git transport (sync / pull / conflict guidance) ───────────────────────

  async sync(options: TeamSyncOptions = {}): Promise<TeamSyncSummary> {
    const fetch = options.fetch ?? true
    const updatePresence = options.updatePresence ?? true
    const force = options.forceFetch === true
    let gitFetched = false
    let currentBranch: string | undefined
    let upstreamBranch: string | undefined
    let ahead: number | undefined
    let behind: number | undefined
    let remoteSummary: string | undefined
    let remoteTeamChanges: string[] = []

    const cooldownActive = !force && this.msSinceLastFetch() < FETCH_COOLDOWN_MS
    if (fetch && !cooldownActive) {
      try {
        await execFileAsync('git', ['fetch', '--all', '--prune'], { cwd: this.projectDir, timeout: 30_000 })
        this._lastFetchAt = Date.now()
        gitFetched = true
      } catch { gitFetched = false }
    }

    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: this.projectDir, timeout: 5_000 })
      currentBranch = stdout.trim() || undefined
    } catch { /* ignore */ }

    try {
      const { stdout } = await execFileAsync('git', ['status', '-sb'], { cwd: this.projectDir, timeout: 5_000 })
      remoteSummary = stdout.trim() || undefined
    } catch { /* ignore */ }

    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: this.projectDir, timeout: 5_000 })
      upstreamBranch = stdout.trim() || undefined
    } catch { /* ignore */ }

    if (upstreamBranch) {
      try {
        const { stdout } = await execFileAsync('git', ['rev-list', '--left-right', '--count', `HEAD...${upstreamBranch}`], { cwd: this.projectDir, timeout: 5_000 })
        const [aheadText, behindText] = stdout.trim().split(/\s+/)
        ahead = Number.parseInt(aheadText ?? '0', 10)
        behind = Number.parseInt(behindText ?? '0', 10)
      } catch { /* ignore */ }

      try {
        const { stdout } = await execFileAsync('git', ['diff', '--name-status', `HEAD..${upstreamBranch}`, '--', TEAM_DIR], { cwd: this.projectDir, timeout: 5_000 })
        remoteTeamChanges = stdout.split('\n').map(l => l.trim()).filter(Boolean)
      } catch { /* ignore */ }
    }

    const state = await this.read()
    if (state && updatePresence) {
      const originalUpdatedAt = state.updatedAt
      const unit = this.ensureUnit(state)
      unit.status = 'active'
      unit.lastSeen = nowIso()
      state.updatedAt = nowIso()
      await this.writeAll(state, originalUpdatedAt)
    }

    return {
      gitFetched, currentBranch, upstreamBranch, ahead, behind,
      remoteSummary, remoteTeamChanges, state,
    }
  }

  /**
   * Publish state: what local team/ work the rest of the team can't see yet.
   * dirty = uncommitted team/ files; unpushedCommits = committed-but-unpushed
   * commits touching team/.
   */
  async publishState(): Promise<TeamPublishState> {
    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: this.projectDir, timeout: 5_000 })
    } catch {
      return { dirty: [], unpushedCommits: 0, isGitRepo: false }
    }
    const dirty = await this.localTeamChanges()
    let unpushedCommits = 0
    try {
      const { stdout } = await execFileAsync(
        'git', ['rev-list', '--count', '@{u}..HEAD', '--', TEAM_DIR],
        { cwd: this.projectDir, timeout: 5_000 },
      )
      unpushedCommits = Number.parseInt(stdout.trim(), 10) || 0
    } catch { /* no upstream — treated as nothing unpushed; push() reports it */ }
    return { dirty, unpushedCommits, isGitRepo: true }
  }

  /**
   * Publish local team/ changes: stage ONLY team/, commit, push.
   * Never touches anything outside the team directory, so it cannot swallow
   * unrelated work-in-progress code into the commit.
   */
  async push(): Promise<TeamPushResult> {
    const state = await this.publishState()
    if (!state.isGitRepo) {
      return { committed: false, pushed: false, message: '当前项目不是 git 仓库，无法发布 team 状态。' }
    }

    let committed = false
    if (state.dirty.length > 0) {
      await execFileAsync('git', ['add', '--', TEAM_DIR], { cwd: this.projectDir, timeout: 10_000 })
      try {
        await execFileAsync(
          'git', ['commit', '-m', `team(${this.unitId}): board update`, '--', TEAM_DIR],
          { cwd: this.projectDir, timeout: 15_000 },
        )
        committed = true
      } catch (err) {
        const e = err as { stderr?: string; stdout?: string; message?: string }
        const detail = (e.stderr || e.stdout || e.message || String(err)).trim()
        // "nothing to commit" can race with a concurrent commit; treat as ok.
        if (!/nothing to commit|no changes added/i.test(detail)) {
          return { committed: false, pushed: false, message: `commit 失败: ${detail}` }
        }
      }
    } else if (state.unpushedCommits === 0) {
      return { committed: false, pushed: false, message: 'team/ 没有需要发布的变更。' }
    }

    try {
      await execFileAsync('git', ['push'], { cwd: this.projectDir, timeout: 60_000 })
      return { committed, pushed: true, message: committed ? '已提交并推送 team/ 变更。' : '已推送此前提交的 team/ 变更。' }
    } catch (err) {
      const e = err as { stderr?: string; message?: string }
      const detail = (e.stderr || e.message || String(err)).trim()
      if (/no upstream|set-upstream/i.test(detail)) {
        try {
          await execFileAsync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: this.projectDir, timeout: 60_000 })
          return { committed, pushed: true, message: '已推送（并设置 upstream origin/HEAD）。' }
        } catch (err2) {
          const e2 = err2 as { stderr?: string; message?: string }
          return {
            committed, pushed: false,
            message: `已提交但推送失败: ${(e2.stderr || e2.message || String(err2)).trim()}`,
          }
        }
      }
      return { committed, pushed: false, message: `已提交但推送失败: ${detail}（队友看不到变更，请稍后重试 /team push）` }
    }
  }

  async pullRemoteTeam(): Promise<TeamPullResult> {
    const before = await this.sync({ fetch: true, forceFetch: true, updatePresence: false })
    const upstreamBranch = before.upstreamBranch
    if (!upstreamBranch) {
      return { applied: false, reason: 'Current branch has no upstream branch.', upstreamBranch, changedFiles: [], sync: before, state: before.state }
    }

    const localDirty = await this.localTeamChanges()
    if (localDirty.length > 0) {
      return {
        applied: false,
        reason: 'Local team files have uncommitted changes. Commit, stash, or resolve them before /team pull.',
        upstreamBranch, changedFiles: localDirty, sync: before, state: before.state,
      }
    }

    if (before.remoteTeamChanges.length === 0) {
      return { applied: true, upstreamBranch, changedFiles: [], sync: before, state: before.state }
    }

    try {
      await execFileAsync('git', ['restore', '--source', upstreamBranch, '--', TEAM_DIR], { cwd: this.projectDir, timeout: 30_000 })
    } catch {
      await execFileAsync('git', ['checkout', upstreamBranch, '--', TEAM_DIR], { cwd: this.projectDir, timeout: 30_000 })
    }

    const state = await this.read()
    const after = await this.sync({ fetch: false, updatePresence: false })
    return { applied: true, upstreamBranch, changedFiles: before.remoteTeamChanges, sync: after, state }
  }

  async detectMergeConflicts(): Promise<MergeConflictReport> {
    let conflictedPaths: string[] = []
    try {
      const { stdout } = await execFileAsync('git', ['ls-files', '-u', '-z'], { cwd: this.projectDir, timeout: 5_000 })
      const entries = stdout.split('\0').map(e => e.trim()).filter(Boolean)
      const seen = new Set<string>()
      for (const entry of entries) {
        const tabIdx = entry.indexOf('\t')
        const path = tabIdx >= 0 ? entry.slice(tabIdx + 1) : entry.split(/\s+/).slice(3).join(' ')
        if (path && !seen.has(path)) {
          seen.add(path)
          conflictedPaths.push(path.replace(/\\/g, '/'))
        }
      }
    } catch {
      conflictedPaths = []
    }

    const conflicts: MergeConflict[] = conflictedPaths.map(path => ({
      path,
      isTeamFile: path.startsWith(`${TEAM_DIR}/`),
      isTeamJson: path === `${TEAM_DIR}/${STATE_FILE}`,
    }))

    const teamJsonConflicted = conflicts.some(c => c.isTeamJson)
    const hasConflicts = conflicts.length > 0
    const guidance: string[] = []

    if (!hasConflicts) {
      guidance.push('工作区无 git 合并冲突。')
      return { hasConflicts, conflicts, teamJsonConflicted, guidance }
    }

    guidance.push(`检测到 ${conflicts.length} 个文件存在合并冲突：`)
    for (const c of conflicts) {
      const tag = c.isTeamJson ? ' [team状态文件]' : c.isTeamFile ? ' [team文件]' : ''
      guidance.push(`  - ${c.path}${tag}`)
    }
    guidance.push('')

    if (teamJsonConflicted) {
      guidance.push('▶ team.json 冲突（推荐策略）')
      guidance.push('  team/team.json 是共享状态文件，推荐直接使用远端版本（--theirs）：')
      guidance.push(`  $ git checkout --theirs -- ${TEAM_DIR}/${STATE_FILE}`)
      guidance.push(`  $ git add ${TEAM_DIR}/${STATE_FILE}`)
      guidance.push('  或运行 /team conflicts resolve 自动执行上述步骤。')
      guidance.push('')
    }

    const otherTeamConflicts = conflicts.filter(c => c.isTeamFile && !c.isTeamJson)
    if (otherTeamConflicts.length > 0) {
      guidance.push('▶ 其他 team/ 文件冲突（通常可用远端版本）')
      for (const c of otherTeamConflicts) {
        guidance.push(`  $ git checkout --theirs -- ${c.path}`)
        guidance.push(`  $ git add ${c.path}`)
      }
      guidance.push('')
    }

    const codeConflicts = conflicts.filter(c => !c.isTeamFile)
    if (codeConflicts.length > 0) {
      guidance.push('▶ 代码文件冲突处理步骤')
      guidance.push('  1. 用编辑器打开冲突文件，查找 <<<<<<<, =======, >>>>>>>')
      guidance.push('  2. 保留需要的代码，删除所有冲突标记')
      guidance.push('  3. git add <resolved-file>')
      guidance.push('  4. 所有冲突解决后执行：git commit')
      guidance.push('')
    }

    guidance.push('解决全部冲突后：git add . && git commit -m "merge: resolve conflicts"')
    return { hasConflicts, conflicts, teamJsonConflicted, guidance }
  }

  async resolveTeamJsonConflict(): Promise<TeamJsonResolveResult> {
    const report = await this.detectMergeConflicts()
    if (!report.teamJsonConflicted) {
      return { resolved: false, strategy: 'none', message: 'team.json 没有合并冲突，无需解决。' }
    }
    try {
      await execFileAsync('git', ['checkout', '--theirs', '--', `${TEAM_DIR}/${STATE_FILE}`], { cwd: this.projectDir, timeout: 10_000 })
      await execFileAsync('git', ['add', '--', `${TEAM_DIR}/${STATE_FILE}`], { cwd: this.projectDir, timeout: 5_000 })
      return {
        resolved: true,
        strategy: 'theirs',
        message:
          `已使用 --theirs 策略解决 team.json 冲突，文件已 staged。\n` +
          `请确认内容后执行：git commit -m "merge: resolve team.json conflict"`,
      }
    } catch (err) {
      const e = err as { stderr?: string; message?: string }
      return {
        resolved: false,
        strategy: 'failed',
        message:
          `自动解决失败: ${(e.stderr ?? e.message ?? String(err)).trim()}\n` +
          `请手动执行：git checkout --theirs -- ${TEAM_DIR}/${STATE_FILE} && git add ${TEAM_DIR}/${STATE_FILE}`,
      }
    }
  }

  // ── Prompt context for the AI ─────────────────────────────────────────────

  async formatPromptContext(): Promise<string | null> {
    const state = await this.read()
    if (!state) return null
    const kindTag = (t: TeamTask): string => (t.kind ? `[${TASK_KIND_LABELS[t.kind]}] ` : '')
    const active = state.tasks.filter(isActiveTask)
    const mine = active.filter(t => t.ownerUnit === this.unitId)
    const focusCandidate = state.units.find(u => u.id === this.unitId)?.currentTask
    const focusId = focusCandidate && mine.some(t => t.id === focusCandidate) ? focusCandidate : undefined
    const others = active.filter(t => t.ownerUnit && t.ownerUnit !== this.unitId)
    const open = state.tasks.filter(t => !t.ownerUnit && t.status !== 'done').slice(0, 8)
    const recentAttempts: Array<{ task: TeamTask; attempt: TeamAttempt }> = []
    for (const t of state.tasks) {
      for (const a of t.attempts.slice(-3)) recentAttempts.push({ task: t, attempt: a })
    }
    recentAttempts.sort((a, b) => Date.parse(b.attempt.at) - Date.parse(a.attempt.at))

    return [
      '## Robotics Team Mode (collaboration log)',
      '',
      `Unit: ${this.unitId}`,
      state.github ? `GitHub: ${state.github}` : null,
      `Updated: ${state.updatedAt}`,
      '',
      '### Goals',
      ...state.goals.slice(0, 5).map(g => `- ${g}`),
      '',
      '### Your tasks' + (mine.length > 1 ? ` (${mine.length} owned${focusId ? `, focus=${focusId}` : ', no focus set'})` : ''),
      ...(mine.length
        ? mine.map(t => `- ${t.id === focusId ? '★ ' : ''}${t.id}: ${kindTag(t)}${t.title} [${t.status}] attempts=${t.attempts.length}`)
        : ['- none']),
      '',
      '### Others working',
      ...(others.length
        ? others.slice(0, 12).map(t => `- ${t.id}: ${kindTag(t)}${t.title} owner=${t.ownerUnit} attempts=${t.attempts.length}${isStaleClaim(t) ? ' (claim stale)' : ''}`)
        : ['- none']),
      '',
      '### Open tasks (unclaimed)',
      ...(open.length
        ? open.map(t => `- ${t.id}: ${kindTag(t)}${t.title}`)
        : ['- none']),
      '',
      '### Recent attempts (latest 8 across team)',
      ...(recentAttempts.length
        ? recentAttempts.slice(0, 8).map(e => `- [${e.attempt.at}] ${e.task.id} ${e.attempt.unit}: ${e.attempt.direction} → ${e.attempt.outcome}${e.attempt.ref ? ` (${e.attempt.ref})` : ''}`)
        : ['- none']),
      '',
      'Team mode rules: tasks are exclusively owned once taken; only the owner can note/drop/done. ' +
      'When the user describes work, surface useful collaboration cues — what others tried, what failed, who has the lock. ' +
      'A unit may own MULTIPLE tasks; the ★focus marks the one being actively pushed (switch with /team focus <id>). ' +
      'When this unit owns more than one task, ALWAYS name the explicit taskId in team_note / team_mark_done — never rely on implicit "current task". ' +
      'You MAY record attempts on tasks THIS unit owns via the team_note tool — do so proactively after a meaningful ' +
      'experiment/debug round concludes (direction + outcome + ref like a wandb/git/rosbag link). ' +
      'team_take / team_mark_done are available but prompt the user for confirmation — propose them when appropriate. ' +
      'NEVER steal a task yourself; suggest /team steal and let the user decide. ' +
      'Local team changes are only visible to teammates after /team push — remind the user when changes are unpublished.',
    ].filter((s): s is string => s !== null).join('\n')
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private formatOwnedError(task: TeamTask): string {
    const ago = task.claimedAt
      ? `${Math.round((Date.now() - Date.parse(task.claimedAt)) / 3_600_000)}h 前`
      : '时间未知'
    return (
      `${task.id} 已被 ${task.ownerUnit} 领取（${ago}）。` +
      ` 如需接手用 /team steal ${task.id} [reason]。`
    )
  }

  private requireTask(state: TeamState, taskId: string): TeamTask {
    const task = state.tasks.find(t => t.id.toLowerCase() === taskId.toLowerCase())
    if (!task) throw new Error(`Unknown team task: ${taskId}`)
    return task
  }

  private async ensure(github?: string): Promise<TeamState> {
    return await this.read() ?? await this.init(github)
  }

  private async read(): Promise<TeamState | null> {
    const raw = await fileText(this.statePath)
    if (!raw) return null
    try {
      const json = JSON.parse(raw) as unknown
      return migrateTeamState(json) as TeamState | null
    } catch {
      return null
    }
  }

  private async localTeamChanges(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--', TEAM_DIR], { cwd: this.projectDir, timeout: 5_000 })
      return stdout.split('\n').map(l => l.trim()).filter(Boolean)
    } catch { return [] }
  }

  private ensureUnit(state: TeamState): TeamUnit {
    let unit = state.units.find(u => u.id === this.unitId)
    if (!unit) {
      unit = {
        id: this.unitId,
        machine: hostname(),
        status: 'active',
        lastSeen: nowIso(),
      }
      state.units.push(unit)
    }
    return unit
  }

  /**
   * Atomically write team.json with an optional optimistic-concurrency check,
   * then regenerate the derived markdown views.
   */
  private async writeAll(state: TeamState, checkUpdatedAt?: string): Promise<void> {
    await mkdir(this.teamDir, { recursive: true })
    // M2: hold a cross-process lock around the read-check → write so two
    // processes sharing team.json can't both pass the optimistic check and
    // clobber each other (lost update). The optimistic check stays as the
    // correctness mechanism; the lock just makes check-then-rename atomic.
    await withFileLock(this.statePath, async () => {
      if (checkUpdatedAt !== undefined) {
        const diskRaw = await fileText(this.statePath)
        if (diskRaw) {
          let diskUpdatedAt: string | undefined
          try {
            diskUpdatedAt = (JSON.parse(diskRaw) as { updatedAt?: string }).updatedAt
          } catch { /* corrupt → allow */ }
          if (diskUpdatedAt !== undefined && diskUpdatedAt !== checkUpdatedAt) {
            throw new Error(
              `[TeamStore] Concurrent modification: team.json was updated by another process ` +
              `(expected updatedAt="${checkUpdatedAt}", found "${diskUpdatedAt}"). ` +
              `Re-read the team state and retry the operation.`,
            )
          }
        }
      }
      await atomicWriteJson(this.statePath, state)
    })
    // Derived views are best-effort, but the writes must drain before callers
    // treat the mutation as complete; otherwise tests and cleanup can race with
    // background writes that recreate files inside the team directory.
    await Promise.allSettled([
      atomicWriteFile(join(this.teamDir, 'board.md'), renderBoard(state)),
      atomicWriteFile(join(this.teamDir, 'log.md'),   renderLog(state)),
      atomicWriteFile(join(this.teamDir, 'goals.md'), renderGoals(state)),
      atomicWriteFile(join(this.teamDir, 'README.md'), renderReadme()),
    ])
  }
}
