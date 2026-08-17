/**
 * Sandbox types for meta-agent-runtime
 *
 * Design goals:
 *   - Zero external dependencies (macOS uses system sandbox-exec, Linux uses bwrap)
 *   - SandboxHandle uses wrapExec() instead of string wrapping to avoid shell
 *     quoting issues — the caller replaces execFileAsync('bash', ...) with
 *     execFileAsync(file, args) directly.
 *   - Fail closed by default when sandboxing is requested but unavailable.
 *     Callers may explicitly opt into unguarded fallback for low-risk tasks.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SandboxConfig — declarative policy, set by the spawn_sub_agent caller
// ─────────────────────────────────────────────────────────────────────────────

export interface SandboxConfig {
  /**
   * When true, the workspaceRoot is mounted/readable but not implicitly writable.
   * Callers may still grant explicit writable paths via writeAllowPaths.
   *
   * Default: false (workspaceRoot is writable)
   */
  readonlyWorkspace?: boolean

  /**
   * Additional absolute paths the sub-agent may write to.
   * The workspaceRoot is implicitly writable unless readonlyWorkspace is true.
   * Default: [] (only workspaceRoot is writable)
   */
  writeAllowPaths?: string[]

  /**
   * Absolute paths the sub-agent may NOT write, even inside an otherwise
   * writable workspace. Used e.g. to block isolated-worktree writers from
   * `.meta-agent/` (merge-excluded → writes there are silently discarded).
   *
   * Note: on macOS (Seatbelt) this is exact ((deny file-write* (subpath …))
   * appended after the workspace allow). On Linux (bwrap) it is approximated
   * by ro-binding the path — the path must EXIST on the host for the bind to
   * apply; callers should pre-create it.
   * Default: [] (no extra write restrictions)
   */
  writeDenyPaths?: string[]

  /**
   * Absolute paths outside the workspace the sub-agent may READ but not write.
   * Datasets, model weights, reference checkouts.
   *
   * Both current backends expose the whole host filesystem read-only by default
   * (`--ro-bind / /` on Linux, `(allow default)` on macOS), so on those this
   * list is informational — it exists so that a read-deny rule can be reconciled
   * against an explicit grant (an operator who grants `~/.aws` here overrides
   * the credential defaults), and so a future deny-by-default read backend has
   * the grants it needs.
   * Default: [] (no extra read grants)
   */
  readAllowPaths?: string[]

  /**
   * Absolute paths the sub-agent may NOT read.
   * Useful for hiding secrets, credentials, or sibling project dirs.
   *
   * Populated by default from `DEFAULT_CREDENTIAL_DENY_PATHS` (~/.ssh, ~/.aws,
   * …) unless the operator sets `sandbox.protectCredentials: false`. See
   * `sandbox/sandboxPolicyConfig.ts`.
   * Default: [] (no extra read restrictions)
   *
   * Note: on Linux (bwrap) read-deny is implemented by mounting a fresh tmpfs
   * over the path, making it appear empty.  On macOS (Seatbelt) it uses
   * (deny file-read*).
   */
  readDenyPaths?: string[]

  /**
   * Network access policy.
   * 'none'          — unshare the network namespace / deny all outbound connections
   * 'unrestricted'  — inherit the parent's network (default)
   *
   * Default: 'unrestricted'
   */
  network?: 'none' | 'unrestricted'

  /**
   * Per-command timeout override (ms).
   * When set, overrides the bash tool's default 30 000 ms cap.
   * Hard limit remains 120 000 ms.
   */
  commandTimeoutMs?: number

  /**
   * Allow fallback to unsandboxed execution when the platform sandbox tool is
   * unavailable or nested sandboxing cannot be created.
   *
   * Default: false (fail closed).
   */
  allowUnsandboxedFallback?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// SandboxExecSpec — the result of wrapping a command
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drop-in replacement for execFileAsync('bash', ['-c', cmd]).
 *
 * The bash tool destructures this and calls:
 *   execFileAsync(file, args, execOptions)
 *
 * - Noop:   { file: 'bash',        args: ['-c', cmd] }
 * - macOS:  { file: 'sandbox-exec', args: ['-p', profile, 'bash', '-c', cmd] }
 * - Linux:  { file: 'bwrap',        args: [...bwrapFlags, 'bash', '-c', cmd] }
 */
export interface SandboxExecSpec {
  file: string
  args: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// SandboxHandle — live session handle, one per SubAgentRunner lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export interface SandboxHandle {
  /**
   * Wrap a raw bash command string into a sandboxed exec spec.
   * Must be called for every bash invocation in the sub-agent's session.
   *
   * @param command     The raw bash command (e.g. "ls -la /tmp")
   * @param cwd         The working directory for the command
   * @returns           An exec spec that enforces the configured sandbox policy
   */
  wrapExec(command: string, cwd: string): SandboxExecSpec

  /**
   * Release any resources held by this handle (temp files, etc.).
   * Called by SubAgentRunner after the sub-agent reaches a terminal state.
   * Safe to call multiple times.
   */
  destroy(): Promise<void>

  /** Human-readable description for logging / diagnostics. */
  readonly description: string
}

// ─────────────────────────────────────────────────────────────────────────────
// SandboxExecutor — factory that creates SandboxHandles
// ─────────────────────────────────────────────────────────────────────────────

export interface SandboxExecutor {
  /**
   * Which platform backend this executor uses.
   * 'noop' means sandboxing is disabled (tool unavailable or not configured).
   */
  readonly platform: 'macos' | 'linux' | 'noop'

  /**
   * Returns true if the underlying sandbox tool (sandbox-exec / bwrap) was
   * found on PATH during startup detection.
   */
  isAvailable(): boolean

  /**
   * Create a SandboxHandle for one sub-agent session.
   *
   * @param config         Declarative sandbox policy from SubAgentConfig.sandbox
   * @param workspaceRoot  Absolute path to the sub-agent's workspace
   */
  create(config: SandboxConfig, workspaceRoot: string): Promise<SandboxHandle>
}
