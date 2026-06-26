/**
 * AutoCheckpointCoordinator — single-writer checkpoint assembly.
 *
 * KernelLoop reports consistent execution boundaries. This coordinator gathers
 * the current trusted session state (todo/progress/artifacts/sub-agents), writes
 * one atomic checkpoint revision, and serialises concurrent flush requests.
 */
import type {
  CheckpointBoundaryEvent,
  CheckpointBoundaryResult,
} from '../../kernel/loop/CheckpointBoundary.js'
import { updateAutoCheckpointWithStatus } from './AutoCheckpointStore.js'

export interface AutoCheckpointSnapshot {
  goal?: string
  completedSteps: string[]
  pendingTodos: string[]
  note?: string
  artifacts: string[]
  activeSubAgentIds: string[]
}

/** State tools whose presence means the agent gave an explicit progress update. */
const CHECKPOINT_STATE_TOOLS = new Set(['todo_write', 'progress_note', 'artifacts_register'])

/** Default consecutive FS-only checkpoints before an edit digest is generated. */
const DEFAULT_FS_ONLY_DIGEST_THRESHOLD = 10

export interface AutoCheckpointCoordinatorDeps {
  projectDir: string
  getSnapshot: (sessionId: string) => AutoCheckpointSnapshot
  initialRevision?: number
  initialToolBatchCount?: number
  /**
   * Optional digest generator. Invoked at most once per `fsOnlyDigestThreshold`
   * consecutive FS-only checkpoints (file edits with no todo/progress/artifacts
   * update in between), with the accumulated changed-file paths. Fire-and-forget:
   * the resolved one-line digest is folded into the NEXT checkpoint write, so it
   * never blocks the kernel. Return null to skip.
   */
  summarizeEdits?: (paths: string[]) => Promise<string | null>
  /** Consecutive FS-only checkpoints before a digest is generated. Default 10. */
  fsOnlyDigestThreshold?: number
  /** Resume seed for the monotonic run-health counters (from the prior checkpoint). */
  initialRunHealth?: {
    verifyRejections?: number
    driftCorrections?: number
    compactions?: number
    lastVerifyRejectTurn?: number
    lastDriftCorrectionTurn?: number
  }
}

export class AutoCheckpointCoordinator {
  private drainPromise: Promise<void> | null = null
  private pendingEvent: CheckpointBoundaryEvent | null = null
  private revision: number
  private toolBatchCount: number
  private estimatedCostUsd = 0

  // ── FS-only edit-digest accumulation ────────────────────────────────────────
  /** Consecutive FS-only checkpoints since the last digest or state update. */
  private fsOnlyStreak = 0
  /** Files mutated during the current FS-only streak (deduped). */
  private readonly accumPaths = new Set<string>()
  /** A generated digest awaiting fold-in to the next checkpoint write. */
  private pendingEditSummary: string | null = null
  /** Guards against overlapping digest generations. */
  private summaryInFlight = false
  /**
   * Bumped by resetRunScopedState(). An in-flight digest captures the generation
   * at fire time and only writes its result if the generation still matches — so
   * a digest about the OLD task's files can never land in a NEW goal's checkpoint.
   */
  private runGeneration = 0
  private readonly fsOnlyDigestThreshold: number

  // ── Run-health counters (monotonic) ─────────────────────────────────────────
  private verifyRejections: number
  private driftCorrections: number
  private compactions: number
  private lastVerifyRejectTurn: number | undefined
  private lastDriftCorrectionTurn: number | undefined

  constructor(private readonly deps: AutoCheckpointCoordinatorDeps) {
    this.revision = deps.initialRevision ?? 0
    this.toolBatchCount = deps.initialToolBatchCount ?? 0
    this.fsOnlyDigestThreshold = deps.fsOnlyDigestThreshold ?? DEFAULT_FS_ONLY_DIGEST_THRESHOLD
    const h = deps.initialRunHealth
    this.verifyRejections = h?.verifyRejections ?? 0
    this.driftCorrections = h?.driftCorrections ?? 0
    this.compactions = h?.compactions ?? 0
    this.lastVerifyRejectTurn = h?.lastVerifyRejectTurn
    this.lastDriftCorrectionTurn = h?.lastDriftCorrectionTurn
  }

  get latestRevision(): number {
    return this.revision
  }

  get latestToolBatchCount(): number {
    return this.toolBatchCount
  }

  /**
   * Write a checkpoint for a kernel boundary. Requests are serialised so a
   * dispose racing a terminal boundary cannot interleave atomic renames.
   */
  async flush(event: CheckpointBoundaryEvent): Promise<CheckpointBoundaryResult> {
    const before = this.revision
    this.toolBatchCount = Math.max(this.toolBatchCount, event.toolBatchCount)
    this.estimatedCostUsd = Math.max(this.estimatedCostUsd, event.estimatedCostUsd)
    // Per-event bookkeeping runs here (not in _drain) so coalesced boundaries are
    // not double-counted — each boundary type calls flush() once per occurrence.
    if (event.type === 'tool_batch_completed') this._trackFsOnlyStreak(event)
    this._trackRunHealth(event)
    this.pendingEvent = this._mergeEvents(this.pendingEvent, event)
    if (!this.drainPromise) {
      // One microtask of coalescing collapses adjacent before/after/tool-state
      // boundaries into a single durable write.
      this.drainPromise = Promise.resolve().then(() => this._drain())
    }
    try {
      await this.drainPromise
    } catch {
      // Checkpoint persistence is best-effort and must never replace the real
      // execution result. Keep the previous durable revision on failure.
    }
    return { updated: this.revision > before, revision: this.revision }
  }

  /** Force the confirmed dispose boundary using the latest observed counters. */
  flushDispose(sessionId: string): Promise<CheckpointBoundaryResult> {
    return this.flush({
      type: 'dispose',
      sessionId,
      toolBatchCount: this.toolBatchCount,
      estimatedCostUsd: this.estimatedCostUsd,
    })
  }

  /**
   * Clear all RUN-SCOPED state when the session re-anchors to a NEW top-level
   * goal, so the next task is judged on its own terms and the prior task's record
   * cannot leak into the new goal's checkpoint:
   *   • run-health counters + turn stamps (verify/drift/compact),
   *   • the FS-only digest streak, accumulated paths, and any pending digest.
   *
   * Deliberately does NOT touch `revision` / `toolBatchCount`: those are the
   * MONOTONIC durable-write counters that must stay consistent with KernelSession
   * and the on-disk record — zeroing them is exactly what caused drift starvation.
   * Bumping `runGeneration` invalidates any in-flight digest from the old task.
   */
  resetRunScopedState(): void {
    this.runGeneration++
    this.verifyRejections = 0
    this.driftCorrections = 0
    this.compactions = 0
    this.lastVerifyRejectTurn = undefined
    this.lastDriftCorrectionTurn = undefined
    this.fsOnlyStreak = 0
    this.accumPaths.clear()
    this.pendingEditSummary = null
    this.summaryInFlight = false
  }

  /**
   * Update the FS-only streak for a tool_batch_completed boundary. A batch that
   * touched an explicit state tool resets the streak (the agent gave a real
   * update). An FS-only batch accumulates its changed paths and counts toward the
   * digest threshold; on crossing it, a digest is generated fire-and-forget and
   * folded into a later write.
   */
  private _trackFsOnlyStreak(event: CheckpointBoundaryEvent): void {
    const names = event.successfulToolNames ?? []
    if (names.some(n => CHECKPOINT_STATE_TOOLS.has(n))) {
      this.fsOnlyStreak = 0
      this.accumPaths.clear()
      return
    }
    for (const p of event.mutatedPaths ?? []) this.accumPaths.add(p)
    this.fsOnlyStreak++
    if (
      this.fsOnlyStreak >= this.fsOnlyDigestThreshold &&
      !this.summaryInFlight &&
      this.deps.summarizeEdits &&
      this.accumPaths.size > 0
    ) {
      const paths = [...this.accumPaths]
      this.fsOnlyStreak = 0
      this.accumPaths.clear()
      this.summaryInFlight = true
      const generation = this.runGeneration
      // Fire-and-forget: a digest LLM call must never block the kernel turn. The
      // result folds into the next checkpoint write (checkpoints are frequent
      // during active editing) via this.pendingEditSummary — but only if the run
      // generation is unchanged (a re-anchor in between discards a stale digest).
      void this.deps.summarizeEdits(paths)
        .then(text => {
          if (text && text.trim() && generation === this.runGeneration) {
            this.pendingEditSummary = text.trim()
          }
        })
        .catch(() => { /* best-effort: a failed digest just leaves state empty */ })
        .finally(() => { if (generation === this.runGeneration) this.summaryInFlight = false })
    }
  }

  /**
   * Increment the monotonic run-health counters for lifecycle boundaries. These
   * are deterministic facts (how many rejections/corrections/compactions, and how
   * recently) that the drift gate uses to judge run trajectory. Compactions count
   * on `compact_before` only, so the before/after pair is not double-counted.
   */
  private _trackRunHealth(event: CheckpointBoundaryEvent): void {
    switch (event.type) {
      case 'verify_rejected':
        this.verifyRejections++
        this.lastVerifyRejectTurn = this.toolBatchCount
        break
      case 'drift_corrected':
        this.driftCorrections++
        this.lastDriftCorrectionTurn = this.toolBatchCount
        break
      case 'compact_before':
        this.compactions++
        break
      default:
        break
    }
  }

  private async _drain(): Promise<void> {
    try {
      while (this.pendingEvent) {
        const event = this.pendingEvent
        this.pendingEvent = null
        const snapshot = this.deps.getSnapshot(event.sessionId)
        const writeResult = await updateAutoCheckpointWithStatus(
          this.deps.projectDir,
          event.sessionId,
          {
            goal: snapshot.goal,
            completedSteps: snapshot.completedSteps,
            pendingTodos: snapshot.pendingTodos,
            note: snapshot.note,
            artifacts: snapshot.artifacts,
            activeSubAgentIds: snapshot.activeSubAgentIds,
            turnCount: this.toolBatchCount,
            estimatedCostUsd: this.estimatedCostUsd,
            stopReason: event.stopReason,
            lastBoundary: event.type,
            // Fold in any digest produced since the last write; undefined lets
            // updateAutoCheckpointWithStatus carry the prior value forward.
            autoEditSummary: this.pendingEditSummary ?? undefined,
            // Run-health counters (absolute current values; store keeps them monotonic).
            verifyRejections: this.verifyRejections,
            driftCorrections: this.driftCorrections,
            compactions: this.compactions,
            lastVerifyRejectTurn: this.lastVerifyRejectTurn,
            lastDriftCorrectionTurn: this.lastDriftCorrectionTurn,
          },
        )
        if (!writeResult.written) continue
        const cp = writeResult.checkpoint
        this.revision = cp.revision ?? this.revision + 1
        // Clear only after a successful write so a failed write retries the digest.
        if (this.pendingEditSummary) this.pendingEditSummary = null
      }
    } finally {
      this.drainPromise = null
    }
  }

  private _mergeEvents(
    current: CheckpointBoundaryEvent | null,
    next: CheckpointBoundaryEvent,
  ): CheckpointBoundaryEvent {
    if (!current) return next
    return {
      ...next,
      toolBatchCount: Math.max(current.toolBatchCount, next.toolBatchCount),
      estimatedCostUsd: Math.max(current.estimatedCostUsd, next.estimatedCostUsd),
      successfulToolNames: [...new Set([
        ...(current.successfulToolNames ?? []),
        ...(next.successfulToolNames ?? []),
      ])],
      externalToolNames: [...new Set([
        ...(current.externalToolNames ?? []),
        ...(next.externalToolNames ?? []),
      ])],
      stopReason: next.stopReason ?? current.stopReason,
    }
  }
}
