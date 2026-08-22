/**
 * turnDiffSection — render the run's file changes for the verify / drift judges.
 *
 * Why this exists alongside the git snapshot diff
 * -----------------------------------------------
 * `JudgeSnapshot` already hands the VERIFY judge a `git diff` of the round, and
 * that remains the primary view: it is a real patch, computed by git, covering
 * everything git can see. This module does not replace it. It covers the two
 * cases where git sees nothing, and the one gate that never got a diff at all.
 *
 *   1. NOT A GIT REPO. `withReadonlySnapshot` bails on `isGitRepo() === false`
 *      and the judge is told to inspect the live tree with no delta whatsoever.
 *
 *   2. GITIGNORED PATHS. The snapshot is built with `git add -A`, which honours
 *      `.gitignore`. In a robotics workspace that routinely excludes `build/`,
 *      `install/`, `logs/`, `data/`, `*.bag` — so an executor that spent the
 *      round rewriting a config under `install/` shows up as an EMPTY round to
 *      the judge, which reads as "did nothing" rather than "did something you
 *      cannot see". That failure is silent and points the wrong way.
 *
 *   3. THE DRIFT GATE. It receives goal + checkpoint + experiences and no diff
 *      at all; its rubric tells it to "优先据此用 git diff" — i.e. to spend its
 *      own turns and budget reconstructing what verify is handed for free.
 *
 * `TurnDiffTracker` is git-independent: it records what the write TOOLS touched,
 * so ignore rules and repo-ness are both irrelevant to it. That makes it exactly
 * the right complement, and a poor replacement — it cannot see edits made by a
 * shell command, which git catches. The two are used together on purpose.
 *
 * Token discipline
 * ----------------
 * This text lands in a judge's context on every gate invocation, so the default
 * is a STAT block (one line per file), not a patch. A judge that wants the
 * content has read_file and the paths. The patch is opt-in and capped.
 */

import { relative, isAbsolute } from 'node:path'
import type { TurnDiffTracker, TurnDiffEntry } from '../../infra/fs/TurnDiffTracker.js'

export interface TurnDiffSectionOptions {
  /** Workspace root, used to render paths relative rather than absolute. */
  workspaceRoot?: string
  /**
   * Paths another source (the git snapshot diff) already showed the judge.
   * Entries matching these are dropped — repeating them would spend tokens to
   * say something the judge was already told, and would bury the part that is
   * genuinely new.
   */
  coveredPaths?: ReadonlySet<string>
  /** Include a truncated unified patch under the stat block. Default: false. */
  includePatch?: boolean
  /** Hard cap on the rendered section. Default 4000 (stat) / 16000 (patch). */
  maxChars?: number
}

const DEFAULT_STAT_CHARS = 4_000
const DEFAULT_PATCH_CHARS = 16_000

/** Normalise a tracked absolute path to workspace-relative for display/matching. */
function displayPath(path: string, workspaceRoot?: string): string {
  if (!workspaceRoot || !isAbsolute(path)) return path
  const rel = relative(workspaceRoot, path)
  return rel && !rel.startsWith('..') ? rel : path
}

/**
 * Filenames from a `git diff --stat` block.
 *
 * Parsed leniently and used ONLY to suppress duplication: a miss costs a
 * repeated file in the judge's context, never a missing one. That asymmetry is
 * why a fragile-looking parse is acceptable here — it can only ever make the
 * output more verbose, not less correct.
 */
export function pathsInGitStat(stat: string): Set<string> {
  const out = new Set<string>()
  for (const line of stat.split('\n')) {
    // ` path/to/file.ts | 12 +++---`  — the summary line has no pipe, so it is
    // skipped naturally.
    const pipe = line.indexOf('|')
    if (pipe <= 0) continue
    const name = line.slice(0, pipe).trim()
    if (!name) continue
    // Renames render as `old => new` or `dir/{a => b}/file`; record the raw
    // form plus the halves, so either spelling suppresses a duplicate.
    out.add(name)
    const arrow = name.split('=>')
    if (arrow.length === 2) {
      out.add(arrow[0]!.trim().replace(/\{$/, '').trim())
      out.add(arrow[1]!.trim().replace(/^\}/, '').replace(/\}$/, '').trim())
    }
  }
  return out
}

