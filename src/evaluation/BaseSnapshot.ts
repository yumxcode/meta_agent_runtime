/**
 * BaseSnapshot — capturing a workspace's starting state so a case can be rerun
 * from it (G1-5, minimum viable).
 *
 * ── The mistake this exists to prevent ──────────────────────────────────────
 *
 * v1 of the plan had EvalCase record `prompt + repo + commit + setupCommands`.
 * That does not work, and the reason is worth stating plainly: the commit a
 * task *finished* on already contains the answer. Replaying from it produces a
 * case that passes before the agent does anything, and every metric computed
 * over such cases is fiction. A snapshot has to be of the state *before* the
 * task ran, and it has to include the parts of that state git does not track.
 *
 * ── Fidelity is a claim, and claims are checked ─────────────────────────────
 *
 * The full G1-5 covers submodules, LFS, dependency locks, env whitelists and
 * time/network simulation. This is the minimum viable subset: commit identity
 * plus untracked non-ignored files. Everything outside that subset is not
 * silently ignored — it downgrades `fidelity`:
 *
 *   restored      — the snapshot reproduces the starting state, and a restore
 *                   was verified byte-for-byte against what was captured.
 *   approximated  — something real was captured, but a known gap remains
 *                   (submodules, LFS pointers). Usable for analysis; the plan
 *                   forbids it in sealed_test.
 *   unrestorable  — the starting state cannot be reconstructed at all.
 *
 * The point of the enum is to make "we could not really restore this" a value
 * the pipeline must handle rather than an omission nobody notices. Anything
 * that cannot honestly claim `restored` is not allowed to claim it, and G1's
 * abort condition counts only cases that can.
 */

import { createHash } from 'crypto'
import { join, relative, sep } from 'path'
import { mkdir, readFile, writeFile, rm, cp, stat } from 'fs/promises'
import { runGit } from '../infra/exec/runGit.js'
import { captureGitBase, type GitBase } from '../infra/git/gitBase.js'

const GIT_TIMEOUT_MS = 30_000

/** How completely a snapshot can reproduce the state it was taken from. */
export type EnvironmentFidelity = 'restored' | 'approximated' | 'unrestorable'

/** Why a snapshot could not claim full fidelity. Codes, never free text. */
export const FIDELITY_GAPS = {
  /** Repository has submodules; this version does not capture their state. */
  SUBMODULES_PRESENT: 'submodules_present',
  /** Git LFS pointers found; the pointed-to blobs are not captured. */
  LFS_POINTERS_PRESENT: 'lfs_pointers_present',
  /** Tracked files were modified at capture time and are captured as-is. */
  DIRTY_WORKTREE: 'dirty_worktree',
  /** Not a git repository, so there is no commit to restore from. */
  NOT_A_GIT_REPO: 'not_a_git_repo',
  /** An untracked file could not be read (permissions, disappeared mid-capture). */
  UNTRACKED_READ_FAILED: 'untracked_read_failed',
  /** Untracked payload exceeded the size ceiling and was not captured. */
  UNTRACKED_TOO_LARGE: 'untracked_too_large',
} as const

export type FidelityGap = typeof FIDELITY_GAPS[keyof typeof FIDELITY_GAPS]

/**
 * Ceiling on captured untracked bytes.
 *
 * Untracked content is arbitrary — a stray core dump or a node_modules that
 * escaped .gitignore would otherwise be copied into the snapshot store. Past
 * the ceiling the snapshot says so and drops to `approximated` rather than
 * quietly capturing half.
 */
const MAX_UNTRACKED_BYTES = 32 * 1024 * 1024

export interface CapturedFile {
  /** Repo-relative POSIX path. */
  path: string
  sha256: string
  bytes: number
}

export interface BaseSnapshot {
  schemaVersion: 'base-snapshot-1.0'
  id: string
  createdAt: number
  /** Absolute path the snapshot was taken from, for diagnostics only. */
  sourceDir: string
  gitBase?: GitBase
  fidelity: EnvironmentFidelity
  /** Empty exactly when fidelity is 'restored'. */
  gaps: FidelityGap[]
  untracked: CapturedFile[]
  /** Digest over gitBase + the untracked manifest; the snapshot's identity. */
  contentHash: string
}

function snapshotId(contentHash: string): string {
  return `basesnap_${contentHash.slice(0, 24)}`
}

/** Guards against a crafted id escaping the snapshot store directory. */
export function isBaseSnapshotId(value: string): boolean {
  return /^basesnap_[a-f0-9]{24}$/.test(value)
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

async function gitOut(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(args, { cwd, timeout: GIT_TIMEOUT_MS, raw: true })
    return stdout
  } catch {
    return null
  }
}

