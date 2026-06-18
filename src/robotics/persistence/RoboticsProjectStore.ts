import { createHash } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'
import { META_AGENT_HOME } from '../../core/metaAgentHome.js'
import { appendFile, readdir, rm } from 'fs/promises'
import { atomicWriteJson, readJsonFile } from '../../core/persist/index.js'
import { withFileLock } from '../../infra/persist/index.js'
import type { RoboticsProjectState, RoboticsProjectSummary, ActiveSubAgentRecord, RoboticsGitState } from '../types.js'

const PROJECTS_ROOT    = join(META_AGENT_HOME, 'robotics', 'projects')
const RESUME_WINDOW_MS = 30 * 24 * 60 * 60 * 1000   // 30 days — hard cap for resume
const STALE_TTL_MS     =  7 * 24 * 60 * 60 * 1000   // 7 days  — auto-purge for non-starred
const MAX_PROGRESS_NOTES = 15                         // rolling window, oldest evicted first
const MAX_COMPLETED_TASK_IDS = 50

// ── Path helpers ──────────────────────────────────────────────────────────────
//
// Storage layout:
//   <PROJECTS_ROOT>/<sha1(projectDir)>/<sessionId>/state.json
//
// One state file per (project, session) pair.  Different sessions for the same
// project never share progress notes — each session's R5 is fully isolated.
// The bucket dir groups sessions by project for listAll() and purgeStale().

function projectHash(projectDir: string): string {
  return createHash('sha1').update(projectDir).digest('hex').slice(0, 16)
}

function projectBucketDir(dir: string): string {
  return join(PROJECTS_ROOT, projectHash(dir))
}

function stateFile(dir: string, sessionId: string): string {
  return join(projectBucketDir(dir), sessionId, 'state.json')
}

function completedTaskArchiveFile(dir: string, sessionId: string): string {
  return join(projectBucketDir(dir), sessionId, 'completed-subagents.jsonl')
}

// ── RoboticsProjectStore ──────────────────────────────────────────────────────

export class RoboticsProjectStore {

  // ── Read ────────────────────────────────────────────────────────────────────

  /**
   * Find the most recent valid session state for a project directory.
   *
   * Enumerates all session subdirs under the project bucket and returns the
   * one with the highest lastActiveAt that is still within the 30-day resume
   * window.  Used by the --resume flow when no specific sessionId is known.
   */
  static async findLatestByProjectDir(dir: string): Promise<RoboticsProjectState | null> {
    const bucket = projectBucketDir(dir)
    let sessionDirs: string[]
    try {
      sessionDirs = await readdir(bucket)
    } catch {
      return null
    }

    const states = await Promise.all(
      sessionDirs.map(async sid => {
        const state = await readJsonFile<RoboticsProjectState>(join(bucket, sid, 'state.json'))
        if (!state || state.schemaVersion !== '1.0') return null
        if (Date.now() - state.lastActiveAt > RESUME_WINDOW_MS) return null
        return state
      }),
    )

    const valid = (states.filter(Boolean) as RoboticsProjectState[])
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)

    return valid[0] ?? null
  }

  /**
   * Find a specific session's state by (projectDir, sessionId).
   *
   * Used by all mutation methods to load-modify-save atomically, and by
   * RoboticsSession.init() on exact-match resume (e.g. session picker).
   */
  static async findBySession(dir: string, sessionId: string): Promise<RoboticsProjectState | null> {
    const state = await readJsonFile<RoboticsProjectState>(stateFile(dir, sessionId))
    if (!state || state.schemaVersion !== '1.0') return null
    if (Date.now() - state.lastActiveAt > RESUME_WINDOW_MS) return null
    return state
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /** Atomically persist state.  Path is derived from state.projectDir + state.sessionId. */
  static async save(state: RoboticsProjectState): Promise<void> {
    const path = stateFile(state.projectDir, state.sessionId)
    await withFileLock(path, async () => {
      await RoboticsProjectStore.writeNormalizedState(state)
    })
  }

  /** Update lastActiveAt for an active session (heartbeat). */
  static async touch(projectDir: string, sessionId: string): Promise<void> {
    await RoboticsProjectStore.mutate(projectDir, sessionId, state => {
      state.lastActiveAt = Date.now()
    })
  }

  /**
   * Append a progress note to the session's rolling buffer.
   *
   * Buffer is capped at MAX_PROGRESS_NOTES (15).  When the cap is exceeded the
   * oldest entries are evicted so the most recent context is always visible in R5.
   */
  static async appendProgress(projectDir: string, sessionId: string, note: string): Promise<void> {
    await RoboticsProjectStore.mutate(projectDir, sessionId, state => {
      state.progressNotes.push(`[${new Date().toISOString().slice(0, 16)}] ${note}`)
      if (state.progressNotes.length > MAX_PROGRESS_NOTES) {
        state.progressNotes = state.progressNotes.slice(-MAX_PROGRESS_NOTES)
      }
    })
  }

  static async registerSubAgentTask(
    dir: string,
    sessionId: string,
    record: ActiveSubAgentRecord,
  ): Promise<void> {
    await RoboticsProjectStore.mutate(dir, sessionId, state => {
      state.activeSubAgentTasks = state.activeSubAgentTasks.filter(t => t.taskId !== record.taskId)
      state.activeSubAgentTasks.push(record)
    })
  }

  /**
   * Mark a sub-agent task finished: drop it from activeSubAgentTasks and record
   * its id in completedSubAgentTaskIds.
   *
   * `clearGitRefs` ALSO removes the task's `subAgentBranches`/`forkPoints` entries
   * so the per-project git state doesn't accumulate one entry per completed task
   * forever (the P1-3 residual). It must ONLY be set by the FINALIZATION tools
   * (git_merge_subagent / git_discard_subagent), which read the branch name
   * BEFORE calling this. It is left false for experiment_dispatch / paper_search
   * completion, where the branch is still PENDING a later merge and the merge
   * tool needs `subAgentBranches[taskId]` to survive.
   */
  static async completeSubAgentTask(
    dir: string,
    sessionId: string,
    taskId: string,
    opts: { clearGitRefs?: boolean } = {},
  ): Promise<void> {
    await RoboticsProjectStore.mutate(dir, sessionId, state => {
      state.activeSubAgentTasks = state.activeSubAgentTasks.filter(t => t.taskId !== taskId)
      if (!state.completedSubAgentTaskIds.includes(taskId)) {
        state.completedSubAgentTaskIds.push(taskId)
      }
      if (opts.clearGitRefs) {
        delete state.git.subAgentBranches[taskId]
        delete state.git.forkPoints[taskId]
      }
    })
  }

  /**
   * Remove a stale sub-agent task that could not be reconciled on session resume.
   * Clears the task from activeSubAgentTasks, subAgentBranches, and forkPoints.
   * Does NOT add to completedSubAgentTaskIds — stale tasks were never finished.
   */
  static async purgeStaleSubAgentTask(
    dir: string,
    sessionId: string,
    taskId: string,
  ): Promise<void> {
    await RoboticsProjectStore.mutate(dir, sessionId, state => {
      state.activeSubAgentTasks = state.activeSubAgentTasks.filter(t => t.taskId !== taskId)
      delete state.git.subAgentBranches[taskId]
      delete state.git.forkPoints[taskId]
    })
  }

  static async updateGitState(
    dir: string,
    sessionId: string,
    git: Partial<RoboticsGitState>,
  ): Promise<void> {
    await RoboticsProjectStore.mutate(dir, sessionId, state => {
      state.git = {
        ...state.git,
        ...git,
        subAgentBranches: { ...state.git.subAgentBranches, ...(git.subAgentBranches ?? {}) },
        forkPoints:       { ...state.git.forkPoints,       ...(git.forkPoints       ?? {}) },
      }
    })
  }

  // ── Session management ───────────────────────────────────────────────────────

  /**
   * List all persisted sessions across all projects, sorted by lastActiveAt
   * descending (most recent first).
   *
   * Enumerates two levels: <bucket>/<sessionId>/state.json
   */
  static async listAll(): Promise<RoboticsProjectSummary[]> {
    let buckets: string[]
    try {
      buckets = await readdir(PROJECTS_ROOT)
    } catch {
      return []
    }

    const results: (RoboticsProjectSummary | null)[] = []

    await Promise.all(
      buckets.map(async bucket => {
        const bucketPath = join(PROJECTS_ROOT, bucket)
        let sessionDirs: string[]
        try {
          sessionDirs = await readdir(bucketPath)
        } catch {
          return
        }

        await Promise.all(
          sessionDirs.map(async sid => {
            const state = await readJsonFile<RoboticsProjectState>(
              join(bucketPath, sid, 'state.json'),
            )
            if (!state || state.schemaVersion !== '1.0') return
            const idleDays = Math.floor((Date.now() - state.lastActiveAt) / 86_400_000)
            results.push({
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
            } satisfies RoboticsProjectSummary)
          }),
        )
      }),
    )

    return (results.filter(Boolean) as RoboticsProjectSummary[])
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  /**
   * Set or clear the star flag for a specific session.
   * Starred sessions are exempt from 7-day auto-purge.
   */
  static async star(projectDir: string, sessionId: string, starred: boolean): Promise<void> {
    await RoboticsProjectStore.mutate(projectDir, sessionId, state => {
      state.starred = starred
    })
  }

  /**
   * Replace the tag list for a specific session.
   * Pass an empty array to clear all tags.
   */
  static async setTags(projectDir: string, sessionId: string, tags: string[]): Promise<void> {
    await RoboticsProjectStore.mutate(projectDir, sessionId, state => {
      state.tags = tags
    })
  }

  static async setCurrentPhase(
    projectDir: string,
    sessionId: string,
    currentPhase: string | undefined,
  ): Promise<void> {
    await RoboticsProjectStore.mutate(projectDir, sessionId, state => {
      state.currentPhase = currentPhase
    })
  }

  static async setAgentMode(
    projectDir: string,
    sessionId: string,
    agentMode: RoboticsProjectState['agentMode'],
  ): Promise<void> {
    await RoboticsProjectStore.mutate(projectDir, sessionId, state => {
      state.agentMode = agentMode
    })
  }

  /**
   * Delete session dirs that are not starred and have been idle for more than
   * STALE_TTL_MS (7 days).  Operates on individual session dirs — the project
   * bucket may become empty but is left in place (harmless, cleaned on next purge).
   *
   * @returns Number of session dirs purged.
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
        const bucketPath = join(PROJECTS_ROOT, bucket)
        let sessionDirs: string[]
        try {
          sessionDirs = await readdir(bucketPath)
        } catch {
          return
        }

        await Promise.allSettled(
          sessionDirs.map(async sid => {
            const sessionDir = join(bucketPath, sid)
            const state = await readJsonFile<RoboticsProjectState>(
              join(sessionDir, 'state.json'),
            )
            if (!state || state.schemaVersion !== '1.0') return
            if (state.starred) return                              // ← starred: exempt
            if (now - state.lastActiveAt < STALE_TTL_MS) return   // ← active within 7 days
            await rm(sessionDir, { recursive: true, force: true })
            purged++
          }),
        )
      }),
    )

    return purged
  }

  private static async mutate(
    projectDir: string,
    sessionId: string,
    mutate: (state: RoboticsProjectState) => void | Promise<void>,
  ): Promise<void> {
    const path = stateFile(projectDir, sessionId)
    await withFileLock(path, async () => {
      const state = await readJsonFile<RoboticsProjectState>(path)
      if (!state || state.schemaVersion !== '1.0') return
      if (Date.now() - state.lastActiveAt > RESUME_WINDOW_MS) return
      await mutate(state)
      await RoboticsProjectStore.writeNormalizedState(state)
    })
  }

  private static async writeNormalizedState(state: RoboticsProjectState): Promise<void> {
    const overflow = state.completedSubAgentTaskIds.slice(0, -MAX_COMPLETED_TASK_IDS)
    if (overflow.length > 0) {
      const archivePath = completedTaskArchiveFile(state.projectDir, state.sessionId)
      const archivedAt = Date.now()
      await appendFile(
        archivePath,
        overflow
          .map(taskId => JSON.stringify({ taskId, archivedAt }))
          .join('\n') + '\n',
        'utf-8',
      )
      state.completedSubAgentTaskIds =
        state.completedSubAgentTaskIds.slice(-MAX_COMPLETED_TASK_IDS)
    }
    await atomicWriteJson(stateFile(state.projectDir, state.sessionId), state)
  }
}
