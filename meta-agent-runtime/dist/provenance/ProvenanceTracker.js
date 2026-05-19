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
import { createHash } from 'crypto';
import { readFile, writeFile, readdir, mkdir, rename } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { makeProvenanceId } from './types.js';
import { failures } from '../validation/types.js';
// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────
function provenanceDir(sessionId) {
    // Unified root: matches CampaignStateStore and MetaAgentContextStore layout.
    return join(homedir(), '.claude', 'meta-agent', 'sessions', sessionId, 'provenance');
}
function recordPath(sessionId, id) {
    return join(provenanceDir(sessionId), `${id}.json`);
}
async function ensureDir(dir) {
    // mkdir with {recursive: true} is idempotent — no existsSync needed.
    await mkdir(dir, { recursive: true });
}
// ─────────────────────────────────────────────────────────────────────────────
// Hashing helpers
// ─────────────────────────────────────────────────────────────────────────────
function sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
}
function hashRecord(input) {
    try {
        return sha256(JSON.stringify(input));
    }
    catch {
        return sha256(String(input));
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// ProvenanceTracker
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Maximum number of records kept in the in-memory cache.
 *
 * At ~2 KB/record this is ~20 MB — acceptable for a session-scoped tracker.
 * When the limit is hit the oldest 10 % of entries are evicted (by insertion
 * order — Map preserves insertion order in V8 / JavaScriptCore / Bun).
 * Records are always persisted to disk; eviction only affects the hot cache.
 */
const MAX_CACHE_ENTRIES = 10_000;
const EVICT_BATCH = Math.ceil(MAX_CACHE_ENTRIES * 0.1); // evict 10 % at a time
export class ProvenanceTracker {
    sessionId;
    /** In-memory index: id → record (built lazily from disk on first list()) */
    cache = new Map();
    cacheLoaded = false;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
    // ── record ────────────────────────────────────────────────────────────────
    /**
     * Persist a new provenance record and return its ID.
     *
     * Fills in auto-generated fields:
     *   id, timestamp, inputHash, systemPromptHash
     *
     * The caller provides everything else (tool name, fidelity, input, output,
     * validationResults, artifacts, parent IDs, …).
     */
    async record(input) {
        const id = makeProvenanceId();
        const timestamp = Date.now();
        const { systemPrompt, ...rest } = input;
        const rec = {
            ...rest,
            id,
            timestamp,
            inputHash: hashRecord(input.input),
            systemPromptHash: systemPrompt ? sha256(systemPrompt) : '',
        };
        await this._save(rec);
        return id;
    }
    // ── get ───────────────────────────────────────────────────────────────────
    /** Load a single record by ID. Checks cache first, then disk. */
    async get(id) {
        if (this.cache.has(id))
            return this.cache.get(id);
        const path = recordPath(this.sessionId, id);
        try {
            const raw = await readFile(path, 'utf-8');
            const rec = JSON.parse(raw);
            this.cache.set(id, rec);
            return rec;
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return null;
            throw err;
        }
    }
    // ── list ──────────────────────────────────────────────────────────────────
    /**
     * Load all records for this session, optionally filtered.
     * Results are sorted by timestamp ascending (oldest first).
     */
    async list(filter) {
        await this._ensureCacheLoaded();
        let records = [...this.cache.values()];
        if (filter) {
            records = records.filter(r => this._matches(r, filter));
        }
        records.sort((a, b) => a.timestamp - b.timestamp);
        return records;
    }
    // ── chain ─────────────────────────────────────────────────────────────────
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
    async chain(id) {
        const visited = new Set();
        const result = [];
        let current = await this.get(id);
        while (current) {
            if (visited.has(current.id))
                break; // cycle guard
            visited.add(current.id);
            result.unshift(current); // prepend → root first
            if (!current.parentProvenanceId)
                break;
            current = await this.get(current.parentProvenanceId);
        }
        return result;
    }
    // ── findByInputHash ───────────────────────────────────────────────────────
    /**
     * Find all records whose input is identical to the given hash.
     * Useful for detecting redundant re-runs and retrieving cached results.
     */
    async findByInputHash(inputHash) {
        await this._ensureCacheLoaded();
        return [...this.cache.values()]
            .filter(r => r.inputHash === inputHash)
            .sort((a, b) => a.timestamp - b.timestamp);
    }
    /**
     * Convenience: check if an identical computation was already done.
     * Returns the most recent matching record, or null.
     */
    async findDuplicate(input) {
        const hash = hashRecord(input);
        const matches = await this.findByInputHash(hash);
        return matches.length > 0 ? matches[matches.length - 1] : null;
    }
    // ── summary ───────────────────────────────────────────────────────────────
    /**
     * Return a human-readable text block describing a provenance record.
     * Intended to be injected into agent context or reports.
     */
    async summary(id) {
        const rec = await this.get(id);
        if (!rec)
            return `[Provenance record ${id} not found]`;
        const date = new Date(rec.timestamp).toISOString();
        const vvBad = failures(rec.validationResults);
        const vvLine = vvBad.length === 0
            ? '✅ all V&V checks passed'
            : `⚠️  ${vvBad.length} V&V finding(s): ${vvBad.map(r => r.message).join('; ')}`;
        const lines = [
            `Provenance: ${rec.id}`,
            `  Recorded : ${date}`,
            `  Tool     : ${rec.toolName}${rec.toolVersion ? ` v${rec.toolVersion}` : ''} (fidelity L${rec.fidelityLevel})`,
            `  Agent    : ${rec.agentId}`,
            rec.jobId ? `  Job ID   : ${rec.jobId}` : null,
            `  Model    : ${rec.modelName || '(unknown)'}`,
            `  Input ⌗  : ${rec.inputHash.slice(0, 12)}…`,
            `  V&V      : ${vvLine}`,
            rec.artifacts.length > 0
                ? `  Artifacts: ${rec.artifacts.map(a => a.name).join(', ')}`
                : null,
            rec.parentProvenanceId
                ? `  Derived from: ${rec.parentProvenanceId}`
                : null,
        ].filter(Boolean);
        return lines.join('\n');
    }
    // ── internal ──────────────────────────────────────────────────────────────
    async _save(rec) {
        const dir = provenanceDir(this.sessionId);
        await ensureDir(dir);
        const target = recordPath(this.sessionId, rec.id);
        const tmp = `${target}.tmp`;
        await writeFile(tmp, JSON.stringify(rec, null, 2), 'utf-8');
        await rename(tmp, target);
        // Evict oldest entries before inserting to keep the cache bounded.
        // Disk is always the source of truth; eviction only drops hot-cache entries.
        if (this.cache.size >= MAX_CACHE_ENTRIES) {
            let evicted = 0;
            for (const key of this.cache.keys()) {
                this.cache.delete(key);
                if (++evicted >= EVICT_BATCH)
                    break;
            }
        }
        this.cache.set(rec.id, rec);
    }
    async _ensureCacheLoaded() {
        if (this.cacheLoaded)
            return;
        this.cacheLoaded = true;
        const dir = provenanceDir(this.sessionId);
        let entries;
        try {
            entries = await readdir(dir);
        }
        catch {
            // Directory doesn't exist yet (no records) or is unreadable — fine.
            return;
        }
        for (const entry of entries) {
            if (!entry.endsWith('.json'))
                continue;
            const id = entry.replace(/\.json$/, '');
            if (this.cache.has(id))
                continue; // already in cache from get()
            try {
                const raw = await readFile(join(dir, entry), 'utf-8');
                const rec = JSON.parse(raw);
                this.cache.set(rec.id, rec);
            }
            catch {
                // skip corrupt files
            }
        }
    }
    _matches(r, f) {
        if (f.agentId && r.agentId !== f.agentId)
            return false;
        if (f.toolName && r.toolName !== f.toolName)
            return false;
        if (f.fidelityLevels && !f.fidelityLevels.includes(r.fidelityLevel))
            return false;
        if (f.hasVVFailure !== undefined) {
            const hasFail = failures(r.validationResults).length > 0;
            if (f.hasVVFailure !== hasFail)
                return false;
        }
        if (f.parentProvenanceId && r.parentProvenanceId !== f.parentProvenanceId)
            return false;
        if (f.designPointId && r.designPointId !== f.designPointId)
            return false;
        if (f.tags && f.tags.length > 0) {
            const rTags = new Set(r.tags ?? []);
            if (!f.tags.every(t => rTags.has(t)))
                return false;
        }
        if (f.since !== undefined && r.timestamp < f.since)
            return false;
        if (f.until !== undefined && r.timestamp > f.until)
            return false;
        return true;
    }
}
//# sourceMappingURL=ProvenanceTracker.js.map