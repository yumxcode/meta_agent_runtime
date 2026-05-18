/**
 * JobStore — persists EngineeringJob records to disk.
 *
 * Storage path: ~/.meta-agent/jobs/{sessionId}/{jobId}.json
 *
 * Each job is a single JSON file written atomically via core/persist utilities
 * (write to a .tmp file, then rename) so a crash mid-write never leaves
 * a corrupted record.
 */

import { join } from 'path'
import { homedir } from 'os'
import { atomicWriteJson, readJsonFile, listJsonIds, deleteJsonFile } from '../core/persist/index.js'
import type { EngineeringJob, JobId } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────

function jobsRoot(): string {
  return join(homedir(), '.meta-agent', 'jobs')
}

function sessionDir(sessionId: string): string {
  return join(jobsRoot(), sessionId)
}

function jobPath(sessionId: string, jobId: JobId): string {
  return join(sessionDir(sessionId), `${jobId}.json`)
}

// ─────────────────────────────────────────────────────────────────────────────

export class JobStore {
  private readonly sessionId: string

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  /**
   * Persist (create or overwrite) a job record atomically.
   */
  async save(job: EngineeringJob): Promise<void> {
    await atomicWriteJson(jobPath(this.sessionId, job.jobId), job)
  }

  /**
   * Load a single job by ID. Returns null if not found.
   */
  async load(jobId: JobId): Promise<EngineeringJob | null> {
    return readJsonFile<EngineeringJob>(jobPath(this.sessionId, jobId))
  }

  /**
   * Load all jobs for this session. Skips corrupt or unreadable files.
   */
  async loadAll(): Promise<EngineeringJob[]> {
    const dir = sessionDir(this.sessionId)
    const ids = await listJsonIds(dir)
    const results = await Promise.allSettled(
      ids.map(id => readJsonFile<EngineeringJob>(jobPath(this.sessionId, id as JobId))),
    )
    return results
      .filter((r): r is PromiseFulfilledResult<EngineeringJob | null> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter((j): j is EngineeringJob => j !== null)
  }

  /**
   * Delete a job record from disk. No-op if not found.
   */
  async delete(jobId: JobId): Promise<void> {
    await deleteJsonFile(jobPath(this.sessionId, jobId))
  }

  /** Convenience: check if a job exists on disk. */
  async exists(jobId: JobId): Promise<boolean> {
    return (await this.load(jobId)) !== null
  }
}
