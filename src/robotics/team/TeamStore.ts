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
import { atomicWriteFile, atomicWriteJson } from '../../core/persist/index.js'
import { migrateTeamState } from '../../core/persist/schemas.js'
import {
  STALE_CLAIM_MS,
  VALID_TASK_STATUSES,
  isActiveTask,
  isStaleClaim,
  type TeamAttempt,
  type TeamState,
  type TeamTask,
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
  VALID_TASK_STATUSES,
  isActiveTask,
  isStaleClaim,
  type TeamAttempt,
  type TeamState,
  type TeamTask,
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

  async init(github?: string): Promise<TeamState> {
    const existing = await this.read()
    if (existing) return existing
    const state = defaultState(this.projectDir, github)
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
    if (github) state.github = github
    state.updatedAt = nowIso()
    await this.writeAll(state, originalUpdatedAt)
    return state
  }

  // ── Task mutations ────────────────────────────────────────────────────────

  async addTask(input: TeamTaskAddInput): Promise<{ state: TeamState; task: TeamTask }> {
    const state = await this.ensure()
    const id = input.id.trim().toUpperCase()
    if (!/^TASK-[A-Z0-9._-]+$/.test(id)) {
      throw new Error('Task id must look like TASK-001')
    }
    if (state.tasks.some(t => t.id.toLowerCase() === id.toLowerCase())) {
      throw new Error(`${id} already exists`)
    }
    if (!input.title.trim()) throw new Error('Task title is required')
    const task: TeamTask = {
      id,
      title: input.title.trim(),
      status: 'open',
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
   * Release a task.  Only the current owner can drop.  Sets ownerUnit=null
   * and clears the recorded claimedAt.
   */
  async drop(taskId?: string): Promise<{ state: TeamState; task: TeamTask }> {
    const state = await this.ensure()
    const id = taskId || state.units.find(u => u.id === this.unitId)?.currentTask
    if (!id) throw new Error('No task specified and this unit has no current task.')
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
    const active = state.tasks.filter(isActiveTask)
    const mine = active.filter(t => t.ownerUnit === this.unitId)
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
      '### Your tasks',
      ...(mine.length
        ? mine.map(t => `- ${t.id}: ${t.title} [${t.status}] attempts=${t.attempts.length}`)
        : ['- none']),
      '',
      '### Others working',
      ...(others.length
        ? others.slice(0, 12).map(t => `- ${t.id}: ${t.title} owner=${t.ownerUnit} attempts=${t.attempts.length}${isStaleClaim(t) ? ' (claim stale)' : ''}`)
        : ['- none']),
      '',
      '### Open tasks (unclaimed)',
      ...(open.length
        ? open.map(t => `- ${t.id}: ${t.title}`)
        : ['- none']),
      '',
      '### Recent attempts (latest 8 across team)',
      ...(recentAttempts.length
        ? recentAttempts.slice(0, 8).map(e => `- [${e.attempt.at}] ${e.task.id} ${e.attempt.unit}: ${e.attempt.direction} → ${e.attempt.outcome}${e.attempt.ref ? ` (${e.attempt.ref})` : ''}`)
        : ['- none']),
      '',
      'Team mode rules: tasks are exclusively owned once taken; only the owner can note/drop/done. ' +
      'When the user describes work, surface useful collaboration cues — what others tried, what failed, who has the lock. ' +
      'Do NOT mutate team state without explicit instruction; surface intent and let the user run /team take, /team note, /team drop, /team done, /team steal.',
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
    await mkdir(this.teamDir, { recursive: true })
    await atomicWriteJson(this.statePath, state)
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
