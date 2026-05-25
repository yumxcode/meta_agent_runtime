/**
 * MacOSSandboxExecutor — sandbox-exec backed executor for macOS
 *
 * Each call to create() builds an Apple Seatbelt profile string from the
 * provided SandboxConfig and captures it in the returned SandboxHandle.
 *
 * Execution model:
 *   Instead of: execFileAsync('bash', ['-c', cmd])
 *   We use:     execFileAsync('sandbox-exec', ['-p', profile, 'bash', '-c', cmd])
 *
 * The profile is inlined via -p (no temp file needed) which avoids race
 * conditions and keeps cleanup trivial.
 *
 * Limitations:
 *   - sandbox-exec is available on macOS only.
 *   - The Seatbelt policy engine is undocumented by Apple; behaviour may vary
 *     across OS versions.  Tested on macOS 12–15.
 *   - The profile string may grow large with many writeAllowPaths; -p has a
 *     practical limit (ARG_MAX).  For >100 paths consider using -f with a temp
 *     profile file (not implemented here — uncommon in practice).
 */
import type { SandboxConfig, SandboxExecutor, SandboxHandle } from './types.js';
export declare class MacOSSandboxExecutor implements SandboxExecutor {
    readonly platform: "macos";
    isAvailable(): boolean;
    create(config: SandboxConfig, workspaceRoot: string): Promise<SandboxHandle>;
}
//# sourceMappingURL=MacOSSandboxExecutor.d.ts.map