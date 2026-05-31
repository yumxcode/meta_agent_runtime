import type { MetaAgentTool } from '../../../core/types.js';
import type { SandboxHandle } from '../../../sandbox/types.js';
export type ShellEnvPolicy = 'inherit' | 'filtered' | 'empty';
export interface BashToolOptions {
    /**
     * When provided, every bash command is wrapped via sandboxHandle.wrapExec()
     * before execution, applying the OS-level sandbox policy configured for
     * the sub-agent session.
     */
    sandboxHandle?: SandboxHandle;
    /**
     * H5: Controls what env vars are forwarded to the spawned shell.
     *
     *   'inherit'  — forward process.env verbatim (legacy behaviour)
     *   'filtered' — strip API keys / tokens / credentials (default)
     *   'empty'    — only PATH / HOME / LANG and a handful of basics
     *
     * Defaults to 'filtered' so models cannot exfiltrate API keys via shell.
     * Override to 'inherit' for trusted workflows that need full env access.
     */
    envPolicy?: ShellEnvPolicy;
}
export declare function createBashTool(opts?: BashToolOptions): Promise<MetaAgentTool>;
//# sourceMappingURL=index.d.ts.map