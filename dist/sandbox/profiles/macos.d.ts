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
import type { SandboxConfig } from '../types.js';
/**
 * Build a Seatbelt profile string from a SandboxConfig.
 *
 * @param config         Declarative sandbox policy
 * @param workspaceRoot  Absolute path always granted write access
 */
export declare function buildMacOSProfile(config: SandboxConfig, workspaceRoot: string): string;
//# sourceMappingURL=macos.d.ts.map