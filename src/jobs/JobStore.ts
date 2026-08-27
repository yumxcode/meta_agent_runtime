/**
 * JobStore — persists EngineeringJob records to disk.
 *
 * Storage path: ~/.meta-agent/jobs/{sessionId}/{jobId}.json
 *
 * Each job is a single JSON file written atomically via core/persist utilities
 * (write to a .tmp file, then rename) so a crash mid-write never leaves
 * a corrupted record.
 *
 * Path safety: `sessionId` and `jobId` become path segments, and JobStore is
 * exported from the package root, so both are treated as untrusted input.
 * They are validated on the way in and the resolved path is re-checked for
 * containment on the way out — see `infra/persist/storeId.ts` for why both
 * halves are needed.
 */

import { join } from 'path'
import {
  atomicWriteJson,
  readJsonFile,
  listJsonIds,
  deleteJsonFile,
  mapWithConcurrency,
  DEFAULT_READ_CONCURRENCY,
} from '../infra/persist/index.js'
import { validateStoreId, isValidStoreId, resolveWithinRoot } from '../infra/persist/storeId.js'
import { META_AGENT_HOME } from '../core/metaAgentHome.js'
import { EngineeringJobSchema, parseOrNull } from '../infra/persist/schemas.js'
import type { EngineeringJob, JobId } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────

function jobsRoot(): string {
  return join(META_AGENT_HOME, 'jobs')
}

function sessionDir(sessionId: string): string {
  return resolveWithinRoot(jobsRoot(), validateStoreId(sessionId, 'sessionId'))
}

function jobPath(sessionId: string, jobId: JobId): string {
  return resolveWithinRoot(sessionDir(sessionId), `${validateStoreId(jobId, 'jobId')}.json`)
}

// ─────────────────────────────────────────────────────────────────────────────

export class JobStore {
  private readonly sessionId: string

  /**
   * @throws {StoreIdError} if `sessionId` is not a safe path segment. Failing
   *   in the constructor means an invalid id can never reach a write or an
   *   `rm()` — the store simply cannot be built.
   */
  constructor(sessionId: string) {
    this.sessionId = validateStoreId(sessionId, 'sessionId')
  }

  /**
   * Persist (create or overwrite) a job record atomically.
   *
   * @throws {StoreIdError} if `job.jobId` is not a safe path segment.
   */
  async save(job: EngineeringJob): Promise<void> {
    await atomicWriteJson(jobPath(this.sessionId, job.jobId), job)
  }

  /**
   * Load a single job by ID.
   * Returns null if the file is not found OR if Zod validation fails (corrupt record).
   *
   * @throws {StoreIdError} if `jobId` is not a safe path segment.
   */
  async load(jobId: JobId): Promise<EngineeringJob | null> {
    const raw = await readJsonFile<unknown>(jobPath(this.sessionId, jobId))
    if (raw === null) return null
    return parseOrNull(EngineeringJobSchema, raw) as EngineeringJob | null
  }

  /**
   * Load all jobs for this session. Skips corrupt or unreadable files.
   *
   * Reads are bounded (P2-4): a session that accumulated thousands of job
   * records used to open every one of them in a single `Promise.allSettled`,
   * which exhausts the descriptor table before it exhausts memory.
   *
   * Directory entries whose names are not valid ids are skipped rather than
   * throwing — a stray file in the jobs directory should not make recovery
   * fail for every other record.
   */
  async loadAll(): Promise<EngineeringJob[]> {
    const dir = sessionDir(this.sessionId)
    const ids = (await listJsonIds(dir)).filter(isValidStoreId)
    const results = await mapWithConcurrency(ids, DEFAULT_READ_CONCURRENCY, id =>
      readJsonFile<unknown>(jobPath(this.sessionId, id as JobId), { tolerateUnreadable: true }),
    )
    return results
      .filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
      .map(r => r.value)
      .map(raw => parseOrNull(EngineeringJobSchema, raw) as EngineeringJob | null)
      .filter((j): j is EngineeringJob => j !== null)
  }

  /**
   * Delete a job record from disk. No-op if not found.
   *
   * @throws {StoreIdError} if `jobId` is not a safe path segment.
   */
  async delete(jobId: JobId): Promise<void> {
    await deleteJsonFile(jobPath(this.sessionId, jobId))
  }

  /** Convenience: check if a job exists on disk. */
  async exists(jobId: JobId): Promise<boolean> {
    return (await this.load(jobId)) !== null
  }
}
