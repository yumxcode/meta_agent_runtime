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
import { execFileSync } from 'child_process';
// ─────────────────────────────────────────────────────────────────────────────
// Internal probe cache
// ─────────────────────────────────────────────────────────────────────────────
let _platform;
let _sandboxExecAvailable;
let _bwrapAvailable;
let _bwrapVersion;
// ─────────────────────────────────────────────────────────────────────────────
// Platform
// ─────────────────────────────────────────────────────────────────────────────
export function getPlatform() {
    if (_platform === undefined)
        _platform = process.platform;
    return _platform;
}
export function isMacOS() {
    return getPlatform() === 'darwin';
}
export function isLinux() {
    return getPlatform() === 'linux';
}
// ─────────────────────────────────────────────────────────────────────────────
// macOS: sandbox-exec probe
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns true if `sandbox-exec` is available on the current macOS system.
 * On non-macOS platforms always returns false.
 *
 * sandbox-exec ships with every macOS installation as part of Xcode Command
 * Line Tools, so this should always return true on macOS.
 */
export function isSandboxExecAvailable() {
    if (_sandboxExecAvailable !== undefined)
        return _sandboxExecAvailable;
    if (!isMacOS()) {
        _sandboxExecAvailable = false;
        return false;
    }
    try {
        // sandbox-exec with an empty profile and a no-op command — exits 0 when available
        execFileSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
            timeout: 3_000,
            stdio: 'ignore',
        });
        _sandboxExecAvailable = true;
    }
    catch {
        _sandboxExecAvailable = false;
    }
    return _sandboxExecAvailable;
}
// ─────────────────────────────────────────────────────────────────────────────
// Linux: bwrap probe
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns true if `bwrap` (bubblewrap) is available on the current Linux system.
 * On non-Linux platforms always returns false.
 *
 * Install: `apt install bubblewrap` / `dnf install bubblewrap` / `pacman -S bubblewrap`
 */
export function isBwrapAvailable() {
    if (_bwrapAvailable !== undefined)
        return _bwrapAvailable;
    if (!isLinux()) {
        _bwrapAvailable = false;
        return false;
    }
    try {
        const out = execFileSync('bwrap', ['--version'], {
            timeout: 3_000,
            encoding: 'utf8',
        });
        _bwrapVersion = out.trim();
        _bwrapAvailable = true;
    }
    catch {
        _bwrapAvailable = false;
    }
    return _bwrapAvailable;
}
/**
 * Returns the detected bwrap version string (e.g. "bubblewrap 0.8.0"),
 * or undefined if bwrap is not available.
 */
export function getBwrapVersion() {
    if (_bwrapAvailable === undefined)
        isBwrapAvailable();
    return _bwrapVersion;
}
// ─────────────────────────────────────────────────────────────────────────────
// Nested sandbox detection
// ─────────────────────────────────────────────────────────────────────────────
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
export function isInsideBwrap() {
    // Environment variable set by some bwrap wrappers
    if (process.env['BWRAP_SANDBOX_PID'])
        return true;
    // Check /proc/1/cmdline for bwrap signature (Linux-only, best-effort)
    try {
        const { readFileSync } = require('fs');
        const cmdline = readFileSync('/proc/1/cmdline', 'utf8');
        if (cmdline.includes('bwrap'))
            return true;
    }
    catch {
        // /proc not available or permission denied — assume not nested
    }
    return false;
}
export function getSandboxAvailability() {
    return {
        platform: getPlatform(),
        sandboxExec: isSandboxExecAvailable(),
        bwrap: isBwrapAvailable(),
        bwrapVersion: getBwrapVersion(),
        nestedBwrap: isLinux() ? isInsideBwrap() : false,
    };
}
//# sourceMappingURL=detect.js.map