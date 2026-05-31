import { createHash } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { KNOWLEDGE_CONFIDENCE_TIERS, KNOWLEDGE_SCOPES, ROBOTICS_DOMAINS, } from './types.js';
const PENDING_ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'pending-physical-anchors');
const MAX_PENDING_ENTRIES = 500;
export class PhysicalAnchorPendingStore {
    _pending = [];
    _filePath;
    _persistTail = Promise.resolve();
    constructor(projectDir, root = PENDING_ROOT) {
        this._filePath = projectDir
            ? join(root, `${createHash('sha256').update(projectDir).digest('hex').slice(0, 16)}.json`)
            : null;
    }
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
                if (isPendingPhysicalAnchor(item))
                    this._pending.push(item);
            }
            this._trimToLimit();
        }
        catch {
            // Missing or malformed pending file: start empty.
        }
    }
    add(input) {
        if (this._pending.length >= MAX_PENDING_ENTRIES) {
            throw new Error(`Pending physical anchor queue limit reached (${MAX_PENDING_ENTRIES}); run /anchor review before adding more.`);
        }
        const pendingId = `pa_pending_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        this._pending.push({ pendingId, proposedAt: Date.now(), input });
        this._persistSoon();
        return pendingId;
    }
    list() {
        return this._pending;
    }
    get count() {
        return this._pending.length;
    }
    remove(pendingId) {
        const idx = this._pending.findIndex(p => p.pendingId === pendingId);
        if (idx < 0)
            return false;
        this._pending.splice(idx, 1);
        this._persistSoon();
        return true;
    }
    async flush() {
        await this._persistTail;
    }
    async commit(pendingId, store) {
        const entry = this._pending.find(p => p.pendingId === pendingId);
        if (!entry)
            return null;
        try {
            const normalized = validatePhysicalAnchorInput(entry.input);
            if (!normalized.ok)
                return null;
            const id = await store.write(normalized.value);
            this.remove(pendingId);
            return id;
        }
        catch {
            return null;
        }
    }
    _persistSoon() {
        const snapshot = this._pending.map(item => ({
            pendingId: item.pendingId,
            proposedAt: item.proposedAt,
            input: { ...item.input },
        }));
        this._persistTail = this._persistTail
            .catch(() => { })
            .then(() => this._persist(snapshot))
            .catch(() => { });
    }
    _trimToLimit() {
        if (this._pending.length <= MAX_PENDING_ENTRIES)
            return;
        this._pending.splice(0, this._pending.length - MAX_PENDING_ENTRIES);
        this._persistSoon();
    }
    async _persist(snapshot) {
        if (!this._filePath)
            return;
        if (snapshot.length === 0) {
            await rm(this._filePath, { force: true }).catch(() => undefined);
            return;
        }
        await mkdir(dirname(this._filePath), { recursive: true });
        await writeFile(this._filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    }
}
export function validatePhysicalAnchorInput(input) {
    const domain = normalizeDomain(input['domain']);
    const scope = normalizeScope(input['scope']) ?? 'code';
    const title = requiredString(input['title'], 80);
    const fact = requiredString(input['fact'], 800);
    const implication = requiredString(input['implication'], 800);
    if (!domain || !title || !fact || !implication)
        return { ok: false };
    return {
        ok: true,
        value: {
            domain,
            scope,
            title,
            fact,
            implication,
            mechanism: optionalString(input['mechanism'], 800),
            robot: optionalString(input['robot'], 80),
            tags: normalizeStringArray(input['tags'], 20, 40) ?? [],
            confidenceTier: normalizeConfidence(input['confidence_tier']) ?? 'observed',
            evidenceRefs: normalizeStringArray(input['evidence_refs'], 20, 300) ?? [],
            source: optionalString(input['source'], 240),
            lastVerifiedAt: normalizeTimestamp(input['last_verified_at']),
            invalidates: normalizeStringArray(input['invalidates'], 10, 240),
        },
    };
}
function isPendingPhysicalAnchor(value) {
    if (!value || typeof value !== 'object')
        return false;
    const record = value;
    return typeof record['pendingId'] === 'string' &&
        typeof record['proposedAt'] === 'number' &&
        Boolean(record['input']) &&
        typeof record['input'] === 'object';
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
function normalizeScope(value) {
    return typeof value === 'string' && KNOWLEDGE_SCOPES.includes(value)
        ? value
        : undefined;
}
function normalizeConfidence(value) {
    return typeof value === 'string' && KNOWLEDGE_CONFIDENCE_TIERS.includes(value)
        ? value
        : undefined;
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
function normalizeTimestamp(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return undefined;
    return Math.floor(value);
}
//# sourceMappingURL=PhysicalAnchorPendingStore.js.map