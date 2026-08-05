/**
 * Sandbox module entry point
 *
 * Public API:
 *   createSandboxExecutor()   — returns the best available executor for the
 *                               current platform, or NoopSandboxExecutor if
 *                               nothing suitable is available.
 *
 *   getSandboxAvailability()  — diagnostic snapshot (platform, tools found, …)
 *
 * Re-exports all types so callers can import everything from one path:
 *   import { createSandboxExecutor, SandboxConfig, SandboxHandle } from '../sandbox/index.js'
 */

import { isMacOS, isLinux, getSandboxAvailability } from './detect.js'
import { isSandboxExecAvailable } from './detect.js'
import { isBwrapAvailable, isInsideBwrap } from './detect.js'
import { MacOSSandboxExecutor } from './MacOSSandboxExecutor.js'
import { LinuxSandboxExecutor } from './LinuxSandboxExecutor.js'
import { NoopSandboxExecutor } from './NoopSandboxExecutor.js'
import type { SandboxExecutor } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/** One-shot latch so the degradation warning is printed at most once per process. */
let _warnedNoSandbox = false

/** Reset the one-shot warning latch (tests only). */
export function resetSandboxDegradationWarning(): void {
  _warnedNoSandbox = false
}

/**
 * Human-readable name of the backend that WOULD be selected right now.
 * Exposed so the CLI can surface it (`meta-agent env`) instead of leaving the
 * operator to guess whether a sandbox is actually in force.
 */
export function describeSandboxBackend(): {
  backend: 'macos/sandbox-exec' | 'linux/bwrap' | 'none'
  enforced: boolean
  reason?: string
} {
  if (isMacOS()) {
    return isSandboxExecAvailable()
      ? { backend: 'macos/sandbox-exec', enforced: true }
      : { backend: 'none', enforced: false, reason: 'sandbox-exec not found on this macOS host' }
  }
  if (isLinux()) {
    if (!isBwrapAvailable()) {
      return { backend: 'none', enforced: false, reason: 'bwrap not installed (apt/dnf/pacman install bubblewrap)' }
    }
    return isInsideBwrap()
      ? { backend: 'none', enforced: false, reason: 'already running inside a bwrap sandbox (nested namespaces unavailable)' }
      : { backend: 'linux/bwrap', enforced: true }
  }
  return { backend: 'none', enforced: false, reason: `no sandbox backend exists for platform '${process.platform}'` }
}

/**
 * Return the most capable sandbox executor available on the current platform.
 *
 * Selection order:
 *   1. macOS  + sandbox-exec found  → MacOSSandboxExecutor
 *   2. Linux  + bwrap found         → LinuxSandboxExecutor
 *   3. Anything else                → NoopSandboxExecutor (no sandboxing)
 *
 * The Noop executor means no platform sandbox is available. Callers that are
 * handling an explicit sandbox policy should fail closed unless the policy
 * opts into allowUnsandboxedFallback.
 *
 * DEGRADATION IS NOW LOUD. auto/simple_auto force allowUnsandboxedFallback:false
 * (see modes/toolRuntimeGuards.ts) and hard-fail here, but agentic and robotics
 * keep the permissive DEFAULT_MAIN_SANDBOX, so on a host without a backend they
 * silently fell through to plain `bash -c`. The only thing left standing was the
 * PermissionPolicy command scan, which is an explicitly best-effort typo guard —
 * trivially bypassed by `X=etc; cat /$X/passwd` or a base64 round-trip. Users
 * had no way to tell the difference between "jailed" and "not jailed", so we
 * print a one-time warning naming the reason and the fix.
 */
export function createSandboxExecutor(): SandboxExecutor {
  if (isMacOS() && isSandboxExecAvailable()) {
    return new MacOSSandboxExecutor()
  }

  if (isLinux() && isBwrapAvailable()) {
    return new LinuxSandboxExecutor()
  }

  if (!_warnedNoSandbox) {
    _warnedNoSandbox = true
    const { reason } = describeSandboxBackend()
    process.stderr.write(
      '[meta-agent/sandbox] WARNING: no OS sandbox backend available — ' +
      `${reason ?? 'unknown reason'}.\n` +
      '  Shell commands run WITHOUT an OS-enforced workspace jail. The remaining\n' +
      '  path checks are a best-effort typo guard, not a containment boundary.\n' +
      '  Fix: install bubblewrap (Linux) / run on macOS, or use --mode auto,\n' +
      '  which fails closed instead of degrading. See `meta-agent env`.\n',
    )
  }

  return new NoopSandboxExecutor()
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports
// ─────────────────────────────────────────────────────────────────────────────

export { getSandboxAvailability } from './detect.js'
export type {
  SandboxConfig,
  SandboxHandle,
  SandboxExecSpec,
  SandboxExecutor,
} from './types.js'
