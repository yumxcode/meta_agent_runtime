/**
 * TaskContractStore — file-backed persistence for TaskContract objects.
 *
 * Storage layout:
 *   ~/.claude/meta-agent/tasks/<contractId>/contract.json
 *
 * Design invariants:
 *   - Load/save are atomic (write to tmp then rename on POSIX; best-effort on Windows)
 *   - The store never throws — all methods catch and return null on failure
 *   - Listing is done by reading the directory; broken entries are skipped silently
 *   - Deletion removes the JSON file but keeps the directory (may hold run-state.json)
 */
import type { TaskContract } from './types.js';
export declare function getContractDir(contractId: string): string;
export declare function getContractPath(contractId: string): string;
export declare class TaskContractStore {
    /**
     * Save a contract to disk. Creates the directory if needed.
     * Returns true on success, false on any error.
     */
    static save(contract: TaskContract): Promise<boolean>;
    /**
     * Load a contract by ID. Returns null if not found or corrupt.
     */
    static load(contractId: string): Promise<TaskContract | null>;
    /**
     * Load the most recent contract for a session.
     * Returns null if no contract exists for this session.
     */
    static loadForSession(sessionId: string): Promise<TaskContract | null>;
    /**
     * Update specific fields on an existing contract.
     * Automatically bumps `updatedAt`.
     * Returns the updated contract, or null on failure.
     */
    static update(contractId: string, updates: Partial<Omit<TaskContract, 'contractId' | 'sessionId' | 'createdAt' | 'schemaVersion'>>): Promise<TaskContract | null>;
    /**
     * Append a user decision to the contract's decision log.
     */
    static appendDecision(contractId: string, decision: string, evidence?: string): Promise<boolean>;
    /**
     * Update the status of a single acceptance criterion.
     */
    static updateCriterionStatus(contractId: string, criterionId: string, status: 'pass' | 'fail' | 'unknown', evidenceRefs?: string[]): Promise<boolean>;
    /**
     * Delete the contract file for a given ID.
     */
    static delete(contractId: string): Promise<void>;
}
//# sourceMappingURL=TaskContractStore.d.ts.map