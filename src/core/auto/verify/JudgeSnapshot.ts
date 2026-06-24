/**
 * JudgeSnapshot — a throwaway, read-only checkout of the executor's CURRENT
 * working-tree state for the verify judge to inspect.
 *
 * Two problems a naive `git worktree add HEAD` would hit, both handled here:
 *
 *  1. The auto executor writes the SHARED working tree WITHOUT committing, and
 *     creates brand-new (untracked) files. `worktree add <HEAD>` would show the
 *     judge the pre-edit code and miss new files entirely. We instead build a
 *     snapshot commit that captures tracked + untracked changes, using a
 *     SEPARATE index file so the executor's real index/working tree is never
 *     touched:
 *         GIT_INDEX_FILE=<tmp> git add -A      (stage everything, incl. untracked)
 *         tree   = git write-tree              (tree object of current state)
 *         commit = git commit-tree <tree> -p HEAD
 *         git worktree add --detach <path> <commit>
 *
 *  2. bash in the judge could mutate files. Pointing it at a throwaway worktree
 *     means any write lands in the disposable checkout, never the real source.
 *     The worktree is removed (--force) when inspection finishes.
 *
 * No-ops gracefully when the workspace is not a git repo: `withReadonlySnapshot`
 * then invokes the callback with `null`, and the judge falls back to inspecting
 * the live tree (read-only tools only) — correctness is preserved, isolation is
 * just weaker, which we surface to the judge.
 */
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 60_000

/** Filename of the materialised per-round patch, written into the snapshot worktree. */
export const THIS_ROUND_DIFF_FILE = 'THIS_ROUND.diff'

/** Cap the materialised patch so a huge refactor can't blow up the worktree / context. */
const DIFF_PATCH_MAX_BYTES = 200 * 1024

/**
 * Pre-computed delta of "this round" (baseline HEAD → snapshot commit), produced
 * OUTSIDE the judge's sandbox where git has full access. Handed to the judge as a
 * ready-made artifact so it never has to reconstruct the diff via git inside a
 * no-network, read-only, write-confined sandbox (which it cannot reliably do).
 */
export interface SnapshotDiff {
  /** `git diff --stat baseline..snapshot` — compact per-file summary. */
  stat: string
  /** Full unified patch, truncated to DIFF_PATCH_MAX_BYTES. */
  patch: string
  /** True when `patch` was truncated. */
  truncated: boolean
}

async function git(projectDir: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', projectDir, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  })
  return stdout.trim()
}

function isGitRepo(projectDir: string): boolean {
  // Ask git, don't just look for a top-level `.git`. The previous existsSync
  // check failed for the common cases where projectDir is a SUBDIRECTORY of the
  // repo, or a linked worktree / submodule (where `.git` is a file or lives
  // above projectDir). A false negative there silently dropped the read-only
  // snapshot isolation and made the verify judge inspect the LIVE tree. This
  // detection matches AutoWorktreeCoordinator's `--git-common-dir` approach.
  try {
    const out = execFileSync(
      'git',
      ['-C', projectDir, 'rev-parse', '--is-inside-work-tree'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS },
    ).trim()
    return out === 'true'
  } catch {
    return false
  }
}

/**
 * Create a detached worktree at the executor's current state and run `fn` with
 * its path. Cleans up the worktree, the snapshot branch ref, and the temp index
 * afterwards — even if `fn` throws. Returns whatever `fn` returns.
 *
 * `fn` receives `null` when no git snapshot could be made (not a repo, or any
 * git step failed); callers should degrade to inspecting the live tree.
 */
export async function withReadonlySnapshot<T>(
  projectDir: string,
  fn: (snapshotPath: string | null, diff: SnapshotDiff | null) => Promise<T>,
): Promise<T> {
  const root = resolve(projectDir)
  if (!isGitRepo(root)) return fn(null, null)

  let worktreePath: string | null = null
  let tmpIndexDir: string | null = null
  try {
    // 1. Snapshot commit via an isolated index — never touches the live index.
    tmpIndexDir = mkdtempSync(join(tmpdir(), 'ma-judge-idx-'))
    const indexEnv = { GIT_INDEX_FILE: join(tmpIndexDir, 'index') }
    // Seed the temp index from HEAD so `add -A` produces a diff against HEAD.
    await git(root, ['read-tree', 'HEAD'], indexEnv)
    await git(root, ['add', '-A'], indexEnv)
    const tree = await git(root, ['write-tree'], indexEnv)
    const head = await git(root, ['rev-parse', 'HEAD'])
    const commit = await git(
      root,
      ['commit-tree', tree, '-p', head, '-m', 'meta-agent: verify snapshot'],
    )

    // 2. Detached worktree at that commit, under the project's .meta-agent dir.
    worktreePath = join(root, '.meta-agent', 'auto', 'verify-snapshot')
    // Clear any leftover from a previous crashed run before re-adding.
    await git(root, ['worktree', 'remove', '--force', worktreePath]).catch(() => undefined)
    await git(root, ['worktree', 'add', '--detach', worktreePath, commit])

    // 3. Pre-compute THIS round's delta (baseline HEAD → snapshot commit) while
    //    we still have full git access OUTSIDE the judge's sandbox. The auto
    //    executor writes the working tree WITHOUT committing (see header), so
    //    HEAD is the run baseline and head..commit is the whole round. Hand it
    //    to the judge as a ready-made artifact + materialise THIS_ROUND.diff in
    //    the throwaway worktree (the judge's writable root) so it can read the
    //    full patch without reconstructing it via git. A diff failure never
    //    blocks verification — the judge still gets the snapshot tree.
    const diff = await computeSnapshotDiff(root, head, commit, worktreePath)

    return await fn(worktreePath, diff)
  } catch {
    // Any git failure → degrade to live-tree inspection rather than blocking.
    return await fn(null, null)
  } finally {
    if (worktreePath) {
      await git(root, ['worktree', 'remove', '--force', worktreePath]).catch(() => undefined)
    }
    // Prune any dangling worktree admin entry; harmless if nothing to do.
    await git(root, ['worktree', 'prune']).catch(() => undefined)
    if (tmpIndexDir) {
      try { rmSync(tmpIndexDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  }
}

/**
 * Compute `git diff --stat` + full patch for baseline..commit and materialise
 * the patch into the snapshot worktree as THIS_ROUND.diff. Returns null on any
 * git failure (the diff is a bonus, never a hard dependency of verification).
 */
async function computeSnapshotDiff(
  root: string,
  baseline: string,
  commit: string,
  worktreePath: string,
): Promise<SnapshotDiff | null> {
  try {
    const range = `${baseline}..${commit}`
    const stat = await git(root, ['diff', '--stat', range])
    const fullPatch = await git(root, ['diff', range])
    const truncated = Buffer.byteLength(fullPatch, 'utf-8') > DIFF_PATCH_MAX_BYTES
    const patch = truncated
      ? fullPatch.slice(0, DIFF_PATCH_MAX_BYTES) + '\n[... patch truncated at 200KB — read the changed files directly for the rest ...]'
      : fullPatch
    // Materialise into the throwaway worktree so the judge can read_file it.
    // Skip the write when there is nothing to write (empty patch).
    if (patch.trim()) {
      try {
        writeFileSync(join(worktreePath, THIS_ROUND_DIFF_FILE), patch, 'utf-8')
      } catch { /* best-effort: judge still has stat + the tree itself */ }
    }
    return { stat, patch, truncated }
  } catch {
    return null
  }
}
