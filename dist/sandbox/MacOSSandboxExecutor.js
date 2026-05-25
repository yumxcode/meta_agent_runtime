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
import { isSandboxExecAvailable } from './detect.js';
import { buildMacOSProfile } from './profiles/macos.js';
// ─────────────────────────────────────────────────────────────────────────────
// Handle
// ─────────────────────────────────────────────────────────────────────────────
class MacOSHandle {
    description;
    _profile;
    constructor(profile, workspaceRoot) {
        this._profile = profile;
        this.description = `macos/sandbox-exec workspace=${workspaceRoot}`;
    }
    wrapExec(command, _cwd) {
        // sandbox-exec executes the rest of its argv directly (no shell interpolation).
        // 'bash' is passed as the executable so the sub-agent's PATH-based commands work.
        return {
            file: 'sandbox-exec',
            args: ['-p', this._profile, 'bash', '-c', command],
        };
    }
    async destroy() {
        // Profile was inlined via -p; no temp files to clean up.
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Executor
// ─────────────────────────────────────────────────────────────────────────────
export class MacOSSandboxExecutor {
    platform = 'macos';
    isAvailable() {
        return isSandboxExecAvailable();
    }
    async create(config, workspaceRoot) {
        if (!this.isAvailable()) {
            throw new Error('MacOSSandboxExecutor: sandbox-exec not available on this system. ' +
                'This should not happen — check isSandboxExecAvailable() before calling create().');
        }
        const profile = buildMacOSProfile(config, workspaceRoot);
        return new MacOSHandle(profile, workspaceRoot);
    }
}
//# sourceMappingURL=MacOSSandboxExecutor.js.map