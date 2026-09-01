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

  // Caller-specified write-deny paths — MUST come after the workspace/extra
  // write allows: Seatbelt takes the LAST matching rule, so a later deny on a
  // subpath carves a hole out of an earlier broader allow.
  const denyWrite = config.writeDenyPaths ?? []
  if (denyWrite.length > 0) {
    lines.push(';; Caller-specified write-deny paths (override allows above).')
    lines.push('(deny file-write*')
    for (const p of denyWrite) {
      lines.push(`  ${subpath(p)}`)
    }
    lines.push(')')
    lines.push('')
  }

  // ── File-read restrictions ────────────────────────────────────────────────
  //
  // The base is `(allow default)`, so every path on the host is readable unless
  // it appears here. That is why `sandbox.protectCredentials` populates this
  // list by default: without it a sandboxed shell can read ~/.ssh and ~/.aws
  // and — since `network` is unrestricted unless the operator says otherwise —
  // send them anywhere.
  // An explicit deny WINS over an explicit allow, including when the deny names
  // a path underneath the grant. This is the precedence sandboxPolicyConfig's
  // header documents ("an operator's explicit deny always wins over an
  // operator's allow"), and until now this builder implemented the opposite.
  //
  // The bug that motivated the fix: granting `~/.ssh` (needed for known_hosts)
  // and denying `~/.ssh/id_ed25519` silently dropped the key's deny, because
  // the key is under the grant. The operator saw a config that reads like a
  // precise carve-out and got a fully readable `~/.ssh`.
  //
  // Only an EXACT overlap is skipped: the same path in both lists is a caller
  // contradiction rather than a carve-out, and resolveSandboxPolicy has already
  // resolved the one case where an allow legitimately cancels a deny (a
  // credential DEFAULT yielding to an operator grant — those paths never reach
  // this builder in readDenyPaths at all). Anything still denied here was
  // denied on purpose.
  const readAllow = config.readAllowPaths ?? []
  const denyRead = (config.readDenyPaths ?? []).filter(
    p => !readAllow.includes(p),
  )
  if (denyRead.length > 0) {
    lines.push(';; Caller-specified read-deny paths (credentials, secrets).')
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