/**
 * Capture the current state of `sourceDir`.
 *
 * Never throws for a workspace it cannot handle: an unusable workspace yields a
 * snapshot with `fidelity: 'unrestorable'` and the reason in `gaps`. That is
 * deliberately not an exception, because "this workspace cannot support a
 * replayable case" is a finding the corpus survey needs to count, not an error
 * that aborts the survey.
 */
export async function captureBaseSnapshot(sourceDir: string): Promise<BaseSnapshot> {
  const gaps = new Set<FidelityGap>()
  const gitBase = await captureGitBase(sourceDir)

  if (!gitBase) {
    return finalize(sourceDir, undefined, [FIDELITY_GAPS.NOT_A_GIT_REPO], [], 'unrestorable')
  }

  // Tracked-but-modified content is captured only as the flag on gitBase; the
  // diff itself is not stored yet. Say so rather than implying the commit is
  // the whole starting state.
  if (gitBase.dirty) gaps.add(FIDELITY_GAPS.DIRTY_WORKTREE)

  if (await hasSubmodules(sourceDir)) gaps.add(FIDELITY_GAPS.SUBMODULES_PRESENT)
  if (await hasLfsPointers(sourceDir)) gaps.add(FIDELITY_GAPS.LFS_POINTERS_PRESENT)

  const { files, gaps: untrackedGaps } = await captureUntracked(sourceDir)
  for (const gap of untrackedGaps) gaps.add(gap)

  const fidelity: EnvironmentFidelity = gaps.size === 0 ? 'restored' : 'approximated'
  return finalize(sourceDir, gitBase, [...gaps], files, fidelity)
}

function finalize(
  sourceDir: string,
  gitBase: GitBase | undefined,
  gaps: FidelityGap[],
  untracked: CapturedFile[],
  fidelity: EnvironmentFidelity,
): BaseSnapshot {
  const sorted = [...gaps].sort()
  const files = [...untracked].sort((a, b) => a.path.localeCompare(b.path))
  const contentHash = createHash('sha256').update(JSON.stringify({
    gitBase: gitBase ?? null,
    gaps: sorted,
    untracked: files,
  })).digest('hex')

  return {
    schemaVersion: 'base-snapshot-1.0',
    id: snapshotId(contentHash),
    createdAt: Date.now(),
    sourceDir,
    ...(gitBase ? { gitBase } : {}),
    fidelity,
    gaps: sorted,
    untracked: files,
    contentHash,
  }
}

async function hasSubmodules(cwd: string): Promise<boolean> {
  try {
    await stat(join(cwd, '.gitmodules'))
    return true
  } catch {
    return false
  }
}

/**
 * Detect LFS pointer files among tracked content.
 *
 * Checks the attributes declaration rather than scanning file contents: a repo
 * that declares `filter=lfs` has LFS-managed paths whether or not this checkout
 * happens to have smudged them, and scanning every tracked file would be far
 * too expensive for a probe.
 */
async function hasLfsPointers(cwd: string): Promise<boolean> {
  try {
    const attributes = await readFile(join(cwd, '.gitattributes'), 'utf8')
    return /filter\s*=\s*lfs/.test(attributes)
  } catch {
    return false
  }
}

async function captureUntracked(
  cwd: string,
): Promise<{ files: CapturedFile[]; gaps: FidelityGap[] }> {
  // NUL-delimited so paths containing newlines or quotes survive intact.
  const raw = await gitOut(['ls-files', '--others', '--exclude-standard', '-z'], cwd)
  if (raw === null) return { files: [], gaps: [FIDELITY_GAPS.UNTRACKED_READ_FAILED] }

  const paths = raw.split('\0').filter(Boolean)
  const files: CapturedFile[] = []
  const gaps: FidelityGap[] = []
  let total = 0

  for (const path of paths) {
    try {
      const contents = await readFile(join(cwd, path))
      total += contents.byteLength
      if (total > MAX_UNTRACKED_BYTES) {
        gaps.push(FIDELITY_GAPS.UNTRACKED_TOO_LARGE)
        break
      }
      files.push({
        path: toPosix(path),
        sha256: createHash('sha256').update(contents).digest('hex'),
        bytes: contents.byteLength,
      })
    } catch {
      // A file that vanished or cannot be read mid-capture is a real gap: the
      // starting state included something this snapshot does not have.
      gaps.push(FIDELITY_GAPS.UNTRACKED_READ_FAILED)
    }
  }

  return { files, gaps }
}

