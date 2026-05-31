import { homedir } from 'os';
import { join } from 'path';
import { atomicWriteJson, ensureDir, listJsonIds, readJsonFile } from '../core/persist/index.js';
import { makePrincipleId } from './types.js';
const PRINCIPLE_ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'principles');
const MANIFEST_FILE = 'PRINCIPLE_MANIFEST.json';
const LOAD_CONCURRENCY = 32;
const PRINCIPLE_ID_RE = /^pr_[0-9a-z]+_[0-9a-f]{8}$/;
const CONFIDENCE_WEIGHT = {
    reproduced: 500,
    observed: 400,
    derived: 350,
    reported: 200,
    hypothesis: 100,
};
export function isPrincipleId(id) {
    return PRINCIPLE_ID_RE.test(id);
}
export function principleRetrievalScore(principle) {
    return CONFIDENCE_WEIGHT[principle.confidenceTier] +
        Math.min(principle.observationCount, 10) * 10 -
        principle.contradictionCount * 50 +
        Math.min(principle.anchoredByPhysicalAnchorIds.length, 6) * 12;
}
export class PrincipleStore {
    dir;
    manifestPath;
    constructor(dir) {
        this.dir = dir ?? PRINCIPLE_ROOT;
        this.manifestPath = join(this.dir, MANIFEST_FILE);
    }
    async ensureDir() {
        await ensureDir(this.dir);
    }
    async write(entry) {
        await this.ensureDir();
        const id = makePrincipleId();
        const now = Date.now();
        const full = {
            ...entry,
            id,
            schemaVersion: '1.0',
            createdAt: now,
            updatedAt: now,
        };
        await atomicWriteJson(join(this.dir, `${id}.json`), full);
        await this._upsertManifest(full).catch(() => undefined);
        return id;
    }
    async load(id) {
        if (!isPrincipleId(id))
            return null;
        return readJsonFile(join(this.dir, `${id}.json`));
    }
    async search(query = {}) {
        const limit = Math.min(query.limit ?? 10, 20);
        const entries = await this._loadManifestEntries();
        const filtered = entries.filter(principle => {
            if (query.domain && !principle.domains.includes(query.domain))
                return false;
            if (query.abstractionLevel && principle.abstractionLevel !== query.abstractionLevel)
                return false;
            if (query.experienceId && !principle.derivedFromExperienceIds.includes(query.experienceId))
                return false;
            if (query.anchorId && !principle.anchoredByPhysicalAnchorIds.includes(query.anchorId))
                return false;
            if (query.keyword) {
                const kw = query.keyword.toLowerCase();
                const searchable = [
                    principle.title,
                    principle.statement,
                    principle.mechanism,
                    ...principle.firstPrinciplesSupport,
                    ...principle.preconditions,
                    ...principle.applicabilityBounds,
                    ...principle.nonApplicableWhen,
                ].join(' ').toLowerCase();
                if (!searchable.includes(kw))
                    return false;
            }
            return true;
        });
        filtered.sort((a, b) => {
            const scoreDelta = principleRetrievalScore(b) - principleRetrievalScore(a);
            return scoreDelta !== 0 ? scoreDelta : b.createdAt - a.createdAt;
        });
        return filtered.slice(0, limit);
    }
    async listIds() {
        const ids = await listJsonIds(this.dir);
        return ids.filter(isPrincipleId);
    }
    async _loadAll() {
        return this._loadAllFromFiles();
    }
    async _loadAllFromFiles() {
        const ids = await this.listIds();
        return loadWithConcurrency(ids, id => this.load(id));
    }
    async _loadManifestEntries() {
        const manifest = await readJsonFile(this.manifestPath);
        if (isPrincipleManifest(manifest))
            return manifest.entries;
        return this._rebuildManifestFromFiles();
    }
    async _rebuildManifestFromFiles() {
        const entries = await this._loadAllFromFiles();
        await this._writeManifest(entries).catch(() => undefined);
        return entries;
    }
    async _upsertManifest(entry) {
        const manifest = await readJsonFile(this.manifestPath);
        if (!isPrincipleManifest(manifest)) {
            await this._rebuildManifestFromFiles();
            return;
        }
        const entries = manifest.entries.filter(existing => existing.id !== entry.id);
        entries.push(entry);
        await this._writeManifest(entries);
    }
    async _writeManifest(entries) {
        await atomicWriteJson(this.manifestPath, {
            schemaVersion: '1.0',
            updatedAt: Date.now(),
            entries,
        });
    }
}
function isPrincipleManifest(value) {
    if (!value || typeof value !== 'object')
        return false;
    const record = value;
    return record['schemaVersion'] === '1.0' &&
        typeof record['updatedAt'] === 'number' &&
        Array.isArray(record['entries']);
}
async function loadWithConcurrency(ids, load) {
    const out = [];
    let next = 0;
    const workerCount = Math.min(LOAD_CONCURRENCY, ids.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (next < ids.length) {
            const id = ids[next++];
            const entry = await load(id);
            if (entry)
                out.push(entry);
        }
    }));
    return out;
}
//# sourceMappingURL=PrincipleStore.js.map