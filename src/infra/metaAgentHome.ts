/**
 * metaAgentHome — single source of truth for the meta-agent data directory.
 *
 * All persisted state (memory, experiences, principles, projects, campaigns,
 * subtasks, contracts, config, …) lives under one root:
 *
 *     ~/.meta-agent/   (override with $META_AGENT_HOME)
 *
 * meta-agent owns this namespace exclusively. It never reads from or writes to
 * `~/.claude/` (that directory belongs to the Claude CLI, a different product).
 */

import { homedir } from 'os'
import { join, resolve } from 'path'

/**
 * Current root: `$META_AGENT_HOME` when set (resolved to an absolute path),
 * otherwise `~/.meta-agent`.
 *
 * The env override exists so tests (and any embedding that wants an isolated
 * data dir) can redirect ALL persisted state to a temp directory instead of the
 * developer's real home — without it, unit tests wrote to ~/.meta-agent/subtasks
 * (EPERM under a sandbox) and read the developer's ~/.meta-agent/config.json,
 * making results depend on local machine state. Every store imports this module
 * to compute its path, so a single env read here redirects all of them. The
 * value is captured at import time, so the env var must be set before the first
 * store import (vitest setupFiles run early enough).
 */
function resolveMetaAgentHome(): string {
  const override = process.env['META_AGENT_HOME']?.trim()
  return override ? resolve(override) : join(homedir(), '.meta-agent')
}

export const META_AGENT_HOME: string = resolveMetaAgentHome()

/** Join path segments under the meta-agent home root. */
export function metaAgentPath(...segments: string[]): string {
  return join(META_AGENT_HOME, ...segments)
}
