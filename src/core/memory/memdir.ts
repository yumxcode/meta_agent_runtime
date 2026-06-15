/**
 * Meta-Agent Memory — file I/O and prompt assembly
 *
 * Mirrors Claude Code's memdir.ts structure:
 *   - truncateEntrypointContent()   same 200-line / 25 KB caps + warning message
 *   - ensureMemoryDirExists()       mkdir -p, idempotent
 *   - loadMemoryIndex()             reads and truncates MEMORY.md
 */

import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join, dirname } from 'path'
import {
  MEMORY_DIR,
  MEMORY_ENTRYPOINT_NAME,
  getMemoryEntrypoint,
} from './paths.js'

// ─────────────────────────────────────────────────────────────────────────────
// Truncation constants — identical to CC
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum lines loaded from MEMORY.md (index). */
export const MAX_ENTRYPOINT_LINES = 200
/** Maximum bytes loaded from MEMORY.md; catches long-line abuse. */
export const MAX_ENTRYPOINT_BYTES = 25_000

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

/**
 * Truncate MEMORY.md content to the line AND byte caps, appending a warning
 * message that names which cap fired.  Line-truncates first (natural boundary),
 * then byte-truncates at the last newline before the cap so we never cut mid-line.
 *
 * Identical algorithm to CC's truncateEntrypointContent().
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed.split('\n')
  const lineCount = contentLines.length
  // Use byte length for the cap check — long lines are the failure mode the
  // byte cap targets, so post-line-truncation size would understate the warning.
  const byteCount = Buffer.byteLength(trimmed, 'utf-8')

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated }
  }

  // Step 1: line truncation
  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  // Step 2: byte truncation — cut at the last newline before the cap
  if (Buffer.byteLength(truncated, 'utf-8') > MAX_ENTRYPOINT_BYTES) {
    const buf = Buffer.from(truncated, 'utf-8')
    const sliced = buf.slice(0, MAX_ENTRYPOINT_BYTES)
    const lastNewline = sliced.lastIndexOf(0x0a /* '\n' */)
    truncated = sliced.slice(0, lastNewline > 0 ? lastNewline : MAX_ENTRYPOINT_BYTES).toString('utf-8')
  }

  const reason =
    wasLineTruncated && wasByteTruncated
      ? `${lineCount} lines and ${byteCount} bytes`
      : wasLineTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${byteCount} bytes (limit: ${MAX_ENTRYPOINT_BYTES})`

  return {
    content:
      truncated +
      `\n\n> WARNING: ${MEMORY_ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded.` +
      ` Keep index entries to one line under ~150 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure the memory directory exists.  Idempotent — called once per session
 * from the memory section resolver.  The model can write directly with the
 * Write tool without checking for directory existence.
 */
export async function ensureMemoryDirExists(): Promise<void> {
  try {
    await mkdir(MEMORY_DIR, { recursive: true })
  } catch {
    // mkdir recursive already swallows EEXIST.
    // Real permission errors (EACCES, EPERM) surface on first model Write call.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY.md loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read MEMORY.md and apply truncation caps.  Returns null when the file does
 * not exist or is empty.
 */
export async function loadMemoryIndex(): Promise<string | null> {
  try {
    const raw = await readFile(getMemoryEntrypoint(), 'utf-8')
    if (!raw.trim()) return null
    const repaired = await repairMemoryEntrypoint(raw, getMemoryEntrypoint())
    return truncateEntrypointContent(repaired).content
  } catch {
    // File not yet created — normal on first run
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// One-time entrypoint repair (legacy topic/index collision)
// ─────────────────────────────────────────────────────────────────────────────

let _repairAttempted = false

/** Test hook — allow the repair to run again within one process. */
export function resetMemoryRepairForTest(): void {
  _repairAttempted = false
}

/**
 * Heal a LEGACY malformed MEMORY.md: older memory-writer versions could name a
 * topic file `memory.md`, which on case-insensitive filesystems IS the
 * MEMORY.md entrypoint — the topic entry (frontmatter + body) and the index
 * bullets got mashed into one file, duplicating the entry in every render.
 *
 * Repair (runs at most once per process, only when the file STARTS with a
 * frontmatter fence):
 *   1. Split the embedded entry (frontmatter + body) from the bullet index.
 *   2. Write the entry to its own topic file `mem_<hash>.md` (skip if exists).
 *   3. Rewrite MEMORY.md with only the bullets, fixing `](memory.md)` links
 *      to point at the extracted file.
 * A backup of the original is kept as MEMORY.md.bak. On any failure the
 * original content is returned unchanged.
 */
export async function repairMemoryEntrypoint(
  raw: string,
  entrypointPath: string,
): Promise<string> {
  if (_repairAttempted) return raw
  _repairAttempted = true

  const trimmed = raw.trimStart()
  if (!trimmed.startsWith('---')) return raw

  try {
    // Locate the closing frontmatter fence.
    const fenceEnd = trimmed.indexOf('\n---', 3)
    if (fenceEnd < 0) return raw

    // The embedded entry = frontmatter + body up to the first index bullet
    // line (`- [name](file.md) - …`) or end of file.
    const afterFence = trimmed.indexOf('\n', fenceEnd + 1) + 1
    const bulletRe = /^- \[.*?\]\(.*?\.md\)/m
    const rest = trimmed.slice(afterFence)
    const bulletMatch = bulletRe.exec(rest)

    const entryBody = (bulletMatch ? rest.slice(0, bulletMatch.index) : rest).trim()
    const bullets = (bulletMatch ? rest.slice(bulletMatch.index) : '').trim()
    const frontmatter = trimmed.slice(0, afterFence).trim()
    if (!entryBody) return raw

    // Derive a stable topic filename from the entry name.
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
    const entryName = nameMatch?.[1]?.trim() ?? 'recovered_memory'
    const hash = createHash('sha1').update(entryName).digest('hex').slice(0, 8)
    const topicFilename = `mem_${hash}.md`
    const topicPath = join(dirname(entrypointPath), topicFilename)

    // 1. Persist the extracted entry (do not clobber an existing file).
    try {
      await readFile(topicPath, 'utf-8')
    } catch {
      await writeFile(topicPath, `${frontmatter}\n\n${entryBody}\n`, 'utf-8')
    }

    // 2. Rewrite the index: bullets only, with self-links repointed.
    const fixedBullets = bullets
      .replace(/\]\(memory\.md\)/gi, `](${topicFilename})`)
    const newIndex = fixedBullets || `- [${entryName}](${topicFilename}) - (recovered entry)`

    // 3. Backup + atomic-ish replace.
    await writeFile(`${entrypointPath}.bak`, raw, 'utf-8')
    const tmp = `${entrypointPath}.tmp`
    await writeFile(tmp, `${newIndex}\n`, 'utf-8')
    await rename(tmp, entrypointPath)

    return newIndex
  } catch {
    // Best-effort: never let a repair failure break memory loading.
    return raw
  }
}
