/**
 * DebugWriter — writes LLM request + response chunks to disk for debug mode.
 *
 * File layout:
 *   ~/.meta-agent/debug/<sessionId>/<ISO-timestamp>-<model>.jsonl
 *
 * Each file is newline-delimited JSON (JSONL):
 *   Line 0 : { "type": "request", "ts": <iso>, "payload": { ...req params (no apiKey) } }
 *   Line 1 : { "type": "done",    "ts": <iso> }
 *
 * Usage:
 *   const writer = await DebugWriter.open(sessionId, model, debug)
 *   await writer.writeRequest(reqParams)
 *   await writer.close()
 */

import { homedir } from 'os'
import { join } from 'path'
import { mkdir, open, readdir, rm, stat } from 'fs/promises'
import type { FileHandle } from 'fs/promises'

const DEBUG_ROOT = join(homedir(), '.meta-agent', 'debug')
const DEFAULT_DEBUG_TTL_MS = 14 * 24 * 60 * 60 * 1000   // 14 days
const DEFAULT_SESSION_DIR_SIZE_CAP = 200 * 1024 * 1024   // 200 MB per session

/**
 * S4: Best-effort cleanup of stale debug data.
 *
 * Two passes:
 *   1. Age pass — any session directory whose newest file is older than
 *      `ttlMs` (default 14 days) is removed in full.
 *   2. Size pass — within each surviving session directory, if total size
 *      exceeds `sessionSizeCapBytes`, the oldest `.jsonl` files are removed
 *      until under cap.
 *
 * Both passes swallow every error: this runs from session shutdown paths
 * where I/O failures must never block the host.  Returns a summary so
 * callers can log it if desired.
 */
export interface DebugPurgeOptions {
  /** Sessions whose newest file is older than this are deleted. */
  ttlMs?: number
  /** Per-session-directory size cap (bytes). */
  sessionSizeCapBytes?: number
  /** Override the debug root (mostly for tests). */
  rootDir?: string
}

export interface DebugPurgeSummary {
  scannedSessions: number
  removedSessions: number
  trimmedFiles: number
  bytesFreed: number
}

export async function pruneStaleDebug(
  options: DebugPurgeOptions = {},
): Promise<DebugPurgeSummary> {
  const ttlMs = options.ttlMs ?? DEFAULT_DEBUG_TTL_MS
  const sessionCap = options.sessionSizeCapBytes ?? DEFAULT_SESSION_DIR_SIZE_CAP
  const root = options.rootDir ?? DEBUG_ROOT
  const summary: DebugPurgeSummary = {
    scannedSessions: 0, removedSessions: 0, trimmedFiles: 0, bytesFreed: 0,
  }
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return summary  // debug dir never created — nothing to do
  }
  const now = Date.now()
  for (const sessionId of entries) {
    summary.scannedSessions++
    const sessionDir = join(root, sessionId)
    let files: string[]
    try { files = await readdir(sessionDir) } catch { continue }
    // Collect (name, size, mtime) for each file; tolerate stat errors.
    const records: Array<{ name: string; size: number; mtime: number }> = []
    let newestMtime = 0
    let totalSize = 0
    for (const name of files) {
      try {
        const s = await stat(join(sessionDir, name))
        if (!s.isFile()) continue
        records.push({ name, size: s.size, mtime: s.mtimeMs })
        if (s.mtimeMs > newestMtime) newestMtime = s.mtimeMs
        totalSize += s.size
      } catch { /* skip */ }
    }
    // Age pass — whole directory.
    if (records.length === 0 || (newestMtime > 0 && now - newestMtime > ttlMs)) {
      try {
        await rm(sessionDir, { recursive: true, force: true })
        summary.removedSessions++
        summary.bytesFreed += totalSize
      } catch { /* ignore */ }
      continue
    }
    // Size pass — drop oldest until under cap.
    if (totalSize > sessionCap) {
      records.sort((a, b) => a.mtime - b.mtime)
      for (const rec of records) {
        if (totalSize <= sessionCap) break
        try {
          await rm(join(sessionDir, rec.name), { force: true })
          totalSize -= rec.size
          summary.bytesFreed += rec.size
          summary.trimmedFiles++
        } catch { /* ignore */ }
      }
    }
  }
  return summary
}

function isoNow(): string {
  return new Date().toISOString()
}

/** Sanitise model string for use in a filename (replace `/` and `:` etc.) */
function safeModel(model: string): string {
  return model.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
}

export class DebugWriter {
  private constructor(private readonly fh: FileHandle) {}

  /** Open (create) a new debug file for one LLM call. Returns null when debug is disabled. */
  static async open(
    sessionId: string | undefined,
    model: string,
    debug: boolean | undefined,
  ): Promise<DebugWriter | null> {
    if (!debug || !sessionId) return null

    const dir = join(homedir(), '.meta-agent', 'debug', sessionId)
    await mkdir(dir, { recursive: true })

    const ts = isoNow().replace(/[:.]/g, '-')
    const filename = `${ts}-${safeModel(model)}.jsonl`
    const filepath = join(dir, filename)

    const fh = await open(filepath, 'a')
    return new DebugWriter(fh)
  }

  /** Write the full request payload (apiKey is stripped for safety). */
  async writeRequest(payload: Record<string, unknown>): Promise<void> {
    // Strip sensitive fields
    const { apiKey: _apiKey, ...safe } = payload as Record<string, unknown>
    void _apiKey
    const line = JSON.stringify({ type: 'request', ts: isoNow(), payload: safe })
    await this.fh.write(line + '\n')
  }

  /** Write a done sentinel and close the file handle. */
  async close(): Promise<void> {
    try {
      const line = JSON.stringify({ type: 'done', ts: isoNow() })
      await this.fh.write(line + '\n')
    } finally {
      await this.fh.close()
    }
  }
}
