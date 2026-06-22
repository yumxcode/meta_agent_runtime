/**
 * macOS Seatbelt profile builder
 *
 * Generates an Apple Sandbox Profile Language (SBPL) string from a
 * SandboxConfig.  The profile is passed to `sandbox-exec -p <profile>`.
 *
 * Design:
 *   - Start from "allow default" (permissive base) then layer denials.
 *   - Deny all file-write* by default, then carve out allow exceptions.
 *   - Deny network* when config.network === 'none'.
 *
 * Seatbelt quick reference:
 *   (allow default)            — allow everything not explicitly denied
 *   (deny  file-write*)        — deny all writes
 *   (allow file-write* ...)    — re-allow specific write targets
 *   (deny  file-read*  ...)    — deny specific read targets
 *   (deny  network*)           — deny all network I/O
 *   (subpath "/abs/path")      — recursive match under /abs/path
 *   (literal "/abs/path")      — exact file match
 *   (regex  #"pattern")        — POSIX regex match
 *
 * Node.js runtime requirements that must always be writable:
 *   /dev/null, /dev/zero, /dev/random, /dev/urandom — standard device files
 *   /dev/fd/*                                        — pipe/socket FDs
 *   /private/var/folders/…                           — macOS temp dir (TMPDIR)
 *   /var/folders/…                                   — symlink alias to above
 *   /private/tmp, /tmp                               — general temp files
 *
 * Node.js runtime requirements that must always be readable:
 *   Everything under /usr, /lib, /System, etc. — covered by (allow default).
 */

import type { SandboxConfig } from '../types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Quote a path for SBPL: escape backslashes and double-quotes. */
function sbplPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Emit a (subpath "…") clause. */
function subpath(p: string): string {
  return `(subpath "${sbplPath(p)}")`
}

/** Emit a (literal "…") clause. */
function literal(p: string): string {
  return `(literal "${sbplPath(p)}")`
}

/** Emit a (regex #"…") clause.  The caller is responsible for valid POSIX regex. */
function regex(pattern: string): string {
  return `(regex #"${pattern}")`
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a Seatbelt profile string from a SandboxConfig.
 *
 * @param config         Declarative sandbox policy
 * @param workspaceRoot  Absolute path to the sub-agent workspace
 */
export function buildMacOSProfile(
  config: SandboxConfig,
  workspaceRoot: string,
): string {
  const lines: string[] = []

  // ── Preamble ──────────────────────────────────────────────────────────────
  lines.push('(version 1)')
  lines.push('')
  lines.push(';; Permissive base — deny specific operations below.')
  lines.push('(allow default)')
  lines.push('')

  // ── File-write restrictions ───────────────────────────────────────────────
  lines.push(';; Deny all writes by default.')
  lines.push('(deny file-write*)')
  lines.push('')

  // Node.js / shell runtime: always writable
  lines.push(';; Node.js runtime always-writable paths.')
  lines.push('(allow file-write*')
  lines.push(`  ${literal('/dev/null')}`)
  lines.push(`  ${literal('/dev/zero')}`)
  lines.push(`  ${literal('/dev/random')}`)
  lines.push(`  ${literal('/dev/urandom')}`)
  lines.push(`  ${regex('^/dev/fd/[0-9]+$')}`)       // pipe/socket FDs
  lines.push(`  ${subpath('/private/var/folders')}`)  // macOS TMPDIR
  lines.push(`  ${subpath('/var/folders')}`)           // symlink alias
  lines.push(`  ${subpath('/private/tmp')}`)
  lines.push(`  ${subpath('/tmp')}`)
  lines.push(')')
  lines.push('')

  // Workspace root — writable unless the caller requested a true readonly workspace.
  lines.push(';; Sub-agent workspace.')
  if (config.readonlyWorkspace) {
    lines.push(`(deny file-write* ${subpath(workspaceRoot)})`)
  } else {
    lines.push(`(allow file-write* ${subpath(workspaceRoot)})`)
  }
  lines.push('')

  // Extra write-allow paths from config
  const extraWrite = config.writeAllowPaths ?? []
  if (extraWrite.length > 0) {
    lines.push(';; Caller-specified extra write paths.')
    lines.push('(allow file-write*')
    for (const p of extraWrite) {
      lines.push(`  ${subpath(p)}`)
    }
    lines.push(')')
    lines.push('')
  }

  // ── File-read restrictions ────────────────────────────────────────────────
  const denyRead = config.readDenyPaths ?? []
  if (denyRead.length > 0) {
    lines.push(';; Caller-specified read-deny paths.')
    lines.push('(deny file-read*')
    for (const p of denyRead) {
      lines.push(`  ${subpath(p)}`)
    }
    lines.push(')')
    lines.push('')
  }

  // ── Network restrictions ──────────────────────────────────────────────────
  if (config.network === 'none') {
    lines.push(';; Network disabled by caller.')
    lines.push('(deny network*)')
    lines.push('')
  }

  return lines.join('\n')
}
