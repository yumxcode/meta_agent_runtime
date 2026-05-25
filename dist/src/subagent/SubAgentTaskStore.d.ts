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
import type { SubAgentRecord, SubAgentTaskId } from './types.js';
/**
 * Read a task record.  Returns null when the file does not exist or is corrupt.
 */
export declare function readTask(taskId: SubAgentTaskId): Promise<SubAgentRecord | null>;
/**
 * Write (create or overwrite) a task record.
 *
 * Writes are serialised per taskId — concurrent callers chain onto the
 * previous write promise so the file is never written in parallel.
 *
 * Returns the Promise for the write so callers can await if needed, but
 * SubAgentRunner fires-and-forgets (void) in the hot path.
 */
export declare function writeTask(record: SubAgentRecord): Promise<void>;
/**
 * Delete the task file and clear its write chain.
 *
 * Should be called in the SubAgentRunner's finally block after the task
 * reaches a terminal state and the main agent has acknowledged the result.
 */
export declare function cleanupTask(taskId: SubAgentTaskId): Promise<void>;
/**
 * List all task records for a given parent session.
 *
 * Reads every .json file in the subtasks directory and filters by
 * parentSessionId.  Gracefully skips corrupt files.
 */
export declare function listTasksForSession(parentSessionId: string): Promise<SubAgentRecord[]>;
//# sourceMappingURL=SubAgentTaskStore.d.ts.map