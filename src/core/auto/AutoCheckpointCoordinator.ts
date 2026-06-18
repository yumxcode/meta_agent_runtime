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

export interface AutoCheckpointCoordinatorDeps {
  projectDir: string
  getSnapshot: (sessionId: string) => AutoCheckpointSnapshot
  initialRevision?: number
  initialToolBatchCount?: number
}

export class AutoCheckpointCoordinator {
  private drainPromise: Promise<void> | null = null
  private pendingEvent: CheckpointBoundaryEvent | null = null
  private revision: number
  private toolBatchCount: number
  private estimatedCostUsd = 0

  constructor(private readonly deps: AutoCheckpointCoordinatorDeps) {
    this.revision = deps.initialRevision ?? 0
    this.toolBatchCount = deps.initialToolBatchCount ?? 0
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
          },
        )
        if (!writeResult.written) continue
        const cp = writeResult.checkpoint
        this.revision = cp.revision ?? this.revision + 1
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