function statLine(entry: TurnDiffEntry, workspaceRoot?: string): string {
  const marker =
    entry.status === 'added' ? '新增'
      : entry.status === 'deleted' ? '删除'
      : '修改'
  const path = displayPath(entry.path, workspaceRoot)
  if (entry.oversized) return `  ${marker} ${path}  (文件过大，未生成 diff)`
  return `  ${marker} ${path}  +${entry.added} -${entry.removed}`
}

/**
 * Render the tracker's changes as a judge-ready section, or null when there is
 * nothing worth saying.
 *
 * Returning null rather than an empty-state string is deliberate: "no changes"
 * from THIS source is not evidence of anything, because the tracker only sees
 * tool writes. The judge must not read a tracker miss as "the executor did
 * nothing" — the git diff is the source that can say that.
 */
export async function renderTurnDiffSection(
  tracker: TurnDiffTracker,
  options: TurnDiffSectionOptions = {},
): Promise<string | null> {
  let summary
  try {
    summary = await tracker.summary()
  } catch {
    // A tracker failure must never break a gate. The judge simply does not get
    // this supplementary view.
    return null
  }

  const covered = options.coveredPaths
  const changed = summary.entries.filter(e => {
    if (e.status === 'unchanged') return false
    if (!covered || covered.size === 0) return true
    const rel = displayPath(e.path, options.workspaceRoot)
    return !covered.has(rel) && !covered.has(e.path)
  })
  if (changed.length === 0) return null

  const maxChars = options.maxChars
    ?? (options.includePatch ? DEFAULT_PATCH_CHARS : DEFAULT_STAT_CHARS)

  const header = covered && covered.size > 0
    ? '【git 看不到的改动（工具直接写入，可能位于 .gitignore 内或不在 git 仓库中）】'
    : '【本次运行的文件改动（由写入工具记录，与 git 状态无关）】'

  const lines: string[] = [header]
  const totals = changed.reduce(
    (acc, e) => ({ added: acc.added + e.added, removed: acc.removed + e.removed }),
    { added: 0, removed: 0 },
  )
  lines.push(`${changed.length} 个文件，+${totals.added} -${totals.removed}`)

  let used = lines.join('\n').length
  let shown = 0
  for (const entry of changed) {
    const line = statLine(entry, options.workspaceRoot)
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length + 1
    shown++
  }
  if (shown < changed.length) {
    lines.push(`  …另有 ${changed.length - shown} 个文件未列出（超出篇幅上限）`)
  }

  if (options.includePatch) {
    const patch = await renderPatch(tracker, changed, maxChars - used, options.workspaceRoot)
    if (patch) lines.push('', patch)
  }

  return lines.join('\n')
}

/** Unified diff for the listed entries, bounded by the remaining char budget. */
async function renderPatch(
  tracker: TurnDiffTracker,
  changed: readonly TurnDiffEntry[],
  budget: number,
  workspaceRoot?: string,
): Promise<string | null> {
  if (budget < 400) return null
  const paths = new Set(changed.map(e => e.path))
  try {
    // Render the whole tracker, then keep only the blocks for entries that
    // survived the `coveredPaths` filter — the tracker renders per file, so
    // slicing by path is exact rather than heuristic.
    const full = await tracker.render({ context: 2, maxChars: budget })
    if (!full || full.startsWith('No file changes')) return null
    const blocks = full.split(/\n(?=[AMD] )/).filter(block => {
      const first = block.split('\n')[0] ?? ''
      return [...paths].some(p =>
        first.includes(p) || first.includes(displayPath(p, workspaceRoot)),
      )
    })
    return blocks.length ? blocks.join('\n') : null
  } catch {
    return null
  }
}
