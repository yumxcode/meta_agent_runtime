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
/** Globally unique job ID — format: `{domain}-{type}-{uuid8}` */
export type JobId = string;
/** Generate a job ID from a domain + tool name pair */
export declare function makeJobId(domain: string, toolName: string): JobId;
export type JobStatus = 'submitted' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export declare const TERMINAL_STATUSES: Set<JobStatus>;
export declare const ACTIVE_STATUSES: Set<JobStatus>;
/**
 * I/O record for engineering tools.
 * Currently untyped; will become `Record<string, PhysicalQuantity | scalar>`
 * once the units/PhysicalQuantity module is implemented.
 */
export type DimensionalRecord = Record<string, unknown>;
export interface JobArtifact {
    artifactId: string;
    name: string;
    path: string;
    mimeType?: string;
    sizeBytes?: number;
}
export interface JobMetrics {
    submittedAt: number;
    startedAt?: number;
    completedAt?: number;
    wallTimeMs?: number;
    cpuTimeMs?: number;
}
export interface EngineeringJob {
    jobId: JobId;
    toolName: string;
    domain: string;
    fidelityLevel: number;
    input: DimensionalRecord;
    status: JobStatus;
    metrics: JobMetrics;
    agentId: string;
    sessionId: string;
    /** Error message if status === 'failed' */
    error?: string;
}
export interface JobProgress {
    jobId: JobId;
    percent: number;
    currentStep: string;
    eta?: number;
    intermediateResults?: DimensionalRecord;
}
export interface JobResult {
    jobId: JobId;
    status: 'completed' | 'failed' | 'cancelled';
    /** Structured output (undefined if failed / cancelled) */
    output?: DimensionalRecord;
    /** Plain-text summary for the model */
    summary?: string;
    artifacts: JobArtifact[];
    metrics: JobMetrics;
    /** Points to a ProvenanceRecord (filled in when provenance module is added) */
    provenanceId?: string;
    /** Error message (if status === 'failed') */
    error?: string;
}
export interface JobContext {
    jobId: JobId;
    sessionId: string;
    agentId: string;
    domain: string;
    fidelityLevel: number;
    abortSignal: AbortSignal;
}
export type ProgressReporter = (progress: Omit<JobProgress, 'jobId'>) => void;
export type JobHandler = (input: DimensionalRecord, context: JobContext, reportProgress: ProgressReporter) => Promise<Pick<JobResult, 'output' | 'summary' | 'artifacts'>>;
export interface JobCostEstimate {
    estimatedWallTimeMs: number;
    computeUnits?: number;
    notes?: string;
}
export interface JobFilter {
    agentId?: string;
    sessionId?: string;
    domain?: string;
    status?: JobStatus[];
    toolName?: string;
}
//# sourceMappingURL=types.d.ts.map