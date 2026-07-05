/**
 * RunWorkspace — the run-scoped INTEGRATION BRANCH an auto_orch graph executes on.
 *
 * Semantics (the whole point of this module):
 *   • The MAIN working tree is never touched while the graph runs. At run start
 *     an integration branch `auto-orch/<runId>` is forked from main HEAD into a
 *     private worktree (the "integration tree"); every node executes against it:
 *     isolated writers fork their task worktrees FROM the integration branch and
 *     merge back INTO it, role reviewers read it, code nodes write state/ in it.
 *   • Run completed  → finishSuccess(): ONE squash merge of the integration
 *     branch into main (transactional: dirty main is stashed once, any failure
 *     rolls main back byte-for-byte and preserves the branch).
 *   • Run failed / aborted → finishDiscard(): delete the branch, the integration
 *     tree and all task worktrees. Main was never written, so the workspace is
 *     clean by construction.
 *   • Run paused → keep everything; the descriptor is persisted with the durable
 *     schedule so a later resume re-attaches to the same branch/tree.
 *
 * Because the integration tree is private and node state/ writes are committed
 * eagerly, the per-node merge transactions inside it never hit a dirty tree —
 * the mid-run `git stash` dance (the source of the "re-run fails with stash
 * errors" class of bugs) is eliminated entirely. The single remaining stash is
 * the final merge into a dirty main, whose rollback is deterministic.
 */
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { cp, mkdir, readdir, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { promisify } from 'util'
import { AutoWorktreeCoordinator } from '../auto/AutoWorktreeCoordinator.js'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 60_000
/** Paths excluded from every git transaction (meta-agent internals). */
const TX_PATHS = ['--', '.', ':(exclude).meta-agent/**']
/** Process-state root synced by file copy (covers gitignored state files). */
const STATE_DIR = 'state'
export const AUTO_ORCH_RUN_BRANCH_PREFIX = 'auto-orch/'

/** Persisted pointer to a live run workspace (stored on paused schedules). */
export interface AutoOrchRunWorkspaceDescriptor {
  runId: string
  branchName: string
  /** Integration-tree path (absolute). */
  treePath: string
  /** Main-HEAD commit the run branch was forked from. */
  forkPoint: string
}

/** The minimal surface node runners need (root + eager state commits). */
export interface AutoOrchRunTreeOps {
  /** Integration-tree root — the projectDir every node operates against. */
  root: string
  /** Commit all pending (non-.meta-agent) changes onto the run branch. */
  commitAll(message: string): Promise<boolean>
}

export interface AutoOrchRunFinishResult {
  merged: boolean
  /** Squash-merge commit on main (when merged and there were changes). */
  commitHash?: string
  /** Human-readable detail (esp. on failure: why + where the work is kept). */
  note?: string
  /** Set when the branch was intentionally preserved after a failed merge. */
  branchPreserved?: boolean
}

function runsRoot(projectDir: string): string {
  return join(resolve(projectDir), '.meta-agent', 'auto_orch', 'runs')
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  })
  return stdout.trim()
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args)
    return true
  } catch {
    return false
  }
}

export class AutoOrchRunWorkspace implements AutoOrchRunTreeOps {
  readonly runId: string
  readonly branchName: string
  /** Integration-tree root (implements AutoOrchRunTreeOps.root). */
  readonly root: string
  readonly forkPoint: string
  /** Run-scoped coordinator: task worktrees fork from / merge into the run branch. */
  readonly coordinator: AutoWorktreeCoordinator
  private readonly projectDir: string
  private finished = false

  constructor(projectDir: string, descriptor: AutoOrchRunWorkspaceDescriptor) {
    this.projectDir = resolve(projectDir)
    this.runId = descriptor.runId
    this.branchName = descriptor.branchName
    this.root = descriptor.treePath
    this.forkPoint = descriptor.forkPoint
    const runDir = join(runsRoot(this.projectDir), this.runId)
    this.coordinator = new AutoWorktreeCoordinator(this.root, {
      worktreeBase: join(runDir, 'tasks'),
      registryPath: join(runDir, 'worktrees.json'),
    })
  }

  descriptor(): AutoOrchRunWorkspaceDescriptor {
    return {
      runId: this.runId,
      branchName: this.branchName,
      treePath: this.root,
      forkPoint: this.forkPoint,
    }
  }

  /**
   * Commit every pending non-.meta-agent change in the integration tree onto
   * the run branch. Called eagerly after direct writers (code nodes, the
   * integrator role) so the tree is always clean when a task branch merges —
   * which is exactly what keeps the mid-run stash path dead.
   */
  async commitAll(message: string): Promise<boolean> {
    await git(this.root, ['add', '-A', ...TX_PATHS])
    const staged = !(await gitOk(this.root, ['diff', '--cached', '--quiet', '--exit-code']))
    if (!staged) return false
    await git(this.root, ['commit', '-m', message])
    return true
  }

  /** Commits accumulated on the run branch since it forked from main. */
  async commitCount(): Promise<number> {
    const n = await git(this.projectDir, [
      'rev-list', '--count', `${this.forkPoint}..refs/heads/${this.branchName}`,
    ])
    return Number(n) || 0
  }

