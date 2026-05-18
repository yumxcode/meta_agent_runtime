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

import { mkdir, readFile, rename, writeFile, unlink, readdir } from 'fs/promises'
import { dirname } from 'path'
import { randomUUID } from 'crypto'

// ── Directory helpers ─────────────────────────────────────────────────────────

/**
 * Ensure the parent directory of `filePath` exists (mkdir -p).
 * Safe to call repeatedly; a no-op if the directory already exists.
 */
export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
}

/**
 * Ensure `dir` itself exists (mkdir -p).
 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Read and parse a JSON file.
 *
 * Returns `null` when the file does not exist (ENOENT) or cannot be
 * parsed as JSON.  Never throws.
 */
export async function readJsonFile<T = unknown>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

// ── Write ─────────────────────────────────────────────────────────────────────

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
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await ensureParentDir(filePath)
  const tmp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tmp, filePath)
}

// ── Directory listing ─────────────────────────────────────────────────────────

/**
 * List IDs of all JSON records in `dir`.
 *
 * Returns base names of every `*.json` file (excluding `.tmp` files),
 * with the `.json` extension stripped.  Returns an empty array when the
 * directory does not exist or cannot be read.
 */
export async function listJsonIds(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries
      .filter(e => e.endsWith('.json') && !e.endsWith('.tmp'))
      .map(e => e.slice(0, -5))
  } catch {
    return []
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

/**
 * Delete `filePath`.  Silently ignores ENOENT (file already gone).
 * Re-throws other errors (permission denied, etc.).
 */
export async function deleteJsonFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
  }
}
