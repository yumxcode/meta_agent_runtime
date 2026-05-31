/**
 * FileStateCache — tracks files that have been read during a session.
 *
 * CC uses this to re-read files after a compact boundary (since the model's
 * context no longer contains the previous file contents).
 *
 * Mirrors CC's fileStateCache.ts but simplified: we only need the file path
 * and a rough "last modified" timestamp to detect stale reads.
 */
export interface FileEntry {
    path: string;
    /** Wall-clock ms when the file was last read */
    readAt: number;
    /** File size at read time (bytes), used for compact re-attach size estimate */
    sizeBytes: number;
    /**
     * Last-known mtime (ms) of the file at read time.
     * Used by edit_file to detect concurrent modifications between read and edit
     * (TOCTOU defence). Undefined for legacy callers that don't supply it.
     */
    mtimeMs?: number;
}
export declare class FileStateCache {
    private _entries;
    private _maxEntries;
    constructor(maxEntries?: number);
    record(path: string, sizeBytes: number, mtimeMs?: number): void;
    has(path: string): boolean;
    get(path: string): FileEntry | undefined;
    getAll(): FileEntry[];
    clear(): void;
    size(): number;
    clone(): FileStateCache;
}
/** Create a FileStateCache with a custom size limit */
export declare function createFileStateCacheWithSizeLimit(maxEntries: number): FileStateCache;
export declare function cloneFileStateCache(cache: FileStateCache): FileStateCache;
//# sourceMappingURL=FileStateCache.d.ts.map