/**
 * gitBase — where the workspace stood when a run began (G1-1).
 *
 * The trajectory schema has carried a `gitBase` field since A3 and **nothing in
 * the repository ever assigned it**, so it was `undefined` on every line ever
 * written. That is not a cosmetic gap: G1 needs each EvalCase to reference an
 * immutable starting point, and the alternative — replaying from the state the
 * task *finished* in — produces cases that pass because the answer is already
 * present in the working tree. Every metric computed that way is fiction.
 *
 * ── Why per run, not per session ────────────────────────────────────────────
 *
 * A long session commits as it goes, so one session-level base only identifies
 * the start of run 1. Runs 2..N would each have to be replayed by first
 * replaying everything before them. Capturing at the start of each run makes a
 * single run independently restorable, which is the granularity an EvalCase
 * actually wants.
 *
 * ── Why this reports dirt instead of hiding it ──────────────────────────────
 *
 * A commit sha alone claims more than it knows. If the working tree had
 * uncommitted edits or untracked files when the run started, that commit does
 * NOT describe the starting state, and a later restore from it would silently
 * begin somewhere else. So the capture records what it saw and lets
 * `environmentFidelity` downstream say `restored` only when the commit really
 * was the whole story.
 */

import { runGit } from '../exec/runGit.js'

/** Short timeout: this runs on the turn's critical path. */
const GIT_BASE_TIMEOUT_MS = 3_000

export interface GitBase {
  /** HEAD commit sha at run start. */
  commit: string
  /** Branch name, or undefined on a detached HEAD. */
  branch?: string
  /** Tracked files had uncommitted modifications at run start. */
  dirty: boolean
  /**
   * Untracked, non-ignored files were present at run start.
   *
   * Separate from `dirty` because they fail differently: dirty tracked files
   * are recoverable from the commit plus a diff, whereas untracked files exist
   * nowhere in git history and are simply lost unless snapshotted separately.
   */
  untracked: boolean
}

/**
 * Capture the git starting point of `cwd`, or undefined when there is none.
 *
 * Returns undefined — never throws and never partially fills — when the
 * directory is not a git repository, when git is unavailable, or when any probe
 * fails or times out. An absent gitBase honestly says "unknown starting point";
 * a half-filled one would be read as a usable reference and is worse than
 * nothing.
 */
export async function captureGitBase(cwd: string): Promise<GitBase | undefined> {
  try {
    const commit = await gitOut(['rev-parse', 'HEAD'], cwd)
    if (!commit || !/^[0-9a-f]{40}$/.test(commit)) return undefined

    // One call for branch, dirt and untracked together. `--branch` puts a
    // `## <branch>...` header on the first line, and the remaining lines are
    // the porcelain entries — the '??' ones being untracked. Doing this as
    // three separate probes cost three process spawns on every single turn.
    const status = await gitOut(['status', '--porcelain', '--branch', '--untracked-files=normal'], cwd)
    const lines = status ? status.split('\n').filter(Boolean) : []
    const header = lines.find(line => line.startsWith('## '))
    const entries = lines.filter(line => !line.startsWith('## '))

    return {
      commit,
      ...(parseBranch(header) !== undefined ? { branch: parseBranch(header)! } : {}),
      dirty: entries.some(line => !line.startsWith('??')),
      untracked: entries.some(line => line.startsWith('??')),
    }
  } catch {
    return undefined
  }
}

/**
 * Read the branch out of a porcelain `--branch` header.
 *
 * Shapes: `## main`, `## main...origin/main [ahead 1]`, and for a detached
 * head `## HEAD (no branch)` — which is not a branch name and must not be
 * recorded as one.
 */
function parseBranch(header: string | undefined): string | undefined {
  if (!header) return undefined
  const rest = header.slice(3).trim()
  if (rest.startsWith('HEAD (no branch)')) return undefined
  const branch = rest.split('...')[0]?.trim()
  return branch && branch !== 'HEAD' ? branch : undefined
}

async function gitOut(args: string[], cwd: string): Promise<string | null> {
  try {
    // raw: these outputs are shas, ref names and porcelain status records —
    // structurally incapable of carrying a credential, and redaction would
    // corrupt the parse.
    const { stdout } = await runGit(args, { cwd, timeout: GIT_BASE_TIMEOUT_MS, raw: true })
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 * Compact string form for `TrajectoryDescriptor.gitBase`, whose type predates
 * this module and is a plain string.
 *
 * Suffixed rather than bare sha, so a reader can never mistake a dirty start
 * for a clean one. `+dirty` means tracked modifications, `+untracked` means
 * files git has never seen.
 */
export function formatGitBase(base: GitBase | undefined): string | undefined {
  if (!base) return undefined
  const flags = [base.dirty ? 'dirty' : '', base.untracked ? 'untracked' : ''].filter(Boolean)
  return flags.length > 0 ? `${base.commit}+${flags.join('+')}` : base.commit
}
