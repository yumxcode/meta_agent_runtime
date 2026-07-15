/**
 * Durable lifecycle coordinator for auto-mode isolated-write sub-agents.
 *
 * Every isolated writer gets a task branch + worktree. Its mapping and phase
 * live under `.git/meta-agent/auto-worktrees.json`, outside the working tree,
 * so main-tree stash/merge transactions cannot hide or modify the registry.
 */
import { execFile, execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'fs'
import { dirname, join, resolve } from 'path'
import { promisify } from 'util'
import { GitWorkspaceManager } from '../../infra/git/GitWorkspaceManager.js'
import { atomicWriteJson } from '../../infra/persist/index.js'
import type { SubAgentTaskId } from '../../subagent/types.js'

const execFileAsync = promisify(execFile)
const REGISTRY_SCHEMA_VERSION = '1.0'
const GIT_TIMEOUT_MS = 60_000
const MAX_REGISTRY_TASKS = 500
const MAX_REGISTRY_STRING_CHARS = 4_000

export type AutoWorktreePhase =
  | 'allocated'
  | 'running'
  | 'finalizing'
  | 'awaiting_merge'
  | 'merging'
  | 'conflicted'
  | 'failed'
  | 'merged'

export interface AutoWorktreeRecord {
  taskId: string
  sessionId: string
  branchName: string
  worktreePath: string
  forkPoint: string
  phase: AutoWorktreePhase
  finalizedCommit?: string
  preMergeHead?: string
  stashCommit?: string
  error?: string
  createdAt: number
  updatedAt: number
}

interface AutoWorktreeRegistry {
  schemaVersion: string
  tasks: Record<string, AutoWorktreeRecord>
}

export interface AutoWorktreeHandle {
  taskId: string
  worktreePath: string
  branchName: string
}

export interface AutoFinalizeResult {
  status: 'committed' | 'already_committed' | 'no_changes'
  commitHash?: string
  changedFiles: string[]
}

export interface AutoMergeResult {
  merged: boolean
  commitHash: string
}

export interface AutoWorktreeReconcileResult {
  restored: string[]
  recoveredTransactions: string[]
  stale: string[]
  orphansRemoved: string[]
}

export type AutoWorktreeCleanupStrategy = 'preserve' | 'safe' | 'aggressive'

export interface AutoWorktreeCleanupResult {
  strategy: AutoWorktreeCleanupStrategy
  reconciled?: AutoWorktreeReconcileResult
  removed: string[]
  preserved: Array<{ taskId: string; phase: AutoWorktreePhase; reason: string }>
  errors: Array<{ taskId: string; error: string }>
}

export interface AutoWorktreeCoordinatorOptions {
  /**
   * Override where task worktrees are created. auto_orch run-scoped
   * coordinators use a per-run base so their orphan sweep (reconcile) can never
   * touch another coordinator's worktrees.
   */
  worktreeBase?: string
  /**
   * Override the registry file. Run-scoped coordinators MUST set this: the
   * default path is shared per git-common-dir, and two live coordinator
   * instances persisting the same file would stomp each other's records.
   */
  registryPath?: string
}

export class AutoWorktreeCoordinator {
  private readonly gwm: GitWorkspaceManager
  private readonly projectDir: string
  private readonly worktreeBase: string
  private readonly registryPath: string
  private readonly records = new Map<string, AutoWorktreeRecord>()
  private operationChain: Promise<void> = Promise.resolve()

  constructor(projectDir: string, opts?: AutoWorktreeCoordinatorOptions) {
    this.projectDir = resolve(projectDir)
    this.worktreeBase = opts?.worktreeBase ?? join(this.projectDir, '.meta-agent', 'auto', 'worktrees')
    let gitCommonDir = join(this.projectDir, '.git')
    try {
      const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: this.projectDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_TIMEOUT_MS,
      }).trim()
      gitCommonDir = resolve(this.projectDir, raw)
    } catch { /* non-git workspace; enabled remains false */ }
    this.registryPath = opts?.registryPath ?? join(gitCommonDir, 'meta-agent', 'auto-worktrees.json')
    this.gwm = new GitWorkspaceManager(this.projectDir, this.worktreeBase)
    this._loadRegistry()
  }

  get enabled(): boolean {
    return this.gwm.enabled
  }

  activeTasks(): string[] {
    return [...this.records.keys()]
  }

  branchFor(taskId: string): string | undefined {
    return this.records.get(taskId)?.branchName
  }

  recordFor(taskId: string): AutoWorktreeRecord | undefined {
    const record = this.records.get(taskId)
    return record ? { ...record } : undefined
  }

  async allocate(
    taskId: SubAgentTaskId,
    sessionId = 'unknown',
  ): Promise<AutoWorktreeHandle | null> {
    return this._exclusive(async () => {
      if (!this.enabled) return null
      const existing = this.records.get(taskId)
      if (existing) {
        return {
          taskId,
          worktreePath: existing.worktreePath,
          branchName: existing.branchName,
        }
      }
      if (this.records.size >= MAX_REGISTRY_TASKS) {
        throw new Error(
          `Auto worktree registry limit reached (${MAX_REGISTRY_TASKS}); ` +
          'merge or discard existing tasks before allocating more.',
        )
      }
      const rec = await this.gwm.createWorktreeForTask(taskId, 'code')
      const record: AutoWorktreeRecord = {
        taskId,
        sessionId,
        branchName: rec.branchName,
        worktreePath: rec.worktreePath,
        forkPoint: rec.forkPoint,
        phase: 'allocated',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      this.records.set(taskId, record)
      try {
        await this._requireRegistryPersist()
      } catch {
        this.records.delete(taskId)
        await this.gwm.removeWorktree(taskId, {
          deleteBranch: true,
          branchName: rec.branchName,
        })
        throw new Error(`Could not persist worktree registry for ${taskId}`)
      }
      return { taskId, worktreePath: rec.worktreePath, branchName: rec.branchName }
    })
  }

  async markRunning(taskId: SubAgentTaskId): Promise<void> {
    await this._exclusive(async () => {
      const record = this.records.get(taskId)
      if (!record) return
      await this._updateRecord(record, { phase: 'running', error: undefined })
    })
  }

  async markFailed(taskId: SubAgentTaskId, error: string): Promise<void> {
    await this._exclusive(async () => {
      const record = this.records.get(taskId)
      if (!record) return
      await this._updateRecord(record, { phase: 'failed', error })
    })
  }

  async finalize(taskId: SubAgentTaskId): Promise<AutoFinalizeResult> {
    return this._exclusive(() => this._finalizeUnlocked(taskId))
  }

  private async _finalizeUnlocked(taskId: SubAgentTaskId): Promise<AutoFinalizeResult> {
    const record = this.records.get(taskId)
    if (!record) throw new Error(`No worktree found for task "${taskId}"`)
    if (!existsSync(record.worktreePath)) {
      throw new Error(`Worktree path is missing for task "${taskId}"`)
    }
    if (record.phase === 'awaiting_merge' || record.phase === 'merged') {
      if (record.finalizedCommit) {
        return { status: 'already_committed', commitHash: record.finalizedCommit, changedFiles: [] }
      }
      return { status: 'no_changes', changedFiles: [] }
    }

    await this._updateRecord(record, { phase: 'finalizing', error: undefined })
    try {
      await this._assertNoGitOperation(record.worktreePath)
      const sourcePaths = ['--', '.', ':(exclude).meta-agent/**', ':(exclude).loop/**']
      const status = await this._gitIn(
        record.worktreePath,
        ['status', '--porcelain', ...sourcePaths],
      )
      const changedFiles = status
        .split('\n')
        .filter(Boolean)
        .map(line => line.slice(3).trim())

      if (changedFiles.length > 0) {
        await this._gitIn(record.worktreePath, ['add', '-A', ...sourcePaths])
        const hasStaged = await this._gitExitZero(
          record.worktreePath,
          ['diff', '--cached', '--quiet', '--exit-code'],
        ).then(clean => !clean)
        if (hasStaged) {
          await this._gitIn(record.worktreePath, [
            'commit',
            '-m',
            `meta-agent: finalize sub-agent ${taskId}`,
          ])
          const commitHash = await this._gitIn(record.worktreePath, ['rev-parse', 'HEAD'])
          await this._updateRecord(record, {
            phase: 'awaiting_merge',
            finalizedCommit: commitHash,
            error: undefined,
          })
          return { status: 'committed', commitHash, changedFiles }
        }
      }

      const commitCount = Number(await this._gitIn(
        record.worktreePath,
        ['rev-list', '--count', `${record.forkPoint}..HEAD`],
      ))
      if (commitCount > 0) {
        const commitHash = await this._gitIn(record.worktreePath, ['rev-parse', 'HEAD'])
        await this._updateRecord(record, {
          phase: 'awaiting_merge',
          finalizedCommit: commitHash,
          error: undefined,
        })
        return { status: 'already_committed', commitHash, changedFiles: [] }
      }

      await this._updateRecord(record, {
        phase: 'awaiting_merge',
        finalizedCommit: undefined,
        error: undefined,
      })
      return { status: 'no_changes', changedFiles: [] }
    } catch (err) {
      await this._updateRecord(record, {
        phase: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  async merge(
    taskId: SubAgentTaskId,
    opts?: { strategy?: 'squash' | 'merge'; message?: string },
  ): Promise<AutoMergeResult | null> {
    return this._exclusive(async () => {
      const record = this.records.get(taskId)
      if (!record) return null
      await this._finalizeUnlocked(taskId)
      return this._mergeTransaction(record, opts)
    })
  }

  private async _mergeTransaction(
    record: AutoWorktreeRecord,
    opts?: { strategy?: 'squash' | 'merge'; message?: string },
  ): Promise<AutoMergeResult> {
    const preMergeHead = await this._git(['rev-parse', 'HEAD'])
    await this._updateRecord(record, {
      phase: 'merging',
      preMergeHead,
      stashCommit: undefined,
      error: undefined,
    })

    let stashCommit: string | undefined
    try {
      const transactionPaths = ['--', '.', ':(exclude).meta-agent/**', ':(exclude).loop/**']
      const dirty = (
        await this._git(['status', '--porcelain', ...transactionPaths])
      ).length > 0
      if (dirty) {
        await this._git([
          'stash',
          'push',
          '--include-untracked',
          '-m',
          `meta-agent merge transaction ${record.taskId}`,
          ...transactionPaths,
        ])
        stashCommit = await this._git(['rev-parse', 'refs/stash'])
        await this._updateRecord(record, { stashCommit })
      }

      const strategy = opts?.strategy ?? 'squash'
      const message = opts?.message ?? `feat: sub-agent ${record.branchName} results`
      if (strategy === 'merge') {
        await this._git(['merge', '--no-ff', '-m', message, record.branchName])
      } else {
        await this._git(['merge', '--squash', record.branchName])
        const staged = !await this._gitExitZero(
          this.projectDir,
          ['diff', '--cached', '--quiet', '--exit-code'],
        )
        if (staged) await this._git(['commit', '-m', message])
      }

      const commitHash = await this._git(['rev-parse', 'HEAD'])
      if (stashCommit) {
        await this._git(['stash', 'apply', '--index', stashCommit])
      }

      await this._updateRecord(record, {
        phase: 'merged',
        preMergeHead: undefined,
        stashCommit,
        error: undefined,
      })
      if (stashCommit) {
        const dropped = await this._dropStashByCommit(stashCommit)
          .then(() => true, () => false)
        if (dropped) await this._updateRecord(record, { stashCommit: undefined })
      }
      if (await this._removeWorktreeAndBranch(record)) {
        this.records.delete(record.taskId)
        await this._requireRegistryPersist()
      }
      return { merged: true, commitHash }
    } catch (err) {
      const originalError = err instanceof Error ? err.message : String(err)
      const rollbackError = await this._rollbackMainTransaction(preMergeHead, stashCommit)
      await this._updateRecord(record, {
        phase: 'conflicted',
        preMergeHead: undefined,
        stashCommit,
        error: rollbackError
          ? `${originalError}; rollback failed: ${rollbackError}`
          : originalError,
      })
      if (!rollbackError && stashCommit) {
        const dropped = await this._dropStashByCommit(stashCommit)
          .then(() => true, () => false)
        if (dropped) await this._updateRecord(record, { stashCommit: undefined })
      }
      throw new Error(
        rollbackError
          ? `Merge failed and rollback was incomplete: ${originalError}; ${rollbackError}`
          : `Merge failed and was rolled back: ${originalError}`,
      )
    }
  }

  async diff(taskId: SubAgentTaskId): Promise<string> {
    return this._exclusive(async () => {
      const record = this.records.get(taskId)
      if (!record) return `No worktree for task ${taskId}`
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['-C', record.worktreePath, 'diff', '--stat', record.forkPoint],
          { maxBuffer: 10 * 1024 * 1024, timeout: GIT_TIMEOUT_MS },
        )
        const untracked = await this._gitIn(
          record.worktreePath,
          ['ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude).meta-agent/**', ':(exclude).loop/**'],
        )
        return [stdout.trim(), untracked ? `Untracked:\n${untracked}` : '']
          .filter(Boolean)
          .join('\n') || '(no changes)'
      } catch (err) {
        return `Could not compute diff: ${err instanceof Error ? err.message : String(err)}`
      }
    })
  }

  async discard(taskId: SubAgentTaskId): Promise<void> {
    await this._exclusive(async () => {
      const record = this.records.get(taskId)
      if (!record) return
      if (!await this._removeWorktreeAndBranch(record)) {
        await this._updateRecord(record, {
          phase: 'failed',
          error: 'Could not remove worktree or branch',
        })
        throw new Error(`Could not fully discard worktree for ${taskId}`)
      }
      this.records.delete(taskId)
      await this._requireRegistryPersist()
    })
  }

  /**
   * Explicit destructive cleanup retained for callers/tests that truly want to
   * discard every task. Session disposal must not call this: durable worktrees
   * are intentionally preserved for resume.
   */
  async cleanupAll(): Promise<void> {
    const ids = this.activeTasks()
    for (const id of ids) await this.discard(id).catch(() => undefined)
  }

  async cleanup(strategy: AutoWorktreeCleanupStrategy = 'safe'): Promise<AutoWorktreeCleanupResult> {
    if (strategy === 'preserve') {
      const reconciled = await this.reconcile()
      return this._exclusive(async () => ({
        strategy,
        reconciled,
        removed: [],
        preserved: [...this.records.values()].map(record => ({
          taskId: record.taskId,
          phase: record.phase,
          reason: 'preserve strategy',
        })),
        errors: [],
      }))
    }

    const reconciled = strategy === 'safe' ? await this.reconcile() : undefined
    return this._exclusive(async () => {
      const result: AutoWorktreeCleanupResult = {
        strategy,
        reconciled,
        removed: [],
        preserved: [],
        errors: [],
      }

      for (const record of [...this.records.values()]) {
        if (strategy === 'safe') {
          const decision = await this._safeCleanupDecision(record)
          if (!decision.remove) {
            result.preserved.push({
              taskId: record.taskId,
              phase: record.phase,
              reason: decision.reason,
            })
            continue
          }
        }

        if (await this._removeWorktreeAndBranch(record)) {
          this.records.delete(record.taskId)
          result.removed.push(record.taskId)
        } else {
          result.errors.push({
            taskId: record.taskId,
            error: 'Could not remove worktree or branch',
          })
          await this._updateRecord(record, {
            phase: 'failed',
            error: 'Could not remove worktree or branch during cleanup',
          })
        }
      }

      await this._requireRegistryPersist()
      return result
    })
  }

  async reconcile(): Promise<AutoWorktreeReconcileResult> {
    return this._exclusive(async () => {
      const result: AutoWorktreeReconcileResult = {
        restored: [],
        recoveredTransactions: [],
        stale: [],
        orphansRemoved: [],
      }
      if (!this.enabled) return result

      for (const record of [...this.records.values()]) {
        if (record.phase === 'merging' && record.preMergeHead) {
          const rollbackError = await this._rollbackMainTransaction(
            record.preMergeHead,
            record.stashCommit,
          )
          await this._updateRecord(record, {
            phase: rollbackError ? 'failed' : 'conflicted',
            preMergeHead: undefined,
            stashCommit: record.stashCommit,
            error: rollbackError
              ? `Crash recovery rollback failed: ${rollbackError}`
              : 'Recovered an interrupted merge transaction',
          })
          if (!rollbackError) {
            result.recoveredTransactions.push(record.taskId)
            if (record.stashCommit) {
              const dropped = await this._dropStashByCommit(record.stashCommit)
                .then(() => true, () => false)
              if (dropped) await this._updateRecord(record, { stashCommit: undefined })
            }
          }
        }

        if (!await this._branchExists(record.branchName)) {
          result.stale.push(record.taskId)
          this.records.delete(record.taskId)
          continue
        }
        if (!existsSync(record.worktreePath)) {
          try {
            mkdirSync(dirname(record.worktreePath), { recursive: true })
            await this._git(['worktree', 'add', record.worktreePath, record.branchName])
            result.restored.push(record.taskId)
          } catch {
            result.stale.push(record.taskId)
            await this._updateRecord(record, {
              phase: 'failed',
              error: 'Branch exists but worktree could not be restored',
            })
          }
        }
        if (record.phase === 'finalizing') {
          await this._finalizeUnlocked(record.taskId).catch(() => undefined)
        }
        if (record.phase === 'merged') {
          if (record.stashCommit) {
            await this._dropStashByCommit(record.stashCommit).catch(() => undefined)
            await this._updateRecord(record, { stashCommit: undefined })
          }
          if (await this._removeWorktreeAndBranch(record)) {
            this.records.delete(record.taskId)
          }
        }
      }

      if (existsSync(this.worktreeBase)) {
        for (const entry of readdirSync(this.worktreeBase)) {
          if (this.records.has(entry)) continue
          const path = join(this.worktreeBase, entry)
          await this._git(['worktree', 'remove', '--force', path]).catch(() => {
            try { rmSync(path, { recursive: true, force: true }) } catch { /* best-effort */ }
          })
          const orphanBranch = `sub/${entry}/code`
          await this._git(['branch', '-D', orphanBranch]).catch(() => undefined)
          result.orphansRemoved.push(entry)
        }
      }
      await this._git(['worktree', 'prune']).catch(() => undefined)
      await this._requireRegistryPersist()
      return result
    })
  }

  /** Backward-compatible name; now performs durable reconcile, not blind sweep. */
  async reclaimOrphans(): Promise<string[]> {
    const result = await this.reconcile()
    return result.orphansRemoved
  }

  private async _rollbackMainTransaction(
    preMergeHead: string,
    stashCommit?: string,
  ): Promise<string | undefined> {
    try {
      await this._git(['merge', '--abort']).catch(() => undefined)
      await this._git(['reset', '--hard', preMergeHead])
      await this._git(['clean', '-fd', '--', '.', ':(exclude).meta-agent/**', ':(exclude).loop/**'])
      if (stashCommit) {
        await this._git(['stash', 'apply', '--index', stashCommit])
      }
      return undefined
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  private async _removeWorktreeAndBranch(record: AutoWorktreeRecord): Promise<boolean> {
    try {
      await this._git(['worktree', 'remove', '--force', record.worktreePath])
      await this._git(['branch', '-D', record.branchName])
      return true
    } catch {
      return false
    }
  }

  private async _safeCleanupDecision(
    record: AutoWorktreeRecord,
  ): Promise<{ remove: true; reason: string } | { remove: false; reason: string }> {
    switch (record.phase) {
      case 'merged':
        return { remove: true, reason: 'already merged' }
      case 'awaiting_merge': {
        if (record.finalizedCommit) return { remove: false, reason: 'finalized commit awaits merge' }
        const hasChanges = await this._recordHasRecoverableChanges(record).catch(() => true)
        return hasChanges
          ? { remove: false, reason: 'unmerged changes remain' }
          : { remove: true, reason: 'awaiting merge with no changes' }
      }
      case 'failed': {
        const hasChanges = await this._recordHasRecoverableChanges(record).catch(() => true)
        return hasChanges
          ? { remove: false, reason: 'failed worktree still has recoverable changes' }
          : { remove: true, reason: 'failed worktree has no recoverable changes' }
      }
      case 'allocated':
      case 'running':
      case 'finalizing':
      case 'merging':
      case 'conflicted':
        return { remove: false, reason: `${record.phase} is resumable or in-flight` }
      default:
        return { remove: false, reason: 'unknown phase' }
    }
  }

  private async _recordHasRecoverableChanges(record: AutoWorktreeRecord): Promise<boolean> {
    if (!existsSync(record.worktreePath)) return Boolean(record.finalizedCommit)
    const sourcePaths = ['--', '.', ':(exclude).meta-agent/**', ':(exclude).loop/**']
    const status = await this._gitIn(record.worktreePath, ['status', '--porcelain', ...sourcePaths])
    if (status.trim()) return true
    const commitCount = Number(await this._gitIn(
      record.worktreePath,
      ['rev-list', '--count', `${record.forkPoint}..HEAD`],
    ))
    return commitCount > 0
  }

  private async _dropStashByCommit(commit: string): Promise<void> {
    const list = await this._git(['stash', 'list', '--format=%H'])
    const index = list.split('\n').findIndex(hash => hash === commit)
    if (index >= 0) await this._git(['stash', 'drop', `stash@{${index}}`])
  }

  private async _assertNoGitOperation(worktreePath: string): Promise<void> {
    const paths = await Promise.all([
      this._gitIn(worktreePath, ['rev-parse', '--git-path', 'MERGE_HEAD']),
      this._gitIn(worktreePath, ['rev-parse', '--git-path', 'rebase-merge']),
      this._gitIn(worktreePath, ['rev-parse', '--git-path', 'rebase-apply']),
      this._gitIn(worktreePath, ['rev-parse', '--git-path', 'CHERRY_PICK_HEAD']),
    ])
    if (paths.some(existsSync)) {
      throw new Error(`Worktree ${worktreePath} has an unfinished git operation`)
    }
  }

  private async _branchExists(branchName: string): Promise<boolean> {
    return this._gitExitZero(this.projectDir, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branchName}`,
    ])
  }

  private async _updateRecord(
    record: AutoWorktreeRecord,
    patch: Partial<AutoWorktreeRecord>,
  ): Promise<void> {
    Object.assign(record, patch, { updatedAt: Date.now() })
    await this._requireRegistryPersist()
  }

  private _loadRegistry(): void {
    try {
      if (!existsSync(this.registryPath)) return
      const parsed = JSON.parse(readFileSync(this.registryPath, 'utf-8')) as AutoWorktreeRegistry
      if (!parsed || typeof parsed !== 'object' || !parsed.tasks) return
      for (const [taskId, record] of Object.entries(parsed.tasks)) {
        if (this.records.size >= MAX_REGISTRY_TASKS) break
        if (!record || record.taskId !== taskId || typeof record.branchName !== 'string') continue
        this.records.set(taskId, this._sanitizeRecord(record))
      }
    } catch {
      // Corrupt registry is left untouched for forensics; new writes replace it.
    }
  }

  private async _persistRegistry(): Promise<boolean> {
    try {
      const registry: AutoWorktreeRegistry = {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        tasks: Object.fromEntries(
          [...this.records].map(([taskId, record]) => [taskId, this._sanitizeRecord(record)]),
        ),
      }
      await atomicWriteJson(this.registryPath, registry)
      return true
    } catch {
      return false
    }
  }

  private async _requireRegistryPersist(): Promise<void> {
    if (!await this._persistRegistry()) {
      throw new Error(`Could not persist auto worktree registry: ${this.registryPath}`)
    }
  }

  private async _git(args: string[]): Promise<string> {
    return this._gitIn(this.projectDir, args)
  }

  private async _gitIn(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    })
    return stdout.trim()
  }

  private async _gitExitZero(cwd: string, args: string[]): Promise<boolean> {
    try {
      await execFileAsync('git', args, {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
      })
      return true
    } catch {
      return false
    }
  }

  private _sanitizeRecord(record: AutoWorktreeRecord): AutoWorktreeRecord {
    const trim = (value: string | undefined): string | undefined =>
      value?.slice(0, MAX_REGISTRY_STRING_CHARS)
    return {
      ...record,
      taskId: trim(record.taskId) ?? '',
      sessionId: trim(record.sessionId) ?? '',
      branchName: trim(record.branchName) ?? '',
      worktreePath: trim(record.worktreePath) ?? '',
      forkPoint: trim(record.forkPoint) ?? '',
      finalizedCommit: trim(record.finalizedCommit),
      preMergeHead: trim(record.preMergeHead),
      stashCommit: trim(record.stashCommit),
      error: trim(record.error),
    }
  }

  private _exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.operationChain.then(fn, fn)
    this.operationChain = run.then(() => undefined, () => undefined)
    return run
  }
}
