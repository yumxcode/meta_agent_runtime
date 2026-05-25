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
import { unlink } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { atomicWriteJson, readJsonFile, ensureDir } from '../core/persist/index.js';
// ─────────────────────────────────────────────────────────────────────────────
// Storage path
// ─────────────────────────────────────────────────────────────────────────────
function subtaskDir() {
    return join(homedir(), '.claude', 'meta-agent', 'subtasks');
}
function taskPath(taskId) {
    return join(subtaskDir(), `${taskId}.json`);
}
// ─────────────────────────────────────────────────────────────────────────────
// Internal: per-taskId write chain (serialises concurrent writes)
// ─────────────────────────────────────────────────────────────────────────────
const _writeChains = new Map();
// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Read a task record.  Returns null when the file does not exist or is corrupt.
 */
export async function readTask(taskId) {
    return readJsonFile(taskPath(taskId));
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
export function writeTask(record) {
    const taskId = record.taskId;
    const doWrite = async () => {
        await ensureDir(subtaskDir());
        await atomicWriteJson(taskPath(taskId), record);
    };
    const prev = _writeChains.get(taskId) ?? Promise.resolve();
    const next = prev.then(doWrite).catch(err => {
        console.error(`[SubAgentTaskStore] Write failed for ${taskId}:`, err);
    });
    _writeChains.set(taskId, next);
    return next;
}
/**
 * Delete the task file and clear its write chain.
 *
 * Should be called in the SubAgentRunner's finally block after the task
 * reaches a terminal state and the main agent has acknowledged the result.
 */
export async function cleanupTask(taskId) {
    // Drain any pending writes first
    await (_writeChains.get(taskId) ?? Promise.resolve()).catch(() => { });
    _writeChains.delete(taskId);
    try {
        await unlink(taskPath(taskId));
    }
    catch {
        // File may not exist — ignore
    }
}
/**
 * List all task records for a given parent session.
 *
 * Reads every .json file in the subtasks directory and filters by
 * parentSessionId.  Gracefully skips corrupt files.
 */
export async function listTasksForSession(parentSessionId) {
    const { readdir } = await import('fs/promises');
    try {
        const entries = await readdir(subtaskDir());
        const records = [];
        await Promise.allSettled(entries
            .filter(e => e.endsWith('.json'))
            .map(async (e) => {
            const taskId = e.replace(/\.json$/, '');
            const record = await readTask(taskId);
            if (record && record.parentSessionId === parentSessionId) {
                records.push(record);
            }
        }));
        return records.sort((a, b) => a.createdAt - b.createdAt);
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=SubAgentTaskStore.js.map