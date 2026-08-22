/**
 * TurnDiffTracker — what changed on disk during one turn, and how to undo it.
 *
 * The problem
 * -----------
 * A turn that calls `write_file` twice, `edit_file` three times and `bash` once
 * produces six tool results, each saying something like "Replaced 1
 * occurrence(s)". Nowhere in the transcript is the ONE thing a reviewer
 * actually wants: the net change to the working tree. Reconstructing it means
 * reading every file the turn mentioned and comparing against a memory of what
 * they used to say — which is exactly the thing neither a human nor a model
 * can do reliably.
 *
 * `git diff` answers this only when the workspace is a clean git repo, which is
 * not a property the runtime can require: robotics workspaces routinely hold
 * datasets, build outputs and vendored trees that are deliberately untracked,
 * and half the interesting edits happen in files git was told to ignore.
 *
 * How it works
 * ------------
 * Baselines are captured LAZILY, immediately before the first mutation of a
 * path in the current turn. That ordering is the whole design:
 *
 *   - Capturing at turn START would mean reading every file the turn *might*
 *     touch — unknowable — or snapshotting the tree, which is unbounded.
 *   - Capturing AFTER the write has lost the information.
 *
 * So each write tool announces its intent (`capture(path)`) and the tracker
 * reads the old bytes once. Repeat mutations of the same path in the same turn
 * are no-ops: the baseline is the state at turn start, not at last write.
 *
 * Revert restores those baselines. It is a turn-granularity undo — the unit a
 * reviewer thinks in ("that last round of edits was wrong") — not a general
 * version-control replacement.
 */

import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { unifiedDiff, diffStat } from './unifiedDiff.js'

/**
 * Files larger than this are tracked as "changed" but not diffed.
 *
 * A 200MB rosbag or model checkpoint has no reviewable diff, and holding two
 * copies of it in memory to prove that is a way to OOM the host during what the
 * user experiences as "showing me my changes".
 */
const MAX_TRACKED_BYTES = 2 * 1024 * 1024

export interface TurnDiffEntry {
  path: string
  /** Contents at turn start; null when the file did not exist. */
  before: string | null
  /** Contents now; null when the file no longer exists. */
  after: string | null
  status: 'added' | 'modified' | 'deleted' | 'unchanged'
  added: number
  removed: number
  /** True when the file was too large to diff; before/after are null. */
  oversized: boolean
}

export interface TurnDiffSummary {
  turnId: string
  entries: TurnDiffEntry[]
  filesChanged: number
  linesAdded: number
  linesRemoved: number
}

export interface RevertOutcome {
  restored: string[]
  removed: string[]
  failed: { path: string; error: string }[]
}

interface Baseline {
  content: string | null
  oversized: boolean
}

export class TurnDiffTracker {
  private baselines = new Map<string, Baseline>()
  private turnId = 'turn-0'
  private counter = 0

  /** Drop everything and start a fresh turn. Returns the new turn id. */
  beginTurn(turnId?: string): string {
    this.baselines.clear()
    this.counter++
    this.turnId = turnId ?? `turn-${this.counter}`
    return this.turnId
  }

  get currentTurnId(): string {
    return this.turnId
  }

  /** Paths mutated so far this turn, in first-touch order. */
  trackedPaths(): string[] {
    return [...this.baselines.keys()]
  }

  /**
   * Record the pre-mutation state of `path`. Idempotent within a turn.
   *
   * Deliberately never throws: a tracker failure must not be able to abort the
   * write it was only observing. A missing baseline degrades the diff for one
   * file; a thrown error from here would fail the user's actual edit.
   */
  async capture(path: string): Promise<void> {
    if (this.baselines.has(path)) return
    try {
      const info = await stat(path)
      if (!info.isFile()) {
        this.baselines.set(path, { content: null, oversized: false })
        return
      }
      if (info.size > MAX_TRACKED_BYTES) {
        this.baselines.set(path, { content: null, oversized: true })
        return
      }
      this.baselines.set(path, { content: await readFile(path, 'utf-8'), oversized: false })
    } catch {
      // Does not exist yet → the baseline IS "absent", which is what makes an
      // added file render as an addition rather than as a modification of ''.
      this.baselines.set(path, { content: null, oversized: false })
    }
  }

  /** Capture several paths concurrently (a patch touching many files). */
  async captureAll(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map(p => this.capture(p)))
  }

  /** Read current state and compare against the captured baselines. */
  async summary(): Promise<TurnDiffSummary> {
    const entries: TurnDiffEntry[] = []
    let linesAdded = 0
    let linesRemoved = 0

    for (const [path, baseline] of this.baselines) {
      let after: string | null = null
      let oversized = baseline.oversized
      try {
        const info = await stat(path)
        if (info.isFile()) {
          if (info.size > MAX_TRACKED_BYTES) oversized = true
          else after = await readFile(path, 'utf-8')
        }
      } catch {
        after = null
      }

      if (oversized) {
        entries.push({
          path, before: null, after: null,
          status: 'modified', added: 0, removed: 0, oversized: true,
        })
        continue
      }

      const before = baseline.content
      const status: TurnDiffEntry['status'] =
        before === null && after === null ? 'unchanged'
          : before === null ? 'added'
          : after === null ? 'deleted'
          : before === after ? 'unchanged'
          : 'modified'

      const { added, removed } = diffStat(before ?? '', after ?? '')
      linesAdded += added
      linesRemoved += removed
      entries.push({ path, before, after, status, added, removed, oversized: false })
    }

    const changed = entries.filter(e => e.status !== 'unchanged')
    return {
      turnId: this.turnId,
      entries,
      filesChanged: changed.length,
      linesAdded,
      linesRemoved,
    }
  }

  /**
   * Render the turn's net change as a unified diff.
   *
   * `maxChars` exists because this text goes into a model's context or a
   * terminal: a truthful 400KB diff that blows the context budget is not more
   * useful than a truthful 8KB diff plus a list of what was elided.
   */
  async render(opts: { context?: number; maxChars?: number } = {}): Promise<string> {
    const summary = await this.summary()
    const changed = summary.entries.filter(e => e.status !== 'unchanged')
    if (changed.length === 0) return 'No file changes in this turn.'

    const maxChars = opts.maxChars ?? 32_000
    const header =
      `${summary.filesChanged} file(s) changed, ` +
      `+${summary.linesAdded} -${summary.linesRemoved}  [${summary.turnId}]`

    const blocks: string[] = []
    const elided: string[] = []
    let used = header.length

    for (const entry of changed) {
      if (entry.oversized) {
        elided.push(`${entry.path} (too large to diff)`)
        continue
      }
      const body = unifiedDiff(entry.before ?? '', entry.after ?? '', entry.path, {
        ...(opts.context !== undefined ? { context: opts.context } : {}),
        oldLabel: entry.status === 'added' ? '/dev/null' : `a/${entry.path}`,
        newLabel: entry.status === 'deleted' ? '/dev/null' : `b/${entry.path}`,
      })
      const block = `\n${statusMarker(entry)} ${entry.path}\n${body}`
      if (used + block.length > maxChars) {
        elided.push(`${entry.path} (+${entry.added} -${entry.removed})`)
        continue
      }
      used += block.length
      blocks.push(block)
    }

    const parts = [header, ...blocks]
    if (elided.length) {
      parts.push(`\n[${elided.length} file(s) not shown: ${elided.join(', ')}]`)
    }
    return parts.join('\n')
  }

  /**
   * Restore every tracked path to its turn-start state.
   *
   * Best-effort per path: one unwritable file must not strand the other five in
   * a half-reverted state with no report of which is which. The outcome names
   * every failure so the caller can finish by hand.
   */
  async revert(): Promise<RevertOutcome> {
    const outcome: RevertOutcome = { restored: [], removed: [], failed: [] }

    for (const [path, baseline] of this.baselines) {
      if (baseline.oversized) {
        outcome.failed.push({
          path,
          error: 'not reverted: file was too large to snapshot',
        })
        continue
      }
      try {
        if (baseline.content === null) {
          // Did not exist at turn start → undoing means removing it. `force`
          // keeps this idempotent when the turn already deleted it.
          await rm(path, { force: true })
          outcome.removed.push(path)
        } else {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, baseline.content, 'utf-8')
          outcome.restored.push(path)
        }
      } catch (err) {
        outcome.failed.push({
          path,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // The turn's changes are gone, so the baselines describing them are stale.
    // Leaving them would let a second revert "restore" a state that no longer
    // has any relationship to the tree.
    if (outcome.failed.length === 0) this.baselines.clear()
    return outcome
  }
}

function statusMarker(entry: TurnDiffEntry): string {
  switch (entry.status) {
    case 'added': return 'A'
    case 'deleted': return 'D'
    case 'modified': return 'M'
    default: return ' '
  }
}

export const TURN_DIFF_LIMITS = { MAX_TRACKED_BYTES } as const