  /**
   * Run completed: squash-merge the integration branch into main, ONCE,
   * transactionally. On any failure main is rolled back to its pre-merge state
   * (including a re-applied stash of the user's uncommitted changes) and the
   * branch + tree are PRESERVED for manual recovery — merged:false, never a
   * half-merged main.
   */
  async finishSuccess(message: string): Promise<AutoOrchRunFinishResult> {
    if (this.finished) return { merged: true, note: 'already finished' }
    try {
      await this.commitAll('auto_orch: finalize run state').catch(() => false)
      const commits = await this.commitCount()
      if (commits === 0) {
        await this.syncStateToMain().catch(() => undefined)
        await this.discardArtifacts()
        this.finished = true
        return { merged: true, note: 'run branch had no changes' }
      }

      const main = this.projectDir
      const preHead = await git(main, ['rev-parse', 'HEAD'])
      const dirty = (await git(main, ['status', '--porcelain', ...TX_PATHS])).length > 0
      let stashCommit: string | undefined
      if (dirty) {
        await git(main, [
          'stash', 'push', '--include-untracked',
          '-m', `meta-agent auto_orch ${this.runId} final merge`,
          ...TX_PATHS,
        ])
        stashCommit = await git(main, ['rev-parse', 'refs/stash'])
      }

      let stashNote: string | undefined
      try {
        await git(main, ['merge', '--squash', this.branchName])
        const staged = !(await gitOk(main, ['diff', '--cached', '--quiet', '--exit-code']))
        let commitHash = preHead
        if (staged) {
          await git(main, ['commit', '-m', message])
          commitHash = await git(main, ['rev-parse', 'HEAD'])
        }
        if (stashCommit) {
          stashNote = await this.restoreStash(main, stashCommit)
        }
        await this.syncStateToMain().catch(() => undefined)
        await this.discardArtifacts()
        this.finished = true
        return { merged: true, commitHash, note: stashNote }
      } catch (err) {
        // Transactional rollback: main returns byte-for-byte to its pre-merge
        // state (tree content is exactly what was stashed, so apply is clean).
        const original = err instanceof Error ? err.message : String(err)
        let rollbackNote: string | undefined
        try {
          await git(main, ['merge', '--abort']).catch(() => undefined)
          await git(main, ['reset', '--hard', preHead])
          await git(main, ['clean', '-fd', ...TX_PATHS])
          if (stashCommit) rollbackNote = await this.restoreStash(main, stashCommit)
        } catch (rollbackErr) {
          rollbackNote = `rollback incomplete: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`
        }
        // Deliberately preserved — mark finished so a later defensive
        // finishDiscard() cannot destroy the only copy of the run's work.
        this.finished = true
        return {
          merged: false,
          branchPreserved: true,
          note: [
            `merging run branch ${this.branchName} into main failed: ${original}`,
            rollbackNote,
            `工作成果已保留在分支 ${this.branchName}（工作树 ${this.root}），可手动合并`,
          ].filter(Boolean).join('; '),
        }
      }
    } catch (err) {
      this.finished = true // preserve artifacts for manual recovery
      return {
        merged: false,
        branchPreserved: true,
        note: `finishSuccess failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Run failed / aborted: delete everything this run created. Main was never
   * written during the run, so this alone guarantees a clean workspace.
   */
  async finishDiscard(): Promise<void> {
    if (this.finished) return
    await this.discardArtifacts()
    this.finished = true
  }

  /** apply + drop the stash; on apply conflict keep it and tell the user where. */
  private async restoreStash(main: string, stashCommit: string): Promise<string | undefined> {
    const applied = await gitOk(main, ['stash', 'apply', '--index', stashCommit])
      || await gitOk(main, ['stash', 'apply', stashCommit])
    if (!applied) {
      return `你的未提交改动保存在 stash（${stashCommit.slice(0, 12)}），因与合并结果冲突未能自动恢复，请手动 git stash apply`
    }
    await dropStashByCommit(main, stashCommit).catch(() => undefined)
    return undefined
  }

  /**
   * Copy the integration tree's state/ back to main by file copy. Belt for
   * process-state files that git skipped (e.g. gitignored state/). Only runs on
   * the SUCCESS path — a failed run must leave main's state/ untouched.
   */
  private async syncStateToMain(): Promise<void> {
    const from = join(this.root, STATE_DIR)
    if (!existsSync(from)) return
    await cp(from, join(this.projectDir, STATE_DIR), { recursive: true, force: true })
  }

  /** Remove task worktrees, the integration tree, the branch and the run dir. */
  private async discardArtifacts(): Promise<void> {
    await this.coordinator.cleanupAll().catch(() => undefined)
    await removeRunArtifacts(this.projectDir, this.runId, this.branchName)
  }
}

/**
 * Create the run workspace: fork `auto-orch/<runId>` from main HEAD into a
 * private worktree and seed it with main's current state/ files (which may be
 * untracked and therefore absent from the checkout). Returns null when the
 * workspace is not a git repo (or has no commits) — callers fall back to the
 * legacy on-main execution path.
 */
export async function createAutoOrchRunWorkspace(
  projectDir: string,
): Promise<AutoOrchRunWorkspace | null> {
  const main = resolve(projectDir)
  try {
    const forkPoint = await git(main, ['rev-parse', 'HEAD'])
    const runId = `run-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`
    const branchName = `${AUTO_ORCH_RUN_BRANCH_PREFIX}${runId}`
    const treePath = join(runsRoot(main), runId, 'tree')
    await mkdir(join(runsRoot(main), runId), { recursive: true })
    await git(main, ['worktree', 'add', '-b', branchName, treePath, forkPoint])
    // Seed process state so nodes see the same state/ a main-tree run would.
    const stateDir = join(main, STATE_DIR)
    if (existsSync(stateDir)) {
      await cp(stateDir, join(treePath, STATE_DIR), { recursive: true, force: true }).catch(() => undefined)
    }
    return new AutoOrchRunWorkspace(main, { runId, branchName, treePath, forkPoint })
  } catch {
    return null
  }
}

/**
 * Re-attach to a persisted run workspace (scheduler resume path). Restores the
 * integration worktree from the branch when the directory is missing. Returns
 * null when the branch no longer exists — the schedule must then fail cleanly.
 */
export async function attachAutoOrchRunWorkspace(
  projectDir: string,
  descriptor: AutoOrchRunWorkspaceDescriptor,
): Promise<AutoOrchRunWorkspace | null> {
  const main = resolve(projectDir)
  const branchOk = await gitOk(main, [
    'show-ref', '--verify', '--quiet', `refs/heads/${descriptor.branchName}`,
  ])
  if (!branchOk) return null
  if (!existsSync(descriptor.treePath)) {
    try {
      await mkdir(join(runsRoot(main), descriptor.runId), { recursive: true })
      await git(main, ['worktree', 'add', descriptor.treePath, descriptor.branchName])
    } catch {
      return null
    }
  }
  return new AutoOrchRunWorkspace(main, descriptor)
}

/**
 * Startup self-heal: remove run workspaces left behind by crashed/killed runs
 * (worktrees, task worktrees, branches, run dirs) so a re-run can never be
 * wedged by residue. `keepRunIds` protects runs owned by live paused schedules.
 */
export async function sweepStaleAutoOrchRuns(
  projectDir: string,
  keepRunIds: ReadonlySet<string>,
): Promise<string[]> {
  const main = resolve(projectDir)
  const root = runsRoot(main)
  const removed: string[] = []
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    entries = []
  }
  for (const runId of entries) {
    if (keepRunIds.has(runId)) continue
    await removeRunArtifacts(main, runId, `${AUTO_ORCH_RUN_BRANCH_PREFIX}${runId}`).catch(() => undefined)
    removed.push(runId)
  }
  // Orphan run branches whose run dir is already gone.
  try {
    const branches = (await git(main, ['branch', '--list', `${AUTO_ORCH_RUN_BRANCH_PREFIX}*`, '--format=%(refname:short)']))
      .split('\n').map(s => s.trim()).filter(Boolean)
    for (const branch of branches) {
      const runId = branch.slice(AUTO_ORCH_RUN_BRANCH_PREFIX.length)
      if (keepRunIds.has(runId) || entries.includes(runId)) continue
      await git(main, ['branch', '-D', branch]).catch(() => undefined)
      removed.push(runId)
    }
  } catch { /* non-git → nothing to sweep */ }
  return removed
}

/** Force-remove a run's worktrees, branches and directory. Best-effort. */
async function removeRunArtifacts(main: string, runId: string, branchName: string): Promise<void> {
  const runDir = join(runsRoot(main), runId)
  // Task worktrees first (linked to the main repo), then the integration tree.
  const tasksDir = join(runDir, 'tasks')
  let taskEntries: string[] = []
  try {
    taskEntries = await readdir(tasksDir)
  } catch { /* none */ }
  for (const task of taskEntries) {
    const p = join(tasksDir, task)
    await git(main, ['worktree', 'remove', '--force', p]).catch(async () => {
      await rm(p, { recursive: true, force: true }).catch(() => undefined)
    })
    await git(main, ['branch', '-D', `sub/${task}/code`]).catch(() => undefined)
  }
  const treePath = join(runDir, 'tree')
  await git(main, ['worktree', 'remove', '--force', treePath]).catch(async () => {
    await rm(treePath, { recursive: true, force: true }).catch(() => undefined)
  })
  await git(main, ['branch', '-D', branchName]).catch(() => undefined)
  await git(main, ['worktree', 'prune']).catch(() => undefined)
  await rm(runDir, { recursive: true, force: true }).catch(() => undefined)
}

async function dropStashByCommit(main: string, commit: string): Promise<void> {
  const list = await git(main, ['stash', 'list', '--format=%H'])
  const index = list.split('\n').findIndex(hash => hash === commit)
  if (index >= 0) await git(main, ['stash', 'drop', `stash@{${index}}`])
}