// ─────────────────────────────────────────────────────────────────────────────
// Materialising a snapshot
// ─────────────────────────────────────────────────────────────────────────────

export interface RestoreResult {
  /** Where the state was materialised. */
  dir: string
  /** Fidelity actually achieved, which can be lower than the snapshot claimed. */
  fidelity: EnvironmentFidelity
  gaps: FidelityGap[]
}

export class BaseSnapshotRestoreError extends Error {}

/**
 * Materialise `snapshot` into `targetDir`, which must not already exist.
 *
 * Restores from the *source repository* — this minimal version stores file
 * digests rather than blobs, so it can verify a restore and detect drift but
 * cannot reconstruct content the source no longer has. That limitation is why
 * `verifyRestore` exists and why a mismatch is an error rather than a warning:
 * a case that silently starts from drifted content is exactly the failure mode
 * this whole gate is meant to rule out.
 */
export async function restoreBaseSnapshot(
  snapshot: BaseSnapshot,
  targetDir: string,
  opts: { sourceDir?: string } = {},
): Promise<RestoreResult> {
  if (snapshot.fidelity === 'unrestorable' || !snapshot.gitBase) {
    throw new BaseSnapshotRestoreError(
      `snapshot ${snapshot.id} is unrestorable (${snapshot.gaps.join(', ') || 'no git base'})`,
    )
  }

  const sourceDir = opts.sourceDir ?? snapshot.sourceDir
  await mkdir(targetDir, { recursive: true })

  // A worktree pinned to the recorded commit: git's own mechanism for
  // materialising a commit without disturbing the source checkout.
  const worktreeAdd = await gitOut(
    ['worktree', 'add', '--detach', targetDir, snapshot.gitBase.commit],
    sourceDir,
  )
  if (worktreeAdd === null) {
    await rm(targetDir, { recursive: true, force: true })
    throw new BaseSnapshotRestoreError(
      `could not materialise commit ${snapshot.gitBase.commit} from ${sourceDir}`,
    )
  }

  const gaps = new Set<FidelityGap>(snapshot.gaps)

  // Untracked files are not in the commit, so they are copied back explicitly.
  for (const file of snapshot.untracked) {
    const from = join(sourceDir, ...file.path.split('/'))
    const to = join(targetDir, ...file.path.split('/'))
    try {
      await mkdir(join(to, '..'), { recursive: true })
      await cp(from, to)
    } catch {
      gaps.add(FIDELITY_GAPS.UNTRACKED_READ_FAILED)
    }
  }

  const sorted = [...gaps].sort()
  return {
    dir: targetDir,
    fidelity: sorted.length === 0 ? 'restored' : 'approximated',
    gaps: sorted,
  }
}

/** Release a worktree created by restoreBaseSnapshot. */
export async function discardRestoredSnapshot(
  targetDir: string,
  opts: { sourceDir: string },
): Promise<void> {
  // Ask git to drop its worktree registration first; removing the directory
  // alone leaves a stale administrative entry that breaks the next restore to
  // the same path.
  await gitOut(['worktree', 'remove', '--force', targetDir], opts.sourceDir)
  await rm(targetDir, { recursive: true, force: true })
}

/**
 * Confirm a restored directory matches what the snapshot recorded.
 *
 * Returns the paths that differ. An empty list is the only thing that entitles
 * a case to claim `restored`; the plan's abort condition counts cases that pass
 * this check, not cases that were merely captured.
 */
export async function verifyRestore(
  snapshot: BaseSnapshot,
  restoredDir: string,
): Promise<string[]> {
  const mismatches: string[] = []

  for (const file of snapshot.untracked) {
    try {
      const contents = await readFile(join(restoredDir, ...file.path.split('/')))
      const sha = createHash('sha256').update(contents).digest('hex')
      if (sha !== file.sha256) mismatches.push(file.path)
    } catch {
      mismatches.push(file.path)
    }
  }

  if (snapshot.gitBase) {
    const head = await gitOut(['rev-parse', 'HEAD'], restoredDir)
    if (head?.trim() !== snapshot.gitBase.commit) mismatches.push('HEAD')
  }

  return mismatches
}

/** Relative path helper for callers assembling snapshot-relative references. */
export function snapshotRelative(root: string, absolute: string): string {
  return toPosix(relative(root, absolute))
}

/** Serialise for storage; kept separate so the store never re-derives identity. */
export async function writeSnapshotManifest(path: string, snapshot: BaseSnapshot): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf8')
}
