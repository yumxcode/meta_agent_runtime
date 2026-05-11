/**
 * JobStore — persists EngineeringJob records to disk.
 *
 * Storage path: ~/.meta-agent/jobs/{sessionId}/{jobId}.json
 *
 * Each job is a single JSON file. On save, the file is written atomically
 * (write to a .tmp file, then rename) so a crash mid-write never leaves
 * a corrupted record.
 *
 * The store is intentionally simple — no database, no index file. On startup,
 * loadSession() reads all .json files in the session directory and returns
 * them as an array. This is fast enough for the expected job counts (< 1000
 * per session).
 */

import { readFile, writeFile, readdir, mkdir, rename, unlink } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
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

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class JobStore {
  private readonly sessionId: string

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  /**
   * Persist (create or overwrite) a job record.
   * Uses a write-then-rename pattern for atomicity.
   */
  async save(job: EngineeringJob): Promise<void> {
    const dir = sessionDir(this.sessionId)
    await ensureDir(dir)

    const target = jobPath(this.sessionId, job.jobId)
    const tmp    = `${target}.tmp`
    const json   = JSON.stringify(job, null, 2)

    await writeFile(tmp, json, 'utf-8')
    await rename(tmp, target)
  }

  /**
   * Load a single job by ID. Returns null if not found.
   */
  async load(jobId: JobId): Promise<EngineeringJob | null> {
    const path = jobPath(this.sessionId, jobId)
    try {
      const raw = await readFile(path, 'utf-8')
      return JSON.parse(raw) as EngineeringJob
    } catch (err: any) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  }

  /**
   * Load all jobs for this session. Skips corrupt or unreadable files.
   */
  async loadAll(): Promise<EngineeringJob[]> {
    const dir = sessionDir(this.sessionId)
    if (!existsSync(dir)) return []

    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return []
    }

    const jobs: EngineeringJob[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const path = join(dir, entry)
      try {
        const raw = await readFile(path, 'utf-8')
        jobs.push(JSON.parse(raw) as EngineeringJob)
      } catch {
        // skip corrupt files silently
      }
    }
    return jobs
  }

  /**
   * Delete a job record from disk. No-op if not found.
   */
  async delete(jobId: JobId): Promise<void> {
    const path = jobPath(this.sessionId, jobId)
    try {
      await unlink(path)
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  /** Convenience: check if a job exists on disk. */
  async exists(jobId: JobId): Promise<boolean> {
    return (await this.load(jobId)) !== null
  }
}
