import { createHash } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'
import { readdir, rm } from 'fs/promises'
import { atomicWriteJson, readJsonFile } from '../../core/persist/index.js'
import type { RoboticsProjectState, RoboticsProjectSummary, ActiveSubAgentRecord, RoboticsGitState } from '../types.js'

const PROJECTS_ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'projects')
const RESUME_WINDOW_MS  = 30 * 24 * 60 * 60 * 1000   // 30 days — hard cap for resume
const STALE_TTL_MS      =  7 * 24 * 60 * 60 * 1000   // 7 days  — auto-purge for non-starred
const MAX_PROGRESS_NOTES = 10

function projectHash(projectDir: string): string {
  return createHash('sha1').update(projectDir).digest('hex').slice(0, 16)
}

function projectBucketDir(dir: string): string {
  return join(PROJECTS_ROOT, projectHash(dir))
}

function stateFile(dir: string): string {
  return join(projectBucketDir(dir), 'state.json')
}

export class RoboticsProjectStore {
  static async findByProjectDir(dir: string): Promise<RoboticsProjectState | null> {
    const state = await readJsonFile<RoboticsProjectState>(stateFile(dir))
    if (!state || state.schemaVersion !== '1.0') return null
    if (Date.now() - state.lastActiveAt > RESUME_WINDOW_MS) return null
    return state
  }

  static async save(state: RoboticsProjectState): Promise<void> {
    await atomicWriteJson(stateFile(state.projectDir), state)
  }

  static async touch(projectDir: string): Promise<void> {
    const state = await RoboticsProjectStore.findByProjectDir(projectDir)
    if (state) {
      state.lastActiveAt = Date.now()
      await RoboticsProjectStore.save(state)
    }
  }

  static async appendProgress(projectDir: string, note: string): Promise<void> {
    const state = await RoboticsProjectStore.findByProjectDir(projectDir)
    if (!state) return
    state.progressNotes.push(`[${new Date().toISOString().slice(0, 16)}] ${note}`)
    if (state.progressNotes.length > MAX_PROGRESS_NOTES) {
      state.progressNotes = state.progressNotes.slice(-MAX_PROGRESS_NOTES)
    }
    await RoboticsProjectStore.save(state)
  }

  static async registerSubAgentTask(dir: string, record: ActiveSubAgentRecord): Promise<void> {
    const state = await RoboticsProjectStore.findByProjectDir(dir)
    if (!state) return
    state.activeSubAgentTasks = state.activeSubAgentTasks.filter(t => t.taskId !== record.taskId)
    state.activeSubAgentTasks.push(record)
    await RoboticsProjectStore.save(state)
  }

  static async completeSubAgentTask(dir: string, taskId: string): Promise<void> {
    const state = await RoboticsProjectStore.findByProjectDir(dir)
    if (!state) return
    state.activeSubAgentTasks = state.activeSubAgentTasks.filter(t => t.taskId !== taskId)
    if (!state.completedSubAgentTaskIds.includes(taskId)) {
      state.completedSubAgentTaskIds.push(taskId)
    }
    await RoboticsProjectStore.save(state)
  }

  /**
   * Remove a stale sub-agent task that could not be reconciled on session resume.
   * Clears the task from activeSubAgentTasks, subAgentBranches, and forkPoints.
   * Does NOT add to completedSubAgentTaskIds — stale tasks were never finished.
   */
  static async purgeStaleSubAgentTask(dir: string, taskId: string): Promise<void> {
    const state = await RoboticsProjectStore.findByProjectDir(dir)
    if (!state) return
    state.activeSubAgentTasks = state.activeSubAgentTasks.filter(t => t.taskId !== taskId)
    delete state.git.subAgentBranches[taskId]
    delete state.git.forkPoints[taskId]
    await RoboticsProjectStore.save(state)
  }

  static async updateGitState(dir: string, git: Partial<RoboticsGitState>): Promise<void> {
    const state = await RoboticsProjectStore.findByProjectDir(dir)
    if (!state) return
    state.git = {
      ...state.git,
      ...git,
      subAgentBranches: { ...state.git.subAgentBranches, ...(git.subAgentBranches ?? {}) },
      forkPoints: { ...state.git.forkPoints, ...(git.forkPoints ?? {}) },
    }
    await RoboticsProjectStore.save(state)
  }

  // ── Session management ───────────────────────────────────────────────────────

  /**
   * List all persisted sessions, sorted by lastActiveAt descending (most recent first).
   * Reads every bucket under PROJECTS_ROOT; silently skips corrupt entries.
   */
  static async listAll(): Promise<RoboticsProjectSummary[]> {
    let buckets: string[]
    try {
      buckets = await readdir(PROJECTS_ROOT)
    } catch {
      return []   // directory doesn't exist yet
    }

    const results = await Promise.all(
      buckets.map(async bucket => {
        const file = join(PROJECTS_ROOT, bucket, 'state.json')
        const state = await readJsonFile<RoboticsProjectState>(file)
        if (!state || state.schemaVersion !== '1.0') return null
        const idleDays = Math.floor((Date.now() - state.lastActiveAt) / 86_400_000)
        return {
          projectDir:   state.projectDir,
          sessionId:    state.sessionId,
          robot:        state.robot,
          createdAt:    state.createdAt,
          lastActiveAt: state.lastActiveAt,
          starred:      state.starred ?? false,
          tags:         state.tags ?? [],
          currentPhase: state.currentPhase,
          agentMode:    state.agentMode,
          idleDays,
        } satisfies RoboticsProjectSummary
      }),
    )

    return (results.filter(Boolean) as RoboticsProjectSummary[])
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  /**
   * Set or clear the star flag for a session.
   * Starred sessions are exempt from 7-day auto-purge.
   */
  static async star(projectDir: string, starred: boolean): Promise<void> {
    const state = await RoboticsProjectStore.findByProjectDir(projectDir)
    if (!state) return
    state.starred = starred
    await RoboticsProjectStore.save(state)
  }

  /**
   * Replace the tag list for a session.
   * Pass an empty array to clear all tags.
   */
  static async setTags(projectDir: string, tags: string[]): Promise<void> {
    const state = await RoboticsProjectStore.findByProjectDir(projectDir)
    if (!state) return
    state.tags = tags
    await RoboticsProjectStore.save(state)
  }

  /**
   * Delete sessions that are not starred and have been idle for more than
   * STALE_TTL_MS (7 days).  Safe to call at startup — reads all buckets,
   * skips starred or recently-active ones, removes the rest.
   *
   * @returns Number of sessions purged.
   */
  static async purgeStale(): Promise<number> {
    let buckets: string[]
    try {
      buckets = await readdir(PROJECTS_ROOT)
    } catch {
      return 0
    }

    const now = Date.now()
    let purged = 0

    await Promise.allSettled(
      buckets.map(async bucket => {
        const bucketDir = join(PROJECTS_ROOT, bucket)
        const file = join(bucketDir, 'state.json')
        const state = await readJsonFile<RoboticsProjectState>(file)
        if (!state || state.schemaVersion !== '1.0') return
        if (state.starred) return                                    // ← starred: exempt
        if (now - state.lastActiveAt < STALE_TTL_MS) return         // ← active within 7 days
        await rm(bucketDir, { recursive: true, force: true })
        purged++
      }),
    )

    return purged
  }
}
