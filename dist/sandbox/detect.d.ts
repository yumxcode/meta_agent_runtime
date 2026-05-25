/**
 * Platform detection for sandbox tooling.
 *
 * Checks whether the required system tools are available on PATH at process
 * startup.  Results are cached (memoised) so subsequent calls are O(1).
 *
 * Tools probed:
 *   macOS  → sandbox-exec   (ships with every macOS installation)
 *   Linux  → bwrap           (bubblewrap; install via apt/dnf/pacman)
 */
export declare function getPlatform(): NodeJS.Platform;
export declare function isMacOS(): boolean;
export declare function isLinux(): boolean;
/**
 * Returns true if `sandbox-exec` is available on the current macOS system.
 * On non-macOS platforms always returns false.
 *
 * sandbox-exec ships with every macOS installation as part of Xcode Command
 * Line Tools, so this should always return true on macOS.
 */
export declare function isSandboxExecAvailable(): boolean;
/**
 * Returns true if `bwrap` (bubblewrap) is available on the current Linux system.
 * On non-Linux platforms always returns false.
 *
 * Install: `apt install bubblewrap` / `dnf install bubblewrap` / `pacman -S bubblewrap`
 */
export declare function isBwrapAvailable(): boolean;
/**
 * Returns the detected bwrap version string (e.g. "bubblewrap 0.8.0"),
 * or undefined if bwrap is not available.
 */
export declare function getBwrapVersion(): string | undefined;
/**
 * Heuristic check: are we already running inside a bwrap sandbox?
 *
 * bwrap sets up a new PID namespace. When nested, /proc/1/exe typically
 * points to bwrap's init stub rather than systemd/launchd. We also check
 * the BWRAP_SANDBOX_PID env variable that some launchers set.
 *
 * Returns true when a nested sandbox is detected. In that case
 * LinuxSandboxExecutor should degrade to NoopSandboxExecutor to avoid
 * "operation not permitted" failures from unprivileged nested namespaces.
 */
export declare function isInsideBwrap(): boolean;
export interface SandboxAvailability {
    platform: NodeJS.Platform;
    sandboxExec: boolean;
    bwrap: boolean;
    bwrapVersion?: string;
    nestedBwrap: boolean;
}
export declare function getSandboxAvailability(): SandboxAvailability;
//# sourceMappingURL=detect.d.ts.map