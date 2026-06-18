/**
 * Kernel-side checkpoint boundary contract.
 *
 * The kernel reports consistent execution boundaries; the session/router layer
 * owns checkpoint contents and persistence. This keeps the kernel independent
 * of auto-mode storage paths and UI state stores.
 */

export type CheckpointBoundaryType =
  | 'tool_batch_completed'
  | 'compact_before'
  | 'compact_after'
  | 'verify_rejected'
  | 'drift_corrected'
  | 'external_before'
  | 'external_after'
  | 'termination'
  | 'dispose'

export interface CheckpointBoundaryEvent {
  type: CheckpointBoundaryType
  sessionId: string
  /** Session-lifetime count of completed tool batches. */
  toolBatchCount: number
  /** Cumulative session cost known at this boundary. */
  estimatedCostUsd: number
  /** Successful tools in the just-completed batch, when applicable. */
  successfulToolNames?: string[]
  /** Tool names requiring a before/after external-operation boundary. */
  externalToolNames?: string[]
  /** Termination reason for terminal boundaries. */
  stopReason?: string
}

export interface CheckpointBoundaryResult {
  /** Whether a new durable checkpoint revision was written. */
  updated: boolean
  /** Latest durable revision after handling this boundary. */
  revision: number
}

export type CheckpointBoundaryFn = (
  event: CheckpointBoundaryEvent,
) => Promise<CheckpointBoundaryResult>
