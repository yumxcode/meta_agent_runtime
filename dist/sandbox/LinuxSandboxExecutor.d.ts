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
import type { SandboxConfig, SandboxExecutor, SandboxHandle } from './types.js';
export declare class LinuxSandboxExecutor implements SandboxExecutor {
    readonly platform: "linux";
    isAvailable(): boolean;
    create(config: SandboxConfig, workspaceRoot: string): Promise<SandboxHandle>;
}
//# sourceMappingURL=LinuxSandboxExecutor.d.ts.map