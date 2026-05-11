/**
 * Meta-Agent Memory — path constants
 *
 * Single global memory directory: ~/.claude/meta-agent/memory/
 *
 * Unlike Claude Code (per-project paths), meta-agent memory is global because
 * domain_knowledge and campaign_lessons must be shared across engineering projects.
 * Per-project isolation can be added later via a subdirectory overlay if needed.
 */

import { homedir } from 'os'
import { join, sep } from 'path'

/** Root directory for all meta-agent memory files. Created on first use. */
export const MEMORY_DIR: string = join(homedir(), '.claude', 'meta-agent', 'memory') + sep

/** Filename of the index file that is always loaded into the system prompt. */
export const MEMORY_ENTRYPOINT_NAME = 'MEMORY.md'

/** Full path to the MEMORY.md index file. */
export function getMemoryEntrypoint(): string {
  return join(MEMORY_DIR, MEMORY_ENTRYPOINT_NAME)
}
