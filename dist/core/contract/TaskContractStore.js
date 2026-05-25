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
import { readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { atomicWriteJson, readJsonFile, deleteJsonFile } from '../persist/index.js';
// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────
const TASKS_DIR = join(homedir(), '.claude', 'meta-agent', 'tasks');
export function getContractDir(contractId) {
    return join(TASKS_DIR, contractId);
}
export function getContractPath(contractId) {
    return join(getContractDir(contractId), 'contract.json');
}
// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────
export class TaskContractStore {
    /**
     * Save a contract to disk. Creates the directory if needed.
     * Returns true on success, false on any error.
     */
    static async save(contract) {
        try {
            await atomicWriteJson(getContractPath(contract.contractId), contract);
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Load a contract by ID. Returns null if not found or corrupt.
     */
    static async load(contractId) {
        const parsed = await readJsonFile(getContractPath(contractId));
        if (!parsed ||
            parsed['schemaVersion'] !== '1.0' ||
            typeof parsed['contractId'] !== 'string')
            return null;
        return parsed;
    }
    /**
     * Load the most recent contract for a session.
     * Returns null if no contract exists for this session.
     */
    static async loadForSession(sessionId) {
        try {
            const entries = await readdir(TASKS_DIR, { withFileTypes: true });
            const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
            let latest = null;
            for (const dir of dirs) {
                const contract = await TaskContractStore.load(dir);
                if (contract && contract.sessionId === sessionId) {
                    if (!latest || contract.updatedAt > latest.updatedAt) {
                        latest = contract;
                    }
                }
            }
            return latest;
        }
        catch {
            return null;
        }
    }
    /**
     * Update specific fields on an existing contract.
     * Automatically bumps `updatedAt`.
     * Returns the updated contract, or null on failure.
     */
    static async update(contractId, updates) {
        const existing = await TaskContractStore.load(contractId);
        if (!existing)
            return null;
        const updated = {
            ...existing,
            ...updates,
            contractId: existing.contractId,
            sessionId: existing.sessionId,
            createdAt: existing.createdAt,
            schemaVersion: existing.schemaVersion,
            updatedAt: new Date().toISOString(),
        };
        const ok = await TaskContractStore.save(updated);
        return ok ? updated : null;
    }
    /**
     * Append a user decision to the contract's decision log.
     */
    static async appendDecision(contractId, decision, evidence) {
        const existing = await TaskContractStore.load(contractId);
        if (!existing)
            return false;
        const entry = {
            at: new Date().toISOString(),
            decision,
            evidence,
        };
        return TaskContractStore.save({
            ...existing,
            userApprovedDecisions: [...existing.userApprovedDecisions, entry],
            updatedAt: new Date().toISOString(),
        });
    }
    /**
     * Update the status of a single acceptance criterion.
     */
    static async updateCriterionStatus(contractId, criterionId, status, evidenceRefs) {
        const existing = await TaskContractStore.load(contractId);
        if (!existing)
            return false;
        const criteria = existing.acceptanceCriteria.map(c => c.id === criterionId
            ? { ...c, status, evaluatedAt: new Date().toISOString(), evidenceRefs }
            : c);
        return TaskContractStore.save({
            ...existing,
            acceptanceCriteria: criteria,
            updatedAt: new Date().toISOString(),
        });
    }
    /**
     * Delete the contract file for a given ID.
     */
    static async delete(contractId) {
        await deleteJsonFile(getContractPath(contractId));
    }
}
//# sourceMappingURL=TaskContractStore.js.map