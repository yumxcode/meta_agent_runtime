/**
 * ExperiencePendingStore — session-scoped buffer for AI-proposed experiences.
 *
 * When the AI calls experience_write, the entry is held here instead of
 * committing directly to the shared ExperienceStore.  The user reviews
 * pending entries via the `/experience review` REPL command (or at session
 * end when cleanup is triggered).
 *
 * Only approved entries are committed to the cross-session ExperienceStore.
 * This prevents low-quality, premature, or incorrect experiences from
 * polluting the shared knowledge base.
 *
 * Storage: in-memory + best-effort project-local persistence.  Pending entries
 * survive normal restarts so the user can review them after resuming the
 * robotics project; they are never auto-committed.
 */
import { createHash } from 'crypto';
import { mkdir, readFile, writeFile, rm } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { ROBOTICS_DOMAINS } from './types.js';
const PENDING_ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'pending-experiences');
// ── ExperiencePendingStore ────────────────────────────────────────────────────
export class ExperiencePendingStore {
    _pending = [];
    _filePath;
    constructor(projectDir) {
        this._filePath = projectDir
            ? join(PENDING_ROOT, `${createHash('sha256').update(projectDir).digest('hex').slice(0, 16)}.json`)
            : null;
    }
    /** Load pending entries persisted for this project, if any. */
    async load() {
        if (!this._filePath)
            return;
        try {
            const raw = await readFile(this._filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed))
                return;
            this._pending.length = 0;
            for (const item of parsed) {
                if (!isPendingExperience(item))
                    continue;
                this._pending.push(item);
            }
        }
        catch {
            // Missing or malformed pending file: start with an empty queue.
        }
    }
    /** Queue an experience for later review. Returns the temporary pending ID. */
    add(input) {
        const pendingId = `pending_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        this._pending.push({ pendingId, proposedAt: Date.now(), input });
        this._persistSoon();
        return pendingId;
    }
    /** All pending entries in proposal order. */
    list() {
        return this._pending;
    }
    /** Number of pending entries awaiting review. */
    get count() {
        return this._pending.length;
    }
    /** Remove one pending entry (after commit or discard). */
    remove(pendingId) {
        const idx = this._pending.findIndex(p => p.pendingId === pendingId);
        if (idx < 0)
            return false;
        this._pending.splice(idx, 1);
        this._persistSoon();
        return true;
    }
    /** Clear all pending entries (e.g. on session end after review). */
    clear() {
        this._pending.length = 0;
        this._persistSoon();
    }
    /**
     * Commit one pending entry to the ExperienceStore.
     * Returns the committed experience ID, or null on failure.
     */
    async commit(pendingId, store) {
        const entry = this._pending.find(p => p.pendingId === pendingId);
        if (!entry)
            return null;
        try {
            const input = entry.input;
            const normalized = validateExperienceInput(input);
            if (!normalized.ok)
                return null;
            const id = await store.write({
                domain: normalized.value.domain,
                title: normalized.value.title,
                problem: normalized.value.problem,
                solution: normalized.value.solution,
                outcome: {
                    success: normalized.value.success,
                    summary: normalized.value.outcomeSummary,
                    failureReason: normalized.value.failureReason,
                    workarounds: normalized.value.workarounds,
                },
                algorithm: normalized.value.algorithm,
                tags: normalized.value.tags,
                robot: normalized.value.robot,
                difficulty: normalized.value.difficulty,
                metrics: normalized.value.metrics,
                relatedPapers: normalized.value.relatedPapers,
                sourceTaskId: normalized.value.sourceTaskId,
                fullReport: normalized.value.fullReport,
            });
            this.remove(pendingId);
            return id;
        }
        catch {
            return null;
        }
    }
    _persistSoon() {
        void this._persist().catch(() => { });
    }
    async _persist() {
        if (!this._filePath)
            return;
        if (this._pending.length === 0) {
            await rm(this._filePath, { force: true }).catch(() => undefined);
            return;
        }
        await mkdir(dirname(this._filePath), { recursive: true });
        await writeFile(this._filePath, JSON.stringify(this._pending, null, 2), 'utf-8');
    }
}
function isPendingExperience(value) {
    if (!value || typeof value !== 'object')
        return false;
    const record = value;
    return typeof record['pendingId'] === 'string' &&
        typeof record['proposedAt'] === 'number' &&
        Boolean(record['input']) &&
        typeof record['input'] === 'object';
}
function validateExperienceInput(input) {
    const domain = normalizeDomain(input['domain']);
    const title = requiredString(input['title'], 80);
    const problem = requiredString(input['problem'], 500);
    const solution = requiredString(input['solution'], 800);
    const outcomeSummary = requiredString(input['outcome_summary'], 200);
    if (!domain || !title || !problem || !solution || !outcomeSummary)
        return { ok: false };
    return {
        ok: true,
        value: {
            domain,
            title,
            problem,
            solution,
            success: Boolean(input['success']),
            outcomeSummary,
            difficulty: normalizeDifficulty(input['difficulty']),
            tags: normalizeStringArray(input['tags'], 20, 40) ?? [],
            algorithm: optionalString(input['algorithm'], 80),
            robot: optionalString(input['robot'], 80),
            failureReason: optionalString(input['failure_reason'], 300),
            workarounds: normalizeStringArray(input['workarounds'], 10, 200),
            metrics: normalizeMetrics(input['metrics']),
            relatedPapers: normalizeStringArray(input['related_papers'], 20, 120),
            sourceTaskId: optionalString(input['source_task_id'], 120),
            fullReport: optionalString(input['full_report'], 20_000),
        },
    };
}
function requiredString(value, max) {
    const str = optionalString(value, max);
    return str && str.trim() ? str : null;
}
function optionalString(value, max) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : undefined;
}
function normalizeDomain(value) {
    return typeof value === 'string' && ROBOTICS_DOMAINS.includes(value)
        ? value
        : null;
}
function normalizeDifficulty(value) {
    return value === 'low' || value === 'medium' || value === 'high' ? value : 'medium';
}
function normalizeStringArray(value, maxItems, maxLen) {
    if (!Array.isArray(value))
        return undefined;
    const out = value
        .filter((v) => typeof v === 'string')
        .map(v => v.trim().slice(0, maxLen))
        .filter(Boolean)
        .slice(0, maxItems);
    return out.length ? out : undefined;
}
function normalizeMetrics(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const out = {};
    for (const [key, raw] of Object.entries(value).slice(0, 30)) {
        if (typeof raw !== 'number' && typeof raw !== 'string')
            continue;
        const safeKey = key.trim().slice(0, 80);
        if (!safeKey)
            continue;
        out[safeKey] = typeof raw === 'string' ? raw.slice(0, 200) : raw;
    }
    return Object.keys(out).length ? out : undefined;
}
//# sourceMappingURL=ExperiencePendingStore.js.map