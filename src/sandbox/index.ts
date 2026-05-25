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
import { isBwrapAvailable } from './detect.js'
import { MacOSSandboxExecutor } from './MacOSSandboxExecutor.js'
import { LinuxSandboxExecutor } from './LinuxSandboxExecutor.js'
import { NoopSandboxExecutor } from './NoopSandboxExecutor.js'
import type { SandboxExecutor } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

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
 */
export function createSandboxExecutor(): SandboxExecutor {
  if (isMacOS() && isSandboxExecAvailable()) {
    return new MacOSSandboxExecutor()
  }

  if (isLinux() && isBwrapAvailable()) {
    return new LinuxSandboxExecutor()
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
