/**
 * LinuxSandboxExecutor — bwrap (bubblewrap) backed executor for Linux
 *
 * Each call to create() builds a bwrap argument array from the provided
 * SandboxConfig and captures it in the returned SandboxHandle.
 *
 * Execution model:
 *   Instead of: execFileAsync('bash', ['-c', cmd])
 *   We use:     execFileAsync('bwrap', [...bwrapArgs, 'bash', '-c', cmd])
 *
 * Nested sandbox handling:
 *   If we detect that the process is already running inside a bwrap sandbox
 *   (isInsideBwrap() === true), creating another bwrap namespace will fail
 *   with EPERM on systems without nested user-namespace support.  In this
 *   case create() emits a warning and falls back to a NoopHandle.
 *
 * Requirements:
 *   - bwrap ≥ 0.4 (for --unshare-pid without root)
 *   - Linux kernel ≥ 3.8 (user namespaces)
 *   - sysctl kernel.unprivileged_userns_clone = 1 (Debian/Ubuntu default)
 *
 * Install:
 *   apt install bubblewrap   (Debian/Ubuntu)
 *   dnf install bubblewrap   (Fedora/RHEL)
 *   pacman -S bubblewrap     (Arch)
 */
import { isBwrapAvailable, isInsideBwrap } from './detect.js';
import { buildBwrapArgs } from './profiles/bwrap.js';
// ─────────────────────────────────────────────────────────────────────────────
// Handle
// ─────────────────────────────────────────────────────────────────────────────
class LinuxHandle {
    description;
    _bwrapArgs;
    constructor(bwrapArgs, workspaceRoot) {
        this._bwrapArgs = bwrapArgs;
        this.description = `linux/bwrap workspace=${workspaceRoot}`;
    }
    wrapExec(command, _cwd) {
        // _bwrapArgs already ends with '--' (separator from buildBwrapArgs).
        // We append 'bash -c <command>' as the sandboxed executable.
        return {
            file: 'bwrap',
            args: [...this._bwrapArgs, 'bash', '-c', command],
        };
    }
    async destroy() {
        // bwrap runs as a one-shot process per command; no persistent state.
    }
}
/** Passthrough handle used when nested sandbox is detected. */
class NoopFallbackHandle {
    description = 'linux/noop-fallback (nested bwrap detected)';
    wrapExec(command, _cwd) {
        return { file: 'bash', args: ['-c', command] };
    }
    async destroy() { }
}
// ─────────────────────────────────────────────────────────────────────────────
// Executor
// ─────────────────────────────────────────────────────────────────────────────
export class LinuxSandboxExecutor {
    platform = 'linux';
    isAvailable() {
        return isBwrapAvailable();
    }
    async create(config, workspaceRoot) {
        if (!this.isAvailable()) {
            throw new Error('LinuxSandboxExecutor: bwrap not found on PATH. ' +
                'Install it with: apt install bubblewrap (or dnf/pacman equivalent). ' +
                'Check isBwrapAvailable() before calling create().');
        }
        // Nested sandbox detection — fail closed unless caller explicitly opts into
        // unsandboxed fallback.
        if (isInsideBwrap()) {
            if (!config.allowUnsandboxedFallback) {
                throw new Error('LinuxSandboxExecutor: nested bwrap detected and allowUnsandboxedFallback is false. ' +
                    'Cannot safely create a nested sandbox.');
            }
            process.stderr.write('[meta-agent/sandbox] WARNING: nested bwrap detected. ' +
                'Falling back to unsandboxed execution for this sub-agent.\n');
            return new NoopFallbackHandle();
        }
        const bwrapArgs = buildBwrapArgs(config, workspaceRoot);
        return new LinuxHandle(bwrapArgs, workspaceRoot);
    }
}
//# sourceMappingURL=LinuxSandboxExecutor.js.map