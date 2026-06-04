/**
 * Shared memory-proposal helpers.
 *
 * A single source of truth for normalising, rendering, and committing memory
 * entries.  Three call paths share this module so frontmatter and mode
 * boundaries stay identical across all of them:
 *
 *   1. memory_write tool      — LLM-proposed memories (queued for review)
 *   2. runPostSessionMemoryWriter — flash side-call proposals (queued for review)
 *   3. /memory review (commit)    — user-approved entries written to disk
 *
 * Memory is global and strictly limited to `user` and `feedback` types; all
 * engineering experience lives in ExperienceStore, never here.
 */

import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'
import { atomicWriteFile } from '../persist/index.js'
import { ensureMemoryDirExists } from './memdir.js'
import { MEMORY_DIR, MEMORY_ENTRYPOINT_NAME } from './paths.js'
import { MEMORY_TYPES, type MemoryType } from './types.js'

// ── Types ───────────────────────────────────────────────────────────────────

/** Raw, untyped proposal shape (from flash JSON or the LLM tool call). */
export type RawMemoryProposal = {
  filename?: unknown
  name?: unknown
  description?: unknown
  type?: unknown
  domain?: unknown
  source?: unknown
  source_verified?: unknown
  requires_revalidation?: unknown
  body?: unknown
  index_line?: unknown
}

/** Validated proposal — every field already sanitised and ready to render. */
export type NormalizedMemoryProposal = {
  filename: string
  name: string
  description: string
  type: MemoryType
  domain?: string
  source?: string
  source_verified?: boolean
  requires_revalidation?: boolean
  body: string
  index_line: string
}

// ── Mode boundary ─────────────────────────────────────────────────────────────

/**
 * Memory is strictly limited to user profile and agent-behaviour feedback.
 * All engineering experience (lessons, domain knowledge, references) lives in
 * ExperienceStore or project docs — never in memory.  The `_mode` parameter is
 * retained for signature symmetry but the allowed set is mode-independent.
 */
export function allowedTypesForMode(_mode: string): ReadonlySet<MemoryType> {
  return new Set<MemoryType>(['user', 'feedback'])
}

// ── Sanitisers ──────────────────────────────────────────────────────────────

export function sanitizeScalar(value: unknown, max = 240): string | undefined {
  if (typeof value !== 'string') return undefined
  // Strip \r and \n to prevent YAML frontmatter injection (a multi-line value
  // such as "name\ntype: injected" would add an extra key to the frontmatter).
  const trimmed = value.replace(/[\r\n]/g, ' ').trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, max)
}

export function sanitizeFilename(value: unknown, fallbackName: string): string {
  const raw = sanitizeScalar(value, 120) ?? fallbackName
  const base = raw
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
  if (base) return `${base}.md`
  // Non-Latin names (e.g. Chinese) produce an empty base after ASCII-only sanitization.
  // Use a stable short hash of the original name so every entry gets a unique filename
  // instead of all colliding on the generic 'memory.md' fallback.
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 8)
  return `mem_${hash}.md`
}

function stripUnsupportedFrontmatter(text: string): string {
  return text
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/^\s*(campaign|valid_until|confidence)\s*:.*$/gmi, '')
    .trim()
}

// ── Normalise ─────────────────────────────────────────────────────────────────

/**
 * Validate + sanitise a raw proposal into a NormalizedMemoryProposal, or return
 * null when required fields are missing or the type is disallowed for the mode.
 */
export function normalizeMemoryProposal(
  raw: RawMemoryProposal,
  mode: string,
  domain?: string,
): NormalizedMemoryProposal | null {
  const name = sanitizeScalar(raw.name, 160)
  const description = sanitizeScalar(raw.description, 240)
  const body = sanitizeScalar(raw.body, 4000)
  const type = sanitizeScalar(raw.type, 80) as MemoryType | undefined
  if (!name || !description || !body || !type) return null
  if (!MEMORY_TYPES.includes(type)) return null
  if (!allowedTypesForMode(mode).has(type)) return null

  const filename = sanitizeFilename(raw.filename, name)
  const normalizedDomain = sanitizeScalar(raw.domain, 80) ?? domain
  const indexLine =
    sanitizeScalar(raw.index_line, 300) ??
    `- [${name}](${filename}) - ${description}`

  return {
    filename,
    name,
    description,
    type,
    domain: normalizedDomain,
    source: sanitizeScalar(raw.source, 240),
    source_verified: typeof raw.source_verified === 'boolean' ? raw.source_verified : undefined,
    requires_revalidation: typeof raw.requires_revalidation === 'boolean' ? raw.requires_revalidation : undefined,
    body,
    index_line: indexLine.includes(`](${filename})`)
      ? indexLine
      : `- [${name}](${filename}) - ${description}`,
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

export function renderMemoryFile(proposal: NormalizedMemoryProposal): string {
  const lines = [
    '---',
    `name: ${sanitizeScalar(proposal.name, 160)}`,
    `description: ${sanitizeScalar(proposal.description, 240)}`,
    `type: ${sanitizeScalar(proposal.type, 80)}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
  ]
  const domain = sanitizeScalar(proposal.domain, 80)
  if (domain) {
    lines.push('scope: domain', `domain: ${domain}`)
  }
  const source = sanitizeScalar(proposal.source, 240)
  if (source) lines.push(`source: ${source}`)
  if (typeof proposal.source_verified === 'boolean') {
    lines.push(`source_verified: ${proposal.source_verified ? 'true' : 'false'}`)
  }
  if (typeof proposal.requires_revalidation === 'boolean') {
    lines.push(`requires_revalidation: ${proposal.requires_revalidation ? 'true' : 'false'}`)
  }
  lines.push('---', '', stripUnsupportedFrontmatter(String(proposal.body)), '')
  return lines.join('\n')
}

// ── Commit ────────────────────────────────────────────────────────────────────

export type CommitMemoryResult =
  | { ok: true; filename: string }
  | { ok: false; reason: 'duplicate' | 'exists' | 'error'; detail?: string }

/**
 * Returns true when the MEMORY.md index already references this proposal —
 * checked by exact link anchor `](filename)` OR exact name match on a line
 * boundary, to avoid false positives from substring occurrences.
 */
function isDuplicateInIndex(index: string, proposal: NormalizedMemoryProposal): boolean {
  if (index.includes(`](${proposal.filename})`)) return true
  // Exact name match: must be surrounded by non-word chars / line boundaries
  const escapedName = proposal.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^\\w])${escapedName}(?:[^\\w]|$)`, 'm').test(index)
}

/**
 * Write one approved proposal to disk: render the topic file and append a
 * pointer line to MEMORY.md.  Skips writing when an entry with the same
 * filename or name already exists in the index, or when the target file is
 * already present — unless `overwrite` is true, in which case the existing
 * file and index line are replaced.
 *
 * @param existingIndex  Optional snapshot of the current MEMORY.md content used
 *                       for the duplicate check.  When omitted it is loaded from
 *                       disk.
 * @param overwrite      When true, replace an existing same-named entry instead
 *                       of returning a duplicate error.
 */
export async function commitMemoryProposal(
  proposal: NormalizedMemoryProposal,
  memoryDir: string = MEMORY_DIR,
  existingIndex?: string,
  overwrite?: boolean,
): Promise<CommitMemoryResult> {
  if (memoryDir === MEMORY_DIR) await ensureMemoryDirExists()
  else await mkdir(memoryDir, { recursive: true })

  let index = existingIndex
  if (index === undefined) {
    try {
      index = await readFile(join(memoryDir, MEMORY_ENTRYPOINT_NAME), 'utf-8')
    } catch {
      index = ''
    }
  }

  const isDup = isDuplicateInIndex(index, proposal)

  // Check physical file existence (may exist even if not indexed)
  const target = join(memoryDir, proposal.filename)
  let fileExists = false
  try {
    await readFile(target, 'utf-8')
    fileExists = true
  } catch {
    // File does not exist.
  }

  if ((isDup || fileExists) && !overwrite) {
    return { ok: false, reason: isDup ? 'duplicate' : 'exists', detail: proposal.filename }
  }

  try {
    // Write (or overwrite) the topic file.
    await atomicWriteFile(target, renderMemoryFile(proposal))

    const indexLine = proposal.index_line.replace(/\r?\n/g, ' ').trim()

    if (overwrite && isDup) {
      // Replace the old index line with the new one.
      const escapedFilename = proposal.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const escapedName = proposal.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const updatedIndex = index
        .split('\n')
        .map(line => {
          if (line.includes(`](${proposal.filename})`) ||
              new RegExp(`(?:^|[^\\w])${escapedName}(?:[^\\w]|$)`).test(line)) {
            return indexLine
          }
          return line
        })
        .join('\n')
      await writeFile(join(memoryDir, MEMORY_ENTRYPOINT_NAME), updatedIndex, 'utf-8')
    } else {
      // Append new index line.
      await appendFile(
        join(memoryDir, MEMORY_ENTRYPOINT_NAME),
        `${index.trim() ? '\n' : ''}${indexLine}\n`,
        'utf-8',
      )
    }

    return { ok: true, filename: proposal.filename }
  } catch (err) {
    return { ok: false, reason: 'error', detail: String(err) }
  }
}
