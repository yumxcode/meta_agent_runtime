/**
 * Shared durable backing for the three robotics review buffers
 * (experiences / physical anchors / principles).
 *
 * All three had the same two defects, written out three times:
 *
 *   1. **No cross-process lock, and a blind full-snapshot overwrite.**
 *      `atomicWriteJson` guarantees you never see half a file; it does not
 *      guarantee you do not erase someone else's file. Each store held its queue
 *      in memory and wrote that array over whatever was on disk, so with two
 *      writers — `meta-agent` and `meta-agent-glm` on one project, two CLI
 *      windows, concurrent sub-agents all calling `experience_write` — the last
 *      writer silently deleted the other's proposals. The pending buffer is the
 *      landing point for "AI proposes at high recall, a human decides at high
 *      precision"; a lost proposal is a lost observation, and nobody ever learns
 *      it existed.
 *
 *   2. **Silent persistence failure.** The write chain was bracketed by two
 *      empty `.catch(() => {})`, so ENOSPC / EACCES / a read-only mount produced
 *      no signal at all. The in-memory `count` still said "N awaiting review" and
 *      the CLI still printed "run /experience review next time", while nothing
 *      had reached disk. The one catch swallowed the only evidence the user could
 *      have acted on.
 *
 * Both are fixed once, here, instead of three times in three files.
 *
 * ## Merge semantics
 *
 * Union by `pendingId`, with this process's view authoritative for ids it knows:
 *
 *   keep = (on-disk entries this process has never seen) ∪ (our current queue)
 *
 * Tracking "ids we have seen" is what makes removal work. A plain union with
 * disk would resurrect every entry the user just reviewed and discarded, since
 * that entry is still in the file we are merging against. Restricting our
 * authority to ids we actually loaded or added means concurrent proposals from
 * another process survive, while our own deletions stick.
 */

import { rm } from 'fs/promises'
import { atomicWriteJson, readJsonFile, withFileLock } from '../infra/persist/index.js'

export interface PendingEntryLike {
  pendingId: string
  proposedAt: number
}

/** Lock/merge/write engine shared by the three pending stores. */
export class PendingSnapshotWriter<T extends PendingEntryLike> {
  /**
   * Every pendingId this process has loaded or created. Ids outside this set
   * belong to another writer and are never dropped by our merge.
   */
  private readonly _known = new Set<string>()
  private _degraded: string | null = null
  private _warned = false

  constructor(
    private readonly filePath: string | null,
    private readonly maxEntries: number,
    private readonly label: string,
    private readonly isValid: (value: unknown) => value is T,
  ) {}

  /** Record ids this process is responsible for (on load, and on each add). */
  observe(entries: readonly T[]): void {
    for (const entry of entries) this._known.add(entry.pendingId)
  }

  observeId(pendingId: string): void {
    this._known.add(pendingId)
  }

  /**
   * True when a write has failed and the on-disk queue is behind memory.
   *
   * Callers that tell the user "N items are waiting for review" must consult
   * this, because under a failed write that sentence is false.
   */
  get degradedReason(): string | null {
    return this._degraded
  }

  async persist(snapshot: readonly T[]): Promise<void> {
    if (!this.filePath) return
    const path = this.filePath
    try {
      await withFileLock(path, async () => {
        const onDisk = await readJsonFile<unknown>(path)
        const foreign = Array.isArray(onDisk)
          ? onDisk.filter((item): item is T => this.isValid(item) && !this._known.has(item.pendingId))
          : []
        const merged = [...foreign, ...snapshot]
          .sort((a, b) => a.proposedAt - b.proposedAt || a.pendingId.localeCompare(b.pendingId))
        // Trim the OLDEST first, matching each store's own _trimToLimit, so a
        // merge that overflows the cap discards by age rather than by which
        // process happened to write last.
        const capped = merged.length > this.maxEntries ? merged.slice(-this.maxEntries) : merged
        if (capped.length === 0) {
          await rm(path, { force: true }).catch(() => undefined)
          return
        }
        await atomicWriteJson(path, capped)
      })
      this._degraded = null
    } catch (error) {
      this._degraded = error instanceof Error ? error.message : String(error)
      if (!this._warned) {
        this._warned = true
        console.warn(
          `[${this.label}] could not persist the pending review queue: ${this._degraded}\n` +
          '  Items proposed in this session are held in memory only and will be lost on exit.',
        )
      }
    }
  }
}
