/**
 * ISubAgentDispatcher — minimal interface for spawning and querying sub-agents.
 *
 * Tool factory functions (`createRunAgentTool`, `createExperimentDispatchTool`,
 * etc.) accept this interface rather than the concrete `SubAgentBridge` class.
 * This decouples the tools layer from the sub-agent session lifecycle:
 *
 *   Tools layer  →  ISubAgentDispatcher  ←  SubAgentBridge (implements)
 *
 * Benefits:
 *   - Tools can be unit-tested with a lightweight stub.
 *   - A future alternate dispatcher (e.g. remote sub-agent runner) is a
 *     drop-in replacement without touching any tool code.
 *   - The tools layer no longer imports the concrete SubAgentBridge class,
 *     keeping the dependency graph clean.
 */

import type { SubAgentRecord, SubAgentTaskId } from './types.js'
import type { SpawnSubAgentOptions } from './SubAgentBridge.js'

export interface ISubAgentDispatcher {
  /**
   * Spawn a new sub-agent and return its initial task record.
   * The sub-agent may be queued before it runs; poll via getStatus().
   */
  spawnSubAgent(opts: SpawnSubAgentOptions): Promise<SubAgentRecord>

  /**
   * Return the current record for a task, or null if not found.
   */
  getStatus(taskId: SubAgentTaskId): Promise<SubAgentRecord | null>

  /**
   * Cancel a running sub-agent task.
   * Returns true if the task was cancelled, false if it was already terminal or not found.
   */
  cancelTask(taskId: SubAgentTaskId, reason?: string): Promise<boolean>
}
