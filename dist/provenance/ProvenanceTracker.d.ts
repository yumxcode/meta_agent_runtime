/**
 * ProvenanceTracker — records and retrieves engineering result audit trails.
 *
 * Every tool call that produces an engineering result should be recorded here.
 * The tracker is the single source of truth for "why does this number exist?"
 *
 * Storage layout:
 *   ~/.claude/meta-agent/sessions/{sessionId}/provenance/{provenanceId}.json
 *
 * Each record is one JSON file — no database, no index required for the
 * expected record counts.  loadAll() reads all files in the provenance dir;
 * it is fast enough for typical session sizes (< 10,000 records).
 *
 * Public API:
 *   record(input)           → Promise<ProvenanceId>   — save a new record
 *   get(id)                 → Promise<ProvenanceRecord | null>
 *   list(filter?)           → Promise<ProvenanceRecord[]>
 *   chain(id)               → Promise<ProvenanceRecord[]>  — lineage from root
 *   findByInputHash(hash)   → Promise<ProvenanceRecord[]>  — detect re-runs
 *   summary(id)             → Promise<string>  — human-readable text block
 */
import type { ProvenanceId, ProvenanceRecord, ProvenanceInput, ProvenanceFilter } from './types.js';
export declare class ProvenanceTracker {
    private readonly sessionId;
    /** In-memory index: id → record (built lazily from disk on first list()) */
    private cache;
    private cacheLoaded;
    constructor(sessionId: string);
    /**
     * Persist a new provenance record and return its ID.
     *
     * Fills in auto-generated fields:
     *   id, timestamp, inputHash, systemPromptHash
     *
     * The caller provides everything else (tool name, fidelity, input, output,
     * validationResults, artifacts, parent IDs, …).
     */
    record(input: ProvenanceInput): Promise<ProvenanceId>;
    /** Load a single record by ID. Checks cache first, then disk. */
    get(id: ProvenanceId): Promise<ProvenanceRecord | null>;
    /**
     * Load all records for this session, optionally filtered.
     * Results are sorted by timestamp ascending (oldest first).
     */
    list(filter?: ProvenanceFilter): Promise<ProvenanceRecord[]>;
    /**
     * Follow parentProvenanceId links from `id` back to the root record,
     * returning the full lineage chain ordered from root → `id`.
     *
     * Example:
     *   A (raw material data)
     *   └── B (L0 analytical result, parent=A)
     *       └── C (L2 FEM result, parent=B)
     *           └── D (post-processed report, parent=C)
     *
     *   chain('D') → [A, B, C, D]
     *
     * Stops if a parent record is not found (orphaned chain).
     */
    chain(id: ProvenanceId): Promise<ProvenanceRecord[]>;
    /**
     * Find all records whose input is identical to the given hash.
     * Useful for detecting redundant re-runs and retrieving cached results.
     */
    findByInputHash(inputHash: string): Promise<ProvenanceRecord[]>;
    /**
     * Convenience: check if an identical computation was already done.
     * Returns the most recent matching record, or null.
     */
    findDuplicate(input: unknown): Promise<ProvenanceRecord | null>;
    /**
     * Return a human-readable text block describing a provenance record.
     * Intended to be injected into agent context or reports.
     */
    summary(id: ProvenanceId): Promise<string>;
    private _save;
    private _ensureCacheLoaded;
    private _evictCacheIfNeeded;
    private _matches;
}
//# sourceMappingURL=ProvenanceTracker.d.ts.map