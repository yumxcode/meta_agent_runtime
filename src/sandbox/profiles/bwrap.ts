/**
 * Linux bubblewrap (bwrap) argument builder
 *
 * Generates the argument array for `bwrap` from a SandboxConfig.
 *
 * Strategy: "read-only overlay + selective writable binds"
 *   --ro-bind / /          — mount the entire host FS read-only in the sandbox
 *   --bind <p> <p>         — overlay each writable path as read-write
 *   --dev /dev             — fresh /dev with standard devices
 *   --proc /proc           — fresh /proc
 *   --tmpfs /tmp           — isolated /tmp (not shared with host)
 *   --unshare-pid          — new PID namespace (prevents pid-based escapes)
 *   --unshare-net          — (optional) new network namespace = no network
 *   --die-with-parent      — sandbox process is killed if the parent dies
 *
 * Read-deny via exclusion:
 *   bwrap does not support read-deny on already-mounted paths in a simple way.
 *   We approximate it by mounting a fresh tmpfs over the denied paths, making
 *   them appear as empty directories inside the sandbox.
 *
 * Notes:
 *   - bwrap requires that bind-mounted source paths exist on the host.
 *     workspaceRoot is checked by the caller before invoking create().
 *   - bwrap 0.4+ supports --unshare-pid without needing privileges.
 *   - Requires Linux kernel ≥ 3.8 for user namespaces.
 */

import type { SandboxConfig } from '../types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the bwrap argument array for a given sandbox policy.
 * The resulting array should be prepended to ['bash', '-c', command].
 *
 * @param config         Declarative sandbox policy
 * @param workspaceRoot  Absolute path to the sub-agent workspace
 */
export function buildBwrapArgs(
  config: SandboxConfig,
  workspaceRoot: string,
): string[] {
  const args: string[] = []

  // ── Base read-only overlay ─────────────────────────────────────────────────
  // Mount the entire host filesystem as read-only.
  // Subsequent --bind calls overlay specific paths as writable.
  args.push('--ro-bind', '/', '/')

  // ── Fresh pseudo-filesystems ───────────────────────────────────────────────
  args.push('--dev', '/dev')     // standard device nodes (/dev/null, /dev/pts, …)
  args.push('--proc', '/proc')   // fresh /proc (required for many tools)
  args.push('--tmpfs', '/tmp')   // isolated /tmp — not shared with host

  // ── Workspace mount ───────────────────────────────────────────────────────
  // workspaceRoot is writable by default. readonlyWorkspace still gets an
  // explicit ro-bind so workspaces under /tmp remain visible after --tmpfs /tmp.
  if (config.readonlyWorkspace) {
    args.push('--ro-bind', workspaceRoot, workspaceRoot)
  } else {
    args.push('--bind', workspaceRoot, workspaceRoot)
  }

  // Extra write-allow paths from config (operator-granted external roots).
  //
  // `--bind-try`, not `--bind`: bwrap aborts the ENTIRE command when a `--bind`
  // source is missing, so a single stale entry in `sandbox.writeAllowPaths`
  // (a scratch dir that got cleaned up) turned every shell call in the session
  // into an opaque bwrap error. The write-deny loop below already used the
  // -try form; there was no reason for the two to differ.
  for (const p of config.writeAllowPaths ?? []) {
    args.push('--bind-try', p, p)
  }

  // Read-allow paths need no mount of their own — `--ro-bind / /` above already
  // exposes the whole host filesystem read-only. They are re-applied AFTER the
  // read-deny tmpfs loop below only when they would otherwise be shadowed; see
  // the reconciliation there.

  // Write-deny: ro-bind the denied path over the writable workspace bind
  // (later mounts shadow earlier ones). The source path must exist on the
  // host — callers pre-create it (see SandboxConfig docs).
  for (const p of config.writeDenyPaths ?? []) {
    args.push('--ro-bind-try', p, p)
  }

  // ── Read-deny ─────────────────────────────────────────────────────────────
  // Mount a fresh tmpfs over each denied path, making it appear empty.
  //
  // A path that is BOTH read-denied and explicitly read-granted is skipped: the
  // operator's explicit grant wins. resolveSandboxPolicy() normally removes such
  // overlaps before we get here, but a caller may hand-build a SandboxConfig, and
  // silently shadowing a directory the caller just asked for would be worse than
  // either honouring or rejecting it.
  const readAllow = config.readAllowPaths ?? []
  for (const p of config.readDenyPaths ?? []) {
    if (readAllow.some(granted => granted === p || p.startsWith(`${granted}/`))) continue
    args.push('--tmpfs', p)
  }

  // ── Network ───────────────────────────────────────────────────────────────
  if (config.network === 'none') {
    args.push('--unshare-net')
  }

  // ── Namespace isolation ───────────────────────────────────────────────────
  args.push('--unshare-pid')       // new PID namespace
  args.push('--die-with-parent')   // child killed when parent exits

  // ── Separator ─────────────────────────────────────────────────────────────
  // '--' separates bwrap flags from the executable to run.
  args.push('--')

  return args
}
