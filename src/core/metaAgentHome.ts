/**
 * metaAgentHome — single source of truth for the meta-agent data directory.
 *
 * All persisted state (memory, experiences, principles, projects, campaigns,
 * subtasks, contracts, config, …) lives under one root:
 *
 *     ~/.meta-agent/
 *
 * Historically this data was stored under `~/.claude/meta-agent/`, but that
 * directory belongs to the Claude CLI — not to meta-agent. To avoid colliding
 * with another product's home and to give meta-agent its own namespace, the
 * root moved to `~/.meta-agent/`.
 *
 * Backward compatibility: on first import, if the new root does not yet exist
 * but the legacy `~/.claude/meta-agent/` does, the legacy directory is migrated
 * (moved) in place so existing users keep all their data. The migration is
 * idempotent and best-effort — any failure leaves the legacy data untouched and
 * the stores simply recreate an empty new root on demand.
 */

import { homedir } from 'os'
import { join, dirname } from 'path'
import { existsSync, mkdirSync, renameSync, cpSync, rmSync } from 'fs'

/** Current root: ~/.meta-agent */
export const META_AGENT_HOME: string = join(homedir(), '.meta-agent')

/** Legacy root: ~/.claude/meta-agent (migrated away from on first run). */
export const LEGACY_META_AGENT_HOME: string = join(homedir(), '.claude', 'meta-agent')

let _migrated = false

/**
 * Move legacy `~/.claude/meta-agent` → `~/.meta-agent` exactly once, if needed.
 * Safe to call repeatedly; only the first call does any work.
 */
export function ensureMetaAgentHomeMigrated(): void {
  if (_migrated) return
  _migrated = true

  // Skip filesystem side effects under the test runner so unit tests never
  // touch (or migrate) the developer's real home directory.
  if (process.env['VITEST'] || process.env['META_AGENT_SKIP_MIGRATION']) return

  try {
    if (existsSync(META_AGENT_HOME) || !existsSync(LEGACY_META_AGENT_HOME)) return
    mkdirSync(dirname(META_AGENT_HOME), { recursive: true })
    try {
      // Fast path: atomic rename when on the same filesystem.
      renameSync(LEGACY_META_AGENT_HOME, META_AGENT_HOME)
    } catch {
      // Cross-device or partial rename: copy then remove the legacy tree.
      cpSync(LEGACY_META_AGENT_HOME, META_AGENT_HOME, { recursive: true })
      rmSync(LEGACY_META_AGENT_HOME, { recursive: true, force: true })
    }
  } catch {
    // Best-effort: leave legacy data in place; stores recreate the new root.
  }
}

// Run the migration eagerly on import. Because every store module imports this
// one to resolve its path constants, the migration completes before any store
// computes its directory — so reads/writes land in the new root from the start.
ensureMetaAgentHomeMigrated()

/** Join path segments under the meta-agent home root. */
export function metaAgentPath(...segments: string[]): string {
  return join(META_AGENT_HOME, ...segments)
}
