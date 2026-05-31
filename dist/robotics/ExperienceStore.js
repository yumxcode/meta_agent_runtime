import { readFile, readdir, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { atomicWriteJson, readJsonFile, ensureDir } from '../core/persist/index.js';
import { makeExperienceId } from './types.js';
const EXPERIENCE_ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'experiences');
const INDEX_FILE = 'EXPERIENCE_INDEX.md';
const MANIFEST_FILE = 'EXPERIENCE_MANIFEST.json';
const MAX_INDEX_ENTRIES = 100; // hard cap on index entries shown
const LOAD_CONCURRENCY = 32;
const EXPERIENCE_ID_RE = /^exp_[0-9a-z]+_[0-9a-f]{8}$/;
export function isExperienceId(id) {
    return EXPERIENCE_ID_RE.test(id);
}
const CONFIDENCE_WEIGHT = {
    reproduced: 500,
    observed: 400,
    derived: 350,
    reported: 200,
    hypothesis: 100,
};
export function experienceRetrievalScore(entry) {
    const tier = entry.confidenceTier ?? 'observed';
    const observations = Math.max(1, entry.observationCount ?? 1);
    const contradictions = Math.max(0, entry.contradictionCount ?? 0);
    return CONFIDENCE_WEIGHT[tier] + Math.min(observations, 10) * 8 - contradictions * 40;
}
export class ExperienceStore {
    dir;
    indexPath;
    manifestPath;
    constructor(dir) {
        this.dir = dir ?? EXPERIENCE_ROOT;
        this.indexPath = join(this.dir, INDEX_FILE);
        this.manifestPath = join(this.dir, MANIFEST_FILE);
    }
    async ensureDir() {
        await ensureDir(this.dir);
    }
    // ── Write ───────────────────────────────────────────────────────────────────
    async write(entry) {
        await this.ensureDir();
        const id = makeExperienceId();
        const full = {
            ...entry,
            id,
            schemaVersion: '1.0',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        const file = join(this.dir, `${id}.json`);
        await atomicWriteJson(file, full);
        await this.rebuildIndex();
        return id;
    }
    // ── Search ──────────────────────────────────────────────────────────────────
    async search(query) {
        const limit = Math.min(query.limit ?? 10, 20);
        const entries = await this._loadSearchEntries();
        const filtered = entries.filter(e => {
            if (query.domain && e.domain !== query.domain)
                return false;
            if (query.robot && e.robot !== query.robot)
                return false;
            if (query.algorithm && e.algorithm?.toLowerCase() !== query.algorithm.toLowerCase())
                return false;
            if (query.successOnly && !e.outcome.success)
                return false;
            if (query.tags?.length) {
                const haystack = e.tags.map(t => t.toLowerCase());
                if (!query.tags.every(t => haystack.includes(t.toLowerCase())))
                    return false;
            }
            if (query.keyword) {
                const kw = query.keyword.toLowerCase();
                const searchable = `${e.title} ${e.problem} ${e.solution}`.toLowerCase();
                if (!searchable.includes(kw))
                    return false;
            }
            return true;
        });
        // Prefer stronger evidence; keep recency as a tiebreaker.
        filtered.sort((a, b) => {
            const scoreDelta = experienceRetrievalScore(b) - experienceRetrievalScore(a);
            return scoreDelta !== 0 ? scoreDelta : b.createdAt - a.createdAt;
        });
        // strip fullReport from search results
        return filtered.slice(0, limit);
    }
    // ── Load by ID ───────────────────────────────────────────────────────────────
    async load(id) {
        if (!isExperienceId(id))
            return null;
        return readJsonFile(join(this.dir, `${id}.json`));
    }
    async appendPrincipleReference(experienceId, principleId) {
        if (!isExperienceId(experienceId))
            return false;
        const entry = await this.load(experienceId);
        if (!entry)
            return false;
        const principleIds = entry.principleIds ?? [];
        if (principleIds.includes(principleId))
            return true;
        const updated = {
            ...entry,
            principleIds: [...principleIds, principleId],
            updatedAt: Date.now(),
        };
        await atomicWriteJson(join(this.dir, `${experienceId}.json`), updated);
        await this.rebuildIndex();
        return true;
    }
    async getStats() {
        const entries = await this._loadSearchEntries();
        const domainCounts = {};
        let failures = 0;
        for (const e of entries) {
            if (!e.outcome.success)
                failures += 1;
            domainCounts[e.domain] = (domainCounts[e.domain] ?? 0) + 1;
        }
        return { total: entries.length, failures, domainCounts };
    }
    // ── Index ───────────────────────────────────────────────────────────────────
    async loadIndexMarkdown() {
        try {
            return await readFile(this.indexPath, 'utf-8');
        }
        catch {
            return '';
        }
    }
    async rebuildIndex() {
        const entries = await this._loadAllFromFiles();
        entries.sort((a, b) => b.createdAt - a.createdAt);
        await this._writeManifest(entries);
        // Group by domain
        const byDomain = new Map();
        for (const e of entries.slice(0, MAX_INDEX_ENTRIES)) {
            const list = byDomain.get(e.domain) ?? [];
            list.push(e);
            byDomain.set(e.domain, list);
        }
        const lines = [
            `# Experience Index`,
            `*Last updated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} | Total: ${entries.length} entries*`,
            '',
        ];
        for (const [domain, domEntries] of byDomain) {
            lines.push(`## ${domain} (${domEntries.length})`);
            for (const e of domEntries) {
                const icon = e.outcome.success ? '✓' : '✗';
                const tags = e.tags.slice(0, 4).join(', ');
                const confidence = e.confidenceTier ?? 'observed';
                lines.push(`- [${e.id}] **${e.title}** | ${icon} ${e.outcome.summary.slice(0, 60)} | confidence: ${confidence} | tags: ${tags}`);
            }
            lines.push('');
        }
        lines.push('## Quick Search');
        lines.push('`experience_search domain=<domain> tags=<tag1,tag2> keyword=<word>`');
        lines.push('`experience_load id=<id>` — load full entry with report');
        // Index is Markdown not JSON — use writeFile directly (not atomicWriteJson)
        await writeFile(this.indexPath, lines.join('\n'), 'utf-8');
    }
    async listIds() {
        try {
            const files = await readdir(this.dir);
            return files
                .filter(f => f.endsWith('.json'))
                .map(f => f.replace('.json', ''))
                .filter(isExperienceId);
        }
        catch {
            return [];
        }
    }
    // ── Internal ─────────────────────────────────────────────────────────────────
    async _loadAll() {
        return this._loadAllFromFiles();
    }
    async _loadAllFromFiles() {
        const ids = await this.listIds();
        return loadWithConcurrency(ids, id => this.load(id));
    }
    async _loadSearchEntries() {
        const manifest = await readJsonFile(this.manifestPath);
        if (isExperienceManifest(manifest))
            return manifest.entries;
        const entries = await this._loadAllFromFiles();
        await this._writeManifest(entries).catch(() => undefined);
        return entries.map(stripFullReport);
    }
    async _writeManifest(entries) {
        const manifest = {
            schemaVersion: '1.0',
            updatedAt: Date.now(),
            entries: entries.map(stripFullReport),
        };
        await atomicWriteJson(this.manifestPath, manifest);
    }
}
function stripFullReport(entry) {
    const { fullReport: _, ...rest } = entry;
    return rest;
}
function isExperienceManifest(value) {
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
//# sourceMappingURL=ExperienceStore.js.map