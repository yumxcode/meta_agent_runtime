/**
 * FileStateCache — tracks files that have been read during a session.
 *
 * CC uses this to re-read files after a compact boundary (since the model's
 * context no longer contains the previous file contents).
 *
 * Mirrors CC's fileStateCache.ts but simplified: we only need the file path
 * and a rough "last modified" timestamp to detect stale reads.
 */
export class FileStateCache {
    _entries = new Map();
    _maxEntries;
    constructor(maxEntries = 200) {
        this._maxEntries = maxEntries;
    }
    record(path, sizeBytes, mtimeMs) {
        this._entries.set(path, { path, readAt: Date.now(), sizeBytes, mtimeMs });
        // LRU eviction: drop oldest entries if over limit
        if (this._entries.size > this._maxEntries) {
            const oldest = this._entries.keys().next().value;
            if (oldest !== undefined)
                this._entries.delete(oldest);
        }
    }
    has(path) {
        return this._entries.has(path);
    }
    get(path) {
        return this._entries.get(path);
    }
    getAll() {
        return Array.from(this._entries.values());
    }
    clear() {
        this._entries.clear();
    }
    size() {
        return this._entries.size;
    }
    clone() {
        const copy = new FileStateCache(this._maxEntries);
        for (const [k, v] of this._entries) {
            copy._entries.set(k, { ...v });
        }
        return copy;
    }
}
/** Create a FileStateCache with a custom size limit */
export function createFileStateCacheWithSizeLimit(maxEntries) {
    return new FileStateCache(maxEntries);
}
export function cloneFileStateCache(cache) {
    return cache.clone();
}
//# sourceMappingURL=FileStateCache.js.map