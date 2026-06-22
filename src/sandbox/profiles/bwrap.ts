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

  // Extra write-allow paths from config
  for (const p of config.writeAllowPaths ?? []) {
    args.push('--bind', p, p)
  }

  // ── Read-deny approximation ───────────────────────────────────────────────
  // Mount a fresh tmpfs over each denied path, making it appear empty.
  for (const p of config.readDenyPaths ?? []) {
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
