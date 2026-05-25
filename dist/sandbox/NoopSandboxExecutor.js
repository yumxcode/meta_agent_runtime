/**
 * NoopSandboxExecutor — passthrough executor used when:
 *   - sandboxing is explicitly disabled
 *   - the required system tool (sandbox-exec / bwrap) is not available
 *   - the current platform is unsupported (Windows, etc.)
 *
 * wrapExec() returns an exec spec identical to calling bash directly,
 * so the bash tool's call path is uniform regardless of sandbox state.
 */
// ─────────────────────────────────────────────────────────────────────────────
// Handle
// ─────────────────────────────────────────────────────────────────────────────
class NoopHandle {
    description = 'noop (no sandboxing)';
    wrapExec(command, _cwd) {
        return { file: 'bash', args: ['-c', command] };
    }
    async destroy() {
        // nothing to clean up
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Executor
// ─────────────────────────────────────────────────────────────────────────────
export class NoopSandboxExecutor {
    platform = 'noop';
    isAvailable() {
        return true; // always available — it's a no-op
    }
    async create(_config, _workspaceRoot) {
        return new NoopHandle();
    }
}
//# sourceMappingURL=NoopSandboxExecutor.js.map