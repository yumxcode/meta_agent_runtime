/**
 * core/persist — shared JSON file persistence utilities.
 *
 * Every store in this codebase writes JSON files with the same atomic
 * write-then-rename pattern to prevent corruption on process crash.
 * These helpers centralise that pattern so it is implemented and
 * fixed in exactly one place.
 *
 * Usage:
 *   import { atomicWriteJson, readJsonFile, listJsonIds } from '../core/persist/index.js'
 */
/**
 * Ensure the parent directory of `filePath` exists (mkdir -p).
 * Safe to call repeatedly; a no-op if the directory already exists.
 */
export declare function ensureParentDir(filePath: string): Promise<void>;
/**
 * Ensure `dir` itself exists (mkdir -p).
 */
export declare function ensureDir(dir: string): Promise<void>;
/**
 * Read and parse a JSON file.
 *
 * Returns `null` when the file does not exist (ENOENT) or cannot be
 * parsed as JSON.  Never throws.
 */
export declare function readJsonFile<T = unknown>(filePath: string): Promise<T | null>;
/**
 * Atomically write `data` as pretty-printed JSON to `filePath`.
 *
 * Write-then-rename pattern:
 *   1. Ensure parent directory exists.
 *   2. Write to `<filePath>.<random8>.tmp`.
 *   3. rename() to `filePath` — atomic on POSIX; best-effort on Windows.
 *
 * A crash between steps 2 and 3 leaves an orphaned .tmp file but never
 * corrupts the live `filePath`.
 */
export declare function atomicWriteJson(filePath: string, data: unknown): Promise<void>;
/**
 * Atomically write a raw text payload to `filePath`.
 *
 * Same write-then-rename guarantees as atomicWriteJson, but for arbitrary
 * text (e.g. markdown views).  Crashes mid-write leave an orphan .tmp file
 * but never expose a half-written `filePath`.
 */
export declare function atomicWriteFile(filePath: string, contents: string): Promise<void>;
/**
 * List IDs of all JSON records in `dir`.
 *
 * Returns base names of every `*.json` file (excluding `.tmp` files),
 * with the `.json` extension stripped.  Returns an empty array when the
 * directory does not exist or cannot be read.
 */
export declare function listJsonIds(dir: string): Promise<string[]>;
/**
 * Delete `filePath`.  Silently ignores ENOENT (file already gone).
 * Re-throws other errors (permission denied, etc.).
 */
export declare function deleteJsonFile(filePath: string): Promise<void>;
//# sourceMappingURL=index.d.ts.map