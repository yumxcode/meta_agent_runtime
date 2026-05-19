/**
 * ExperiencePendingStore — session-scoped buffer for AI-proposed experiences.
 *
 * When the AI calls experience_write, the entry is held here instead of
 * committing directly to the shared ExperienceStore.  The user reviews
 * pending entries via the `/experience review` REPL command (or at session
 * end when cleanup is triggered).
 *
 * Only approved entries are committed to the cross-session ExperienceStore.
 * This prevents low-quality, premature, or incorrect experiences from
 * polluting the shared knowledge base.
 *
 * Storage: in-memory only (pending entries don't survive a crash — that is
 * intentional; a crashed session's unreviewed entries are simply lost rather
 * than auto-committed).
 */

import type { ExperienceStore } from './ExperienceStore.js'
import type { RoboticsDomain } from './types.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingExperience {
  /** Temporary pending ID (not the final ExperienceStore ID). */
  pendingId: string
  proposedAt: number
  /** Raw input exactly as the AI provided to experience_write. */
  input: Record<string, unknown>
}

// ── ExperiencePendingStore ────────────────────────────────────────────────────

export class ExperiencePendingStore {
  private readonly _pending: PendingExperience[] = []

  /** Queue an experience for later review. Returns the temporary pending ID. */
  add(input: Record<string, unknown>): string {
    const pendingId = `pending_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    this._pending.push({ pendingId, proposedAt: Date.now(), input })
    return pendingId
  }

  /** All pending entries in proposal order. */
  list(): readonly PendingExperience[] {
    return this._pending
  }

  /** Number of pending entries awaiting review. */
  get count(): number {
    return this._pending.length
  }

  /** Remove one pending entry (after commit or discard). */
  remove(pendingId: string): boolean {
    const idx = this._pending.findIndex(p => p.pendingId === pendingId)
    if (idx < 0) return false
    this._pending.splice(idx, 1)
    return true
  }

  /** Clear all pending entries (e.g. on session end after review). */
  clear(): void {
    this._pending.length = 0
  }

  /**
   * Commit one pending entry to the ExperienceStore.
   * Returns the committed experience ID, or null on failure.
   */
  async commit(pendingId: string, store: ExperienceStore): Promise<string | null> {
    const entry = this._pending.find(p => p.pendingId === pendingId)
    if (!entry) return null

    try {
      const input = entry.input
      const id = await store.write({
        domain: (input['domain'] as RoboticsDomain) ?? 'general',
        title: String(input['title'] ?? ''),
        problem: String(input['problem'] ?? ''),
        solution: String(input['solution'] ?? ''),
        outcome: {
          success: Boolean(input['success']),
          summary: String(input['outcome_summary'] ?? ''),
          failureReason: input['failure_reason'] as string | undefined,
          workarounds: input['workarounds'] as string[] | undefined,
        },
        algorithm: input['algorithm'] as string | undefined,
        tags: (input['tags'] as string[] | undefined) ?? [],
        robot: input['robot'] as string | undefined,
        difficulty: (input['difficulty'] as 'low' | 'medium' | 'high' | undefined) ?? 'medium',
        metrics: input['metrics'] as Record<string, number | string> | undefined,
        relatedPapers: input['related_papers'] as string[] | undefined,
        sourceTaskId: input['source_task_id'] as string | undefined,
        fullReport: input['full_report'] as string | undefined,
      })
      this.remove(pendingId)
      return id
    } catch {
      return null
    }
  }
}
