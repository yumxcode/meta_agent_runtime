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
export {};
//# sourceMappingURL=types.js.map