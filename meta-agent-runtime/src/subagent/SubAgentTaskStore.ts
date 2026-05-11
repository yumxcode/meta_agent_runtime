/**
 * SubAgentTaskStore — file-based persistence for sub-agent task records
 *
 * Each task is stored as a JSON file at:
 *   ~/.claude/meta-agent/subtasks/<taskId>.json
 *
 * Write-chain serialisation:
 *   Concurrent writes to the same taskId are serialised through a per-taskId
 *   Promise chain (same pattern as compact/stateSnapshot.ts).  Only the latest
 *   snapshot matters — if two writes race, the second always wins cleanly.
 *
 * Cleanup:
 *   cleanupTask() unlinks the file and clears the write chain.
 *   The caller (SubAgentRunner) invokes this in its finally block.
 */

import { readFile, writeFile, unlink, mkdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { SubAgentRecord, SubAgentTaskId } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Storage path
// ─────────────────────────────────────────────────────────────────────────────

function subtaskDir(): string {
  return join(homedir(), '.claude', 'meta-agent', 'subtasks')
}

function taskPath(taskId: SubAgentTaskId): string {
  return join(subtaskDir(), `${taskId}.json`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: per-taskId write chain (serialises concurrent writes)
// ─────────────────────────────────────────────────────────────────────────────

const _writeChains = new Map<SubAgentTaskId, Promise<void>>()
let _dirEnsured = false
let _dirFailureLogged = false

async function _ensureDir(): Promise<boolean> {
  if (_dirEnsured) return true
  try {
    await mkdir(subtaskDir(), { recursive: true })
    _dirEnsured = true
    return true
  } catch (err) {
    if (!_dirFailureLogged) {
      console.error('[SubAgentTaskStore] Failed to create subtask directory:', err)
      _dirFailureLogged = true
    }
    return false
  }
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
  try {
    const raw = await readFile(taskPath(taskId), 'utf-8')
    return JSON.parse(raw) as SubAgentRecord
  } catch {
    return null
  }
}

/**
 * Write (create or overwrite) a task record.
 *
 * Writes are serialised per taskId — concurrent callers chain onto the
 * previous write promise so the file is never written in parallel.
 *
 * Returns the Promise for the write so callers can await if needed, but
 * SubAgentRunner fires-and-forgets (void) in the hot path.
 */
export function writeTask(record: SubAgentRecord): Promise<void> {
  const taskId = record.taskId

  const doWrite = async () => {
    if (!(await _ensureDir())) return
    await writeFile(taskPath(taskId), JSON.stringify(record, null, 2), 'utf-8')
  }

  const prev = _writeChains.get(taskId) ?? Promise.resolve()
  const next = prev.then(doWrite).catch(err => {
    console.error(`[SubAgentTaskStore] Write failed for ${taskId}:`, err)
  })
  _writeChains.set(taskId, next)
  return next
}

/**
 * Delete the task file and clear its write chain.
 *
 * Should be called in the SubAgentRunner's finally block after the task
 * reaches a terminal state and the main agent has acknowledged the result.
 */
export async function cleanupTask(taskId: SubAgentTaskId): Promise<void> {
  // Drain any pending writes first
  await (_writeChains.get(taskId) ?? Promise.resolve()).catch(() => {})
  _writeChains.delete(taskId)
  try {
    await unlink(taskPath(taskId))
  } catch {
    // File may not exist — ignore
  }
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
