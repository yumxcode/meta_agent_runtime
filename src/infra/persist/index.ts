/**
 * core/persist — shared JSON file persistence utilities.
 *
 * Every store in this codebase writes JSON files with the same atomic
 * write-then-rename pattern to prevent corruption on process crash.
 * These helpers centralise that pattern so it is implemented and
 * fixed in exactly one place.
 *
 * Usage:
 *   import { atomicWriteJson, readJsonFile, listJsonIds } from '../persist/index.js' (or core/persist shim)
 */

import { mkdir, open, readFile, rename, writeFile, unlink, readdir, stat, utimes } from 'fs/promises'
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
    //
    // The quarantine name carries a timestamp because a fixed `.corrupt`
    // suffix meant the SECOND corruption silently overwrote the forensic copy
    // of the first — exactly when you most want both.
    await rename(filePath, `${filePath}.${Date.now()}.corrupt`).catch(() => {})
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
 *
 * Durability level is `process-crash-local-posix` (see
 * loop/graph/operations/ReliabilityProfile.ts): there is deliberately no
 * fsync, so a process crash is safe but a machine power-loss can still lose
 * the most recent write. Raising this to `fsync-local-posix` is a change to
 * THIS function alone — every store in the codebase funnels through it.
 */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await ensureParentDir(filePath)
  const tmp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
    await rename(tmp, filePath)
  } catch (err) {
    // A failed rename (cross-device, ENOSPC, permissions) used to strand the
    // temp file forever; they accumulated in .loop/ and .meta-agent/ where
    // nothing ever swept them.
    await unlink(tmp).catch(() => {})
    throw err
  }
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
  try {
    await writeFile(tmp, contents, 'utf-8')
    await rename(tmp, filePath)
  } catch (err) {
    await unlink(tmp).catch(() => {})   // don't strand the temp file (see atomicWriteJson)
    throw err
  }
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
 *
 * M3: the lock file's mtime is REFRESHED while the lock is held (see
 * `keepAlive` below). Previously mtime was stamped once at creation and never
 * touched again, so staleness was measured against acquisition time rather than
 * liveness: any critical section that outlived `staleMs` (default 30s) was
 * reclaimed out from under its live holder and two processes entered the
 * section together. The owner-token check in the finally block only prevented
 * the LOSER from deleting the winner's lock — the mutual exclusion was already
 * gone by then, so the data race had happened.
 *
 * This was reachable in practice: `ExperienceStore.rebuildIndex` holds the
 * default 30s lock across an `rm -rf` of the index directory plus one write per
 * experience entry, which exceeds 30s on a large store or a slow/network disk.
 * With the heartbeat, `staleMs` now means what it reads like — "the holder has
 * stopped heartbeating, so it died" — and stale reclamation only fires for
 * genuinely dead holders.
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

  // M1: a unique owner token written into the lock file lets the release step
  // verify the lock is still OURS before unlinking. Without it, a lock reclaimed
  // as stale by another process (because our `fn` outran staleMs) would be
  // deleted by our finally block — wiping the new holder's lock and letting two
  // processes into the critical section.
  const ownerToken = `${process.pid}.${randomUUID()}`

  const deadline = Date.now() + timeoutMs
  let acquired = false
  while (!acquired) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(`${ownerToken} ${new Date().toISOString()}`)
      await handle.close()
      acquired = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
      // Lock held by someone else — reclaim if stale, else wait and retry.
      //
      // M1-fix: stale reclamation must not unlink() directly.  Two processes
      // can both observe the same stale lock; if A unlinks + recreates first,
      // B's later unlink would delete A's FRESH lock and both would enter the
      // critical section.  Instead we claim the stale lock via rename() —
      // atomic, so exactly ONE process wins the claim; the loser's rename
      // fails with ENOENT and it simply retries against the new state.
      try {
        const st = await stat(lockPath)
        if (Date.now() - st.mtimeMs > staleMs) {
          const claimPath = `${lockPath}.${process.pid}.${randomUUID().slice(0, 8)}.reclaim`
          try {
            await rename(lockPath, claimPath)
            await unlink(claimPath).catch(() => {})
          } catch {
            // Someone else claimed it first — fall through and retry.
          }
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

  // M3: heartbeat the lock's mtime for as long as we hold it, so a slow `fn`
  // is never mistaken for a crashed holder. staleMs/3 gives two missed beats of
  // headroom before another process is entitled to reclaim. The timer is
  // unref'd so it can never keep the process alive on its own, and the write is
  // best-effort: a transient utimes failure just means one skipped beat.
  const heartbeatMs = Math.max(50, Math.floor(staleMs / 3))
  const keepAlive = setInterval(() => {
    const now = new Date()
    void utimes(lockPath, now, now).catch(() => {})
  }, heartbeatMs)
  keepAlive.unref?.()

  try {
    return await fn()
  } finally {
    clearInterval(keepAlive)
    // M1: only remove the lock if it is still the one WE created. If `fn` ran
    // longer than staleMs another process may have reclaimed the lock and
    // written its own token; unlinking unconditionally would delete that fresh
    // lock. Read-then-unlink narrows the window to near-zero (a full atomic
    // compare-and-delete isn't available on POSIX).
    try {
      const current = await readFile(lockPath, 'utf-8')
      if (current.startsWith(ownerToken)) {
        await unlink(lockPath).catch(() => {})
      }
    } catch {
      // Lock already gone or unreadable — nothing to release.
    }
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
