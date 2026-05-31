import { homedir } from 'os';
import { join } from 'path';
import { atomicWriteJson, ensureDir, listJsonIds, readJsonFile } from '../core/persist/index.js';
import { makePhysicalAnchorId } from './types.js';
const PHYSICAL_ANCHOR_ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'physical_anchors');
const MANIFEST_FILE = 'PHYSICAL_ANCHOR_MANIFEST.json';
const LOAD_CONCURRENCY = 32;
const PHYSICAL_ANCHOR_ID_RE = /^pa_[0-9a-z]+_[0-9a-f]{8}$/;
const CONFIDENCE_WEIGHT = {
    reproduced: 500,
    observed: 450,
    derived: 425,
    reported: 250,
    hypothesis: 100,
};
export function isPhysicalAnchorId(id) {
    return PHYSICAL_ANCHOR_ID_RE.test(id);
}
function anchorScore(anchor) {
    return CONFIDENCE_WEIGHT[anchor.confidenceTier] + Math.min(anchor.evidenceRefs.length, 8) * 10;
}
export class PhysicalAnchorStore {
    dir;
    manifestPath;
    constructor(dir) {
        this.dir = dir ?? PHYSICAL_ANCHOR_ROOT;
        this.manifestPath = join(this.dir, MANIFEST_FILE);
    }
    async ensureDir() {
        await ensureDir(this.dir);
    }
    async write(entry) {
        await this.ensureDir();
        const id = makePhysicalAnchorId();
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
        if (!isPhysicalAnchorId(id))
            return null;
        return readJsonFile(join(this.dir, `${id}.json`));
    }
    async search(query = {}) {
        const limit = Math.min(query.limit ?? 10, 20);
        const entries = await this._loadManifestEntries();
        const filtered = entries.filter(anchor => {
            if (query.domain && anchor.domain !== query.domain)
                return false;
            if (query.scope && anchor.scope !== query.scope)
                return false;
            if (query.robot && anchor.scope === 'robot' && anchor.robot && anchor.robot !== query.robot)
                return false;
            if (query.tags?.length) {
                const tags = anchor.tags.map(t => t.toLowerCase());
                if (!query.tags.every(t => tags.includes(t.toLowerCase())))
                    return false;
            }
            if (query.keyword) {
                const kw = query.keyword.toLowerCase();
                const searchable = [
                    anchor.title,
                    anchor.fact,
                    anchor.mechanism ?? '',
                    anchor.implication,
                    anchor.source ?? '',
                ].join(' ').toLowerCase();
                if (!searchable.includes(kw))
                    return false;
            }
            return true;
        });
        filtered.sort((a, b) => {
            const scoreDelta = anchorScore(b) - anchorScore(a);
            return scoreDelta !== 0 ? scoreDelta : b.createdAt - a.createdAt;
        });
        return filtered.slice(0, limit);
    }
    async getStats() {
        const entries = await this._loadManifestEntries();
        const domainCounts = {};
        const scopeCounts = { global: 0, robot: 0, code: 0 };
        for (const entry of entries) {
            domainCounts[entry.domain] = (domainCounts[entry.domain] ?? 0) + 1;
            scopeCounts[entry.scope] = (scopeCounts[entry.scope] ?? 0) + 1;
        }
        return { total: entries.length, domainCounts, scopeCounts };
    }
    async formatForPrompt(opts = {}) {
        const anchors = await this.search({ ...opts, limit: opts.limit ?? 8 });
        if (anchors.length === 0)
            return '';
        const lines = ['## Physical Anchors'];
        for (const anchor of anchors) {
            lines.push(`- [${anchor.id}] ${anchor.title} (${anchor.domain}, scope: ${anchor.scope}, confidence: ${anchor.confidenceTier})`, `  Fact: ${anchor.fact}`);
            if (anchor.mechanism)
                lines.push(`  Mechanism: ${anchor.mechanism}`);
            lines.push(`  Implication: ${anchor.implication}`);
            if (anchor.robot)
                lines.push(`  Robot: ${anchor.robot}`);
            if (anchor.tags.length)
                lines.push(`  Tags: ${anchor.tags.slice(0, 6).join(', ')}`);
        }
        return lines.join('\n');
    }
    async listIds() {
        const ids = await listJsonIds(this.dir);
        return ids.filter(isPhysicalAnchorId);
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
        if (isPhysicalAnchorManifest(manifest))
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
        if (!isPhysicalAnchorManifest(manifest)) {
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
function isPhysicalAnchorManifest(value) {
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
//# sourceMappingURL=PhysicalAnchorStore.js.map