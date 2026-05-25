import type { MetaAgentTool } from '../../../core/types.js';
import type { SandboxHandle } from '../../../sandbox/types.js';
export interface BashToolOptions {
    /**
     * When provided, every bash command is wrapped via sandboxHandle.wrapExec()
     * before execution, applying the OS-level sandbox policy configured for
     * the sub-agent session.
     */
    sandboxHandle?: SandboxHandle;
}
export declare function createBashTool(opts?: BashToolOptions): Promise<MetaAgentTool>;
//# sourceMappingURL=index.d.ts.map