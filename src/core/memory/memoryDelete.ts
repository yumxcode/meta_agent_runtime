/**
 * Memory deletion — counterpart to commitMemoryProposal.
 *
 * Removes a committed memory topic file and prunes its pointer line(s) from the
 * shared MEMORY.md index. Listing is provided so the CLI can present committed
 * entries for selection (human `/memory delete`) or resolve an AI-proposed
 * deletion target (`/memory delete review`).
 */

import { readdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { MEMORY_DIR, MEMORY_ENTRYPOINT_NAME } from './paths.js'

export interface MemoryEntrySummary {
  /** Topic filename (e.g. "user_role.md") — the deletion target ID. */
  filename: string
  /** Human-readable name parsed from frontmatter, falling back to filename. */
  name: string
  /** One-line description parsed from frontmatter, if present. */
  description: string
  /** Memory type (user/feedback), if present. */
  type: string
}

function parseFrontmatterField(text: string, field: string): string {
  const m = text.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'))
  return m?.[1]?.trim() ?? ''
}

/**
 * List committed memory topic files (excludes the MEMORY.md index itself).
 */
export async function listMemoryEntries(
  memoryDir: string = MEMORY_DIR,
): Promise<MemoryEntrySummary[]> {
  let files: string[]
  try {
    files = await readdir(memoryDir)
  } catch {
    return []
  }
  const out: MemoryEntrySummary[] = []
  for (const f of files) {
    if (!f.endsWith('.md')) continue
    if (f === MEMORY_ENTRYPOINT_NAME) continue
    let body = ''
    try {
      body = await readFile(join(memoryDir, f), 'utf-8')
    } catch {
      continue
    }
    out.push({
      filename: f,
      name: parseFrontmatterField(body, 'name') || f.replace(/\.md$/, ''),
      description: parseFrontmatterField(body, 'description'),
      type: parseFrontmatterField(body, 'type'),
    })
  }
  out.sort((a, b) => a.filename.localeCompare(b.filename))
  return out
}

export type DeleteMemoryResult =
  | { ok: true; filename: string }
  | { ok: false; reason: 'not_found' | 'error'; detail?: string }

/**
 * Permanently delete a committed memory topic file and remove its pointer
 * line(s) from MEMORY.md (lines linking to `](filename)`).
 */
export async function deleteMemoryEntry(
  filename: string,
  memoryDir: string = MEMORY_DIR,
): Promise<DeleteMemoryResult> {
  const target = join(memoryDir, filename)
  let existed = true
  try {
    await rm(target)
  } catch {
    existed = false
  }

  // Prune the index pointer line(s) regardless, so a missing file still cleans up.
  try {
    const indexPath = join(memoryDir, MEMORY_ENTRYPOINT_NAME)
    let index = ''
    try {
      index = await readFile(indexPath, 'utf-8')
    } catch {
      index = ''
    }
    if (index) {
      const kept = index
        .split('\n')
        .filter(line => !line.includes(`](${filename})`))
        .join('\n')
      if (kept !== index) {
        await writeFile(indexPath, kept, 'utf-8')
      }
    }
  } catch (err) {
    return { ok: false, reason: 'error', detail: String(err) }
  }

  if (!existed) return { ok: false, reason: 'not_found', detail: filename }
  return { ok: true, filename }
}
