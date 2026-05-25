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
import type { SandboxConfig } from '../types.js';
/**
 * Build the bwrap argument array for a given sandbox policy.
 * The resulting array should be prepended to ['bash', '-c', command].
 *
 * @param config         Declarative sandbox policy
 * @param workspaceRoot  Absolute path always granted write access
 */
export declare function buildBwrapArgs(config: SandboxConfig, workspaceRoot: string): string[];
//# sourceMappingURL=bwrap.d.ts.map