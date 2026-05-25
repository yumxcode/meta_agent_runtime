/**
 * NoopSandboxExecutor — passthrough executor used when:
 *   - sandboxing is explicitly disabled
 *   - the required system tool (sandbox-exec / bwrap) is not available
 *   - the current platform is unsupported (Windows, etc.)
 *
 * wrapExec() returns an exec spec identical to calling bash directly,
 * so the bash tool's call path is uniform regardless of sandbox state.
 */

import type {
  SandboxConfig,
  SandboxExecutor,
  SandboxExecSpec,
  SandboxHandle,
} from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Handle
// ─────────────────────────────────────────────────────────────────────────────

class NoopHandle implements SandboxHandle {
  readonly description = 'noop (no sandboxing)'

  wrapExec(command: string, _cwd: string): SandboxExecSpec {
    return { file: 'bash', args: ['-c', command] }
  }

  async destroy(): Promise<void> {
    // nothing to clean up
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Executor
// ─────────────────────────────────────────────────────────────────────────────

export class NoopSandboxExecutor implements SandboxExecutor {
  readonly platform = 'noop' as const

  isAvailable(): boolean {
    return true  // always available — it's a no-op
  }

  async create(_config: SandboxConfig, _workspaceRoot: string): Promise<SandboxHandle> {
    return new NoopHandle()
  }
}
