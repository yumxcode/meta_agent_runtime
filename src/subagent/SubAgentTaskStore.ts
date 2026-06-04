/**
 * SubAgentTaskStore — file-based persistence for sub-agent task records
 *
 * Each task is stored as a JSON file at:
 *   ~/.meta-agent/subtasks/<taskId>.json
 *
 * Write-chain serialisation:
 *   Concurrent writes to the same taskId are serialised through a per-taskId
 *   Promise chain (same pattern as compact/stateSnapshot.ts).  Only the latest
 *   snapshot matters — if two writes race, the second always wins cleanly.
 *
 * Cleanup:
 *   releaseWriteChain() clears in-memory write bookkeeping while keeping the
 *   JSON record. cleanupTask() additionally unlinks the file.
 */

import { unlink } from 'fs/promises'
import { homedir } from 'os'
import { META_AGENT_HOME } from '../core/metaAgentHome.js'
import { join } from 'path'
import { atomicWriteJson, readJsonFile, ensureDir } from '../core/persist/index.js'
import { TERMINAL_STATUSES, type SubAgentRecord, type SubAgentTaskId } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Storage path
// ─────────────────────────────────────────────────────────────────────────────

function subtaskDir(): string {
  return join(META_AGENT_HOME, 'subtasks')
}

function taskPath(taskId: SubAgentTaskId): string {
  return join(subtaskDir(), `${taskId}.json`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: per-taskId write chain (serialises concurrent writes)
// ─────────────────────────────────────────────────────────────────────────────

const _writeChains = new Map<SubAgentTaskId, Promise<void>>()
const DEFAULT_TERMINAL_TASK_TTL_MS = 14 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_TERMINAL_TASKS = 1_000

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a task record.  Returns null when the file does not exist or is corrupt.
 */
export async function readTask(
  taskId: SubAgentTaskId,
): Promise<SubAgentRecord | null> {
  return readJsonFile<SubAgentRecord>(taskPath(taskId))
}

/**
 * Write (create or overwrite) a task record.
 *
 * Writes are serialised per taskId — concurrent callers chain onto the
 * previous write promise so the file is never written in parallel.
 *
 * Returns the Promise for this write. Awaiting callers observe write failures;
 * the internal chain still recovers so later writes are not blocked.
 */
export function writeTask(record: SubAgentRecord): Promise<void> {
  const taskId = record.taskId

  const doWrite = async () => {
    await ensureDir(subtaskDir())
    await atomicWriteJson(taskPath(taskId), record)
  }

  const prev = _writeChains.get(taskId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(doWrite)
  _writeChains.set(taskId, next.catch(err => {
    console.error(`[SubAgentTaskStore] Write failed for ${taskId}:`, err)
  }))
  return next
}

/**
 * Release the in-memory write chain for a task after all pending writes drain.
 * This keeps terminal task records on disk while preventing long-running
 * processes from retaining one Promise chain per historical task.
 */
export async function releaseWriteChain(taskId: SubAgentTaskId): Promise<void> {
  await (_writeChains.get(taskId) ?? Promise.resolve()).catch(() => {})
  _writeChains.delete(taskId)
}

/**
 * Delete the task file and clear its write chain.
 *
 * Should be called in the SubAgentRunner's finally block after the task
 * reaches a terminal state and the main agent has acknowledged the result.
 */
export async function cleanupTask(taskId: SubAgentTaskId): Promise<void> {
  // Drain any pending writes first
  await releaseWriteChain(taskId)
  try {
    await unlink(taskPath(taskId))
  } catch {
    // File may not exist — ignore
  }
}

export interface CleanupTerminalTasksOptions {
  ttlMs?: number
  maxTerminalTasks?: number
}

/**
 * Prune old terminal sub-agent records from the flat global subtask directory.
 * Active records are never deleted.  This keeps listTasksForSession() from
 * turning into an O(all historical tasks) scan in long-lived hosts.
 */
export async function cleanupTerminalTasks(
  options: CleanupTerminalTasksOptions = {},
): Promise<number> {
  const ttlMs = options.ttlMs ?? envInt(
    'META_AGENT_SUBTASK_TTL_MS',
    DEFAULT_TERMINAL_TASK_TTL_MS,
    0,
    365 * 24 * 60 * 60 * 1000,
  )
  const maxTerminalTasks = options.maxTerminalTasks ?? envInt(
    'META_AGENT_MAX_TERMINAL_SUBTASKS',
    DEFAULT_MAX_TERMINAL_TASKS,
    0,
    100_000,
  )
  const { readdir } = await import('fs/promises')
  let entries: string[]
  try {
    entries = await readdir(subtaskDir())
  } catch {
    return 0
  }

  const now = Date.now()
  const terminal: Array<{ taskId: SubAgentTaskId; completedAt: number }> = []
  let removed = 0

  await Promise.allSettled(
    entries
      .filter(e => e.endsWith('.json'))
      .map(async e => {
        const taskId = e.replace(/\.json$/, '') as SubAgentTaskId
        const record = await readTask(taskId)
        if (!record || !TERMINAL_STATUSES.has(record.status)) return
        const completedAt = record.completedAt ?? record.createdAt
        if (ttlMs > 0 && now - completedAt > ttlMs) {
          await cleanupTask(taskId)
          removed++
          return
        }
        terminal.push({ taskId, completedAt })
      }),
  )

  if (maxTerminalTasks >= 0 && terminal.length > maxTerminalTasks) {
    terminal.sort((a, b) => a.completedAt - b.completedAt)
    const overflow = terminal.length - maxTerminalTasks
    await Promise.allSettled(
      terminal.slice(0, overflow).map(async rec => {
        await cleanupTask(rec.taskId)
        removed++
      }),
    )
  }

  return removed
}

/**
 * List all task records for a given parent session.
 *
 * Reads every .json file in the subtasks directory and filters by
 * parentSessionId.  Gracefully skips corrupt files.
 */
export async function listTasksForSession(
  parentSessionId: string,
): Promise<SubAgentRecord[]> {
  const { readdir } = await import('fs/promises')
  try {
    const entries = await readdir(subtaskDir())
    const records: SubAgentRecord[] = []
    await Promise.allSettled(
      entries
        .filter(e => e.endsWith('.json'))
        .map(async e => {
          const taskId = e.replace(/\.json$/, '') as SubAgentTaskId
          const record = await readTask(taskId)
          if (record && record.parentSessionId === parentSessionId) {
            records.push(record)
          }
        }),
    )
    return records.sort((a, b) => a.createdAt - b.createdAt)
  } catch {
    return []
  }
}
