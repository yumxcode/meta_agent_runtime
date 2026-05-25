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
  path: string
  /** Wall-clock ms when the file was last read */
  readAt: number
  /** File size at read time (bytes), used for compact re-attach size estimate */
  sizeBytes: number
}

export class FileStateCache {
  private _entries = new Map<string, FileEntry>()
  private _maxEntries: number

  constructor(maxEntries = 200) {
    this._maxEntries = maxEntries
  }

  record(path: string, sizeBytes: number): void {
    this._entries.set(path, { path, readAt: Date.now(), sizeBytes })
    // LRU eviction: drop oldest entries if over limit
    if (this._entries.size > this._maxEntries) {
      const oldest = this._entries.keys().next().value
      if (oldest !== undefined) this._entries.delete(oldest)
    }
  }

  has(path: string): boolean {
    return this._entries.has(path)
  }

  get(path: string): FileEntry | undefined {
    return this._entries.get(path)
  }

  getAll(): FileEntry[] {
    return Array.from(this._entries.values())
  }

  clear(): void {
    this._entries.clear()
  }

  size(): number {
    return this._entries.size
  }

  clone(): FileStateCache {
    const copy = new FileStateCache(this._maxEntries)
    for (const [k, v] of this._entries) {
      copy._entries.set(k, { ...v })
    }
    return copy
  }
}

/** Create a FileStateCache with a custom size limit */
export function createFileStateCacheWithSizeLimit(maxEntries: number): FileStateCache {
  return new FileStateCache(maxEntries)
}

export function cloneFileStateCache(cache: FileStateCache): FileStateCache {
  return cache.clone()
}
