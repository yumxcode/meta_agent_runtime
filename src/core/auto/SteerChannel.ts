/**
 * SteerChannel — out-of-band mid-turn corrections for unattended runs.
 *
 * The interactive REPL steers with Ctrl+G: it owns stdin, so a keystroke is the
 * natural channel. `meta-agent auto-scheduler` cannot use that at all — it never
 * touches readline, stdin is not in raw mode, and it is routinely run detached
 * (nohup / systemd / tmux) where there is no TTY to press a key in. With
 * `--max-concurrent > 1` a keystroke would also be ambiguous: several sessions
 * resume in the same process, and a single key cannot say which one it meant.
 *
 * So unattended steering goes through the filesystem instead:
 *
 *     meta-agent steer <sessionId> "actually, prefer the smaller mesh"
 *          ↓ writes one file
 *     <projectDir>/.meta-agent/steer/<sessionId>/<uuid>.json
 *          ↓ the running loop polls and drains
 *     router.steer(text) → KernelSession._steerQueue → KernelLoop.drainSteering()
 *
 * The correction lands as a user message at the loop's next iteration boundary.
 * It does NOT abort the in-flight model stream — same semantics as Ctrl+G.
 *
 * Design notes:
 *
 * - ONE FILE PER MESSAGE, uuid-named. Writers never read, and readers only
 *   delete what they consumed, so there is no read-modify-write window and no
 *   lock is needed even with several writers and a reader running concurrently.
 *   (A single append-file would have needed withFileLock on every poll.)
 * - Ordering is by write time, recovered from the record's own `at` field
 *   rather than from readdir order, which no filesystem guarantees.
 * - Enqueuing to a session that nobody is running is NOT an error: the message
 *   simply waits. `prune()` clears anything older than the retention window so a
 *   queue for a session that never resumes cannot grow forever.
 */
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { atomicWriteJson, ensureDir } from '../../infra/persist/index.js'

/**
 * Read a queued message WITHOUT the shared `readJsonFile` helper.
 *
 * That helper quarantines an unparseable file by renaming it to
 * `<name>.<ts>.corrupt` — correct for a durable store where the bytes are the
 * user's data, wrong for a transient queue: the rename leaves an orphan that no
 * longer ends in `.json`, so neither drain nor prune can ever see it again and
 * it accumulates in the workspace forever. Here a message that cannot be parsed
 * is simply discarded, so `null` means "delete this file".
 */
async function readMessage(path: string): Promise<SteerMessage | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as SteerMessage
  } catch {
    return null
  }
}

/** Retention for messages nobody ever drained. */
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000

/** Hard cap on a single correction, so a stray `steer < bigfile` can't blow up the context. */
export const MAX_STEER_TEXT_CHARS = 4_000

export interface SteerMessage {
  schemaVersion: '1.0'
  id: string
  sessionId: string
  text: string
  at: number
  /** Who enqueued it — informational, shown in the loop's acknowledgement. */
  origin: string
}

/** Root of the steer queues for a project. */
export function steerRoot(projectDir: string): string {
  return join(resolve(projectDir), '.meta-agent', 'steer')
}

/** Queue directory for one session. */
export function steerDir(projectDir: string, sessionId: string): string {
  return join(steerRoot(projectDir), encodeURIComponent(sessionId))
}

/**
 * Enqueue a correction for `sessionId`. Returns the message id.
 *
 * Deliberately does not check whether a session is actually running: the
 * scheduler may pick the wake up seconds later, and failing here would make the
 * command racy to use.
 */
export async function enqueueSteer(
  projectDir: string,
  sessionId: string,
  text: string,
  origin = 'cli',
): Promise<SteerMessage> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('steer text is empty')

  const dir = steerDir(projectDir, sessionId)
  await ensureDir(dir)

  const message: SteerMessage = {
    schemaVersion: '1.0',
    id: randomUUID(),
    sessionId,
    text: trimmed.length > MAX_STEER_TEXT_CHARS
      ? `${trimmed.slice(0, MAX_STEER_TEXT_CHARS)}\n[truncated at ${MAX_STEER_TEXT_CHARS} chars]`
      : trimmed,
    at: Date.now(),
    origin,
  }
  await atomicWriteJson(join(dir, `${message.id}.json`), message)
  return message
}

/**
 * Remove and return every queued correction for `sessionId`, oldest first.
 *
 * A file that fails to parse is deleted rather than retried: it would otherwise
 * be re-read on every poll for the life of the run.
 */
export async function drainSteer(projectDir: string, sessionId: string): Promise<SteerMessage[]> {
  const dir = steerDir(projectDir, sessionId)

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []                       // no queue yet — the common case
  }

  const messages: SteerMessage[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const path = join(dir, entry)
    const record = await readMessage(path)
    // Consume unconditionally: a parsed message is delivered, an unparseable one
    // is dropped. Either way it must not be seen again.
    await rm(path, { force: true }).catch(() => undefined)
    if (record?.schemaVersion === '1.0' && typeof record.text === 'string' && record.text) {
      messages.push(record)
    }
  }

  // readdir order is not defined; order by the writer's own timestamp so
  // corrections arrive in the order they were issued.
  messages.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  return messages
}

/** Number of queued corrections without consuming them (for `steer --list`). */
export async function pendingSteerCount(projectDir: string, sessionId: string): Promise<number> {
  try {
    return (await readdir(steerDir(projectDir, sessionId))).filter(e => e.endsWith('.json')).length
  } catch {
    return 0
  }
}

/** Drop the whole queue for a session (used when a run ends). */
export async function clearSteer(projectDir: string, sessionId: string): Promise<void> {
  await rm(steerDir(projectDir, sessionId), { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Delete messages older than `olderThanMs` across every session queue, and
 * remove queue directories left empty. Returns how many messages were removed.
 *
 * Without this, a correction typed for a session that is never resumed would sit
 * on disk indefinitely and then be injected — possibly days later — the next
 * time that session id happened to run.
 */
export async function pruneSteer(
  projectDir: string,
  olderThanMs = DEFAULT_RETENTION_MS,
  now = Date.now(),
): Promise<number> {
  const root = steerRoot(projectDir)
  let dirs: string[]
  try {
    dirs = await readdir(root)
  } catch {
    return 0
  }

  let removed = 0
  for (const sessionDir of dirs) {
    const dir = join(root, sessionDir)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      // Every file, not just *.json: this is also the sweep that removes any
      // stray leftovers so a queue directory cannot accumulate junk.
      const path = join(dir, entry)
      // Prefer the record's own timestamp; fall back to mtime for a file whose
      // contents are unreadable.
      const record = await readMessage(path)
      let at = record?.at
      if (typeof at !== 'number') {
        at = await stat(path).then(s => s.mtimeMs).catch(() => now)
      }
      if (now - at > olderThanMs) {
        await rm(path, { force: true }).catch(() => undefined)
        removed++
      }
    }
    // Tidy up an emptied queue directory.
    try {
      if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true })
    } catch { /* best-effort */ }
  }
  return removed
}
