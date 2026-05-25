/**
 * NoopSandboxExecutor — passthrough executor used when:
 *   - sandboxing is explicitly disabled
 *   - the required system tool (sandbox-exec / bwrap) is not available
 *   - the current platform is unsupported (Windows, etc.)
 *
 * wrapExec() returns an exec spec identical to calling bash directly,
 * so the bash tool's call path is uniform regardless of sandbox state.
 */
import type { SandboxConfig, SandboxExecutor, SandboxHandle } from './types.js';
export declare class NoopSandboxExecutor implements SandboxExecutor {
    readonly platform: "noop";
    isAvailable(): boolean;
    create(_config: SandboxConfig, _workspaceRoot: string): Promise<SandboxHandle>;
}
//# sourceMappingURL=NoopSandboxExecutor.d.ts.map