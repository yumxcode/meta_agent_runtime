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

import { mkdir, open, readFile, rename, writeFile, unlink, readdir, stat } from 'fs/promises'
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
 *
 * L1: a *missing* file is normal and stays silent, but a file that exists
 * yet fails to parse signals on-disk corruption.  Silently returning null
 * in that case would discard the user's data without a trace.  So on a parse
 * failure we (a) log a warning so the loss is discoverable, and (b) preserve
 * the bad bytes by renaming them to `<filePath>.corrupt` before returning
 * null — letting callers recover/inspect rather than overwriting blindly.
 */
export async function readJsonFile<T = unknown>(filePath: string): Promise<T | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    // ENOENT / unreadable — treat as "no record". Expected, stay silent.
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    console.error(
      `[meta-agent] corrupt JSON at ${filePath} — keeping a .corrupt backup:`,
      err instanceof Error ? err.message : String(err),
    )
    // Best-effort quarantine; never throw from a read helper.
    await rename(filePath, `${filePath}.corrupt`).catch(() => {})
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

/**
 * Atomically write a raw text payload to `filePath`.
 *
 * Same write-then-rename guarantees as atomicWriteJson, but for arbitrary
 * text (e.g. markdown views).  Crashes mid-write leave an orphan .tmp file
 * but never expose a half-written `filePath`.
 */
export async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  await ensureParentDir(filePath)
  const tmp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, contents, 'utf-8')
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

// ── Cross-process file lock ────────────────────────────────────────────────────

const DEFAULT_LOCK_STALE_MS = 30_000
const DEFAULT_LOCK_TIMEOUT_MS = 10_000
const LOCK_POLL_MS = 25

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Run `fn` while holding an exclusive, cross-process advisory lock for
 * `targetPath`.  The lock is a sentinel file at `<targetPath>.lock` created
 * with the `wx` flag (atomic "create only if absent" on POSIX and Windows),
 * so at most one process at a time enters the critical section for a path.
 *
 * M2: TeamStore's optimistic-concurrency check (read updatedAt → compare →
 * write) had a TOCTOU window between the read and the rename.  Wrapping the
 * whole check-then-write in this lock makes it atomic across processes, so two
 * machines sharing the file can no longer both pass the check and clobber each
 * other (lost update).
 *
 *   - staleMs: a lock whose file is older than this is presumed orphaned by a
 *     crashed holder and forcibly reclaimed.
 *   - timeoutMs: how long to wait for the lock before throwing.
 *
 * The lock file is always removed in a finally block, even if `fn` throws.
 */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: { staleMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const lockPath = `${targetPath}.lock`
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  await ensureParentDir(targetPath)

  const deadline = Date.now() + timeoutMs
  let acquired = false
  while (!acquired) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}`)
      await handle.close()
      acquired = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
      // Lock held by someone else — reclaim if stale, else wait and retry.
      try {
        const st = await stat(lockPath)
        if (Date.now() - st.mtimeMs > staleMs) {
          await unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        // Lock vanished between EEXIST and stat — retry immediately.
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`withFileLock: timed out after ${timeoutMs}ms waiting for ${lockPath}`)
      }
      await sleep(LOCK_POLL_MS)
    }
  }

  try {
    return await fn()
  } finally {
    await unlink(lockPath).catch(() => {})
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
