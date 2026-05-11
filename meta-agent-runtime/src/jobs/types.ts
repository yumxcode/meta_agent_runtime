/**
 * Async Job System — core types
 *
 * Engineering simulations can run for hours. The job system decouples
 * tool submission from result delivery so the agent main loop stays
 * responsive while long-running work executes in the background.
 *
 * State machine:
 *
 *   SUBMITTED → QUEUED → RUNNING → COMPLETED
 *                                └→ FAILED
 *              cancel() from any non-terminal state → CANCELLED
 */

// ─────────────────────────────────────────────────────────────────────────────
// Job ID
// ─────────────────────────────────────────────────────────────────────────────

/** Globally unique job ID — format: `{domain}-{type}-{uuid8}` */
export type JobId = string

/** Generate a job ID from a domain + tool name pair */
export function makeJobId(domain: string, toolName: string): JobId {
  const uuid8 = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const safe = (s: string) => s.replace(/[^a-z0-9]/gi, '_').toLowerCase()
  return `${safe(domain)}-${safe(toolName)}-${uuid8}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Job status state machine
// ─────────────────────────────────────────────────────────────────────────────

export type JobStatus =
  | 'submitted'   // immediately after submit() — not yet executing
  | 'queued'      // waiting for compute slot
  | 'running'     // actively executing
  | 'completed'   // finished successfully
  | 'failed'      // finished with error
  | 'cancelled'   // aborted by cancel()

export const TERMINAL_STATUSES = new Set<JobStatus>(['completed', 'failed', 'cancelled'])
export const ACTIVE_STATUSES   = new Set<JobStatus>(['submitted', 'queued', 'running'])

// ─────────────────────────────────────────────────────────────────────────────
// Dimensional record (Phase 1 placeholder — upgraded to typed PhysicalQuantity
// when the units system is built in a later step)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I/O record for engineering tools.
 * Currently untyped; will become `Record<string, PhysicalQuantity | scalar>`
 * once the units/PhysicalQuantity module is implemented.
 */
export type DimensionalRecord = Record<string, unknown>

// ─────────────────────────────────────────────────────────────────────────────
// Job artifact (file produced by the job)
// ─────────────────────────────────────────────────────────────────────────────

export interface JobArtifact {
  artifactId: string
  name: string          // human-readable filename
  path: string          // absolute path on disk
  mimeType?: string
  sizeBytes?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Job metrics
// ─────────────────────────────────────────────────────────────────────────────

export interface JobMetrics {
  submittedAt: number       // epoch ms
  startedAt?: number
  completedAt?: number
  wallTimeMs?: number       // total wall-clock duration
  cpuTimeMs?: number        // CPU time (if measurable)
}

// ─────────────────────────────────────────────────────────────────────────────
// Core job entity
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineeringJob {
  jobId: JobId
  toolName: string          // name of the tool that spawned this job
  domain: string            // engineering domain (e.g. 'battery', 'mechanical')
  fidelityLevel: number     // 0-4 per FidelityLevel enum (defined in Phase 3)
  input: DimensionalRecord  // verbatim tool input (archived for provenance)
  status: JobStatus
  metrics: JobMetrics
  agentId: string           // which agent submitted this job
  sessionId: string
  /** Error message if status === 'failed' */
  error?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress update (yielded by long-running jobs)
// ─────────────────────────────────────────────────────────────────────────────

export interface JobProgress {
  jobId: JobId
  percent: number           // 0–100
  currentStep: string       // e.g. "Meshing geometry…"
  eta?: number              // estimated seconds remaining
  intermediateResults?: DimensionalRecord
}

// ─────────────────────────────────────────────────────────────────────────────
// Job result
// ─────────────────────────────────────────────────────────────────────────────

export interface JobResult {
  jobId: JobId
  status: 'completed' | 'failed' | 'cancelled'
  /** Structured output (undefined if failed / cancelled) */
  output?: DimensionalRecord
  /** Plain-text summary for the model */
  summary?: string
  artifacts: JobArtifact[]
  metrics: JobMetrics
  /** Points to a ProvenanceRecord (filled in when provenance module is added) */
  provenanceId?: string
  /** Error message (if status === 'failed') */
  error?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Job context — passed into tool handlers at execution time
// ─────────────────────────────────────────────────────────────────────────────

export interface JobContext {
  jobId: JobId
  sessionId: string
  agentId: string
  domain: string
  fidelityLevel: number
  abortSignal: AbortSignal
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress reporter — handed to the job handler so it can stream progress
// ─────────────────────────────────────────────────────────────────────────────

export type ProgressReporter = (progress: Omit<JobProgress, 'jobId'>) => void

// ─────────────────────────────────────────────────────────────────────────────
// Job handler — the async function executed by JobExecutor
// ─────────────────────────────────────────────────────────────────────────────

export type JobHandler = (
  input: DimensionalRecord,
  context: JobContext,
  reportProgress: ProgressReporter,
) => Promise<Pick<JobResult, 'output' | 'summary' | 'artifacts'>>

// ─────────────────────────────────────────────────────────────────────────────
// Cost estimate (optional, tools may provide this)
// ─────────────────────────────────────────────────────────────────────────────

export interface JobCostEstimate {
  estimatedWallTimeMs: number
  computeUnits?: number
  notes?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter for JobManager.list()
// ─────────────────────────────────────────────────────────────────────────────

export interface JobFilter {
  agentId?: string
  sessionId?: string
  domain?: string
  status?: JobStatus[]
  toolName?: string
}
