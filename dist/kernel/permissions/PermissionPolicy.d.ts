import type { CanUseToolFn } from '../types/KernelConfig.js';
import type { ToolPermissionDeclaration } from '../../core/types.js';
type BeforeToolCallResult = {
    action: 'allow';
} | {
    action: 'deny';
    reason?: string;
} | {
    action: 'redirect';
    instructions: string;
};
export interface PermissionPolicyOptions {
    workspaceRoot?: string;
    beforeToolCall?: (toolName: string, input: Record<string, unknown>) => Promise<BeforeToolCallResult>;
    planModeRef?: {
        active: boolean;
    };
    askUser?: (question: string, choices?: string[]) => Promise<string>;
    permissionConfig?: PermissionConfig;
}
export interface PermissionConfig {
    workspace?: {
        root?: string;
        allowOutsideWorkspace?: boolean;
        allowTmp?: boolean;
    };
    tools?: Record<string, ToolPermissionOverride>;
}
export interface ToolPermissionOverride extends ToolPermissionDeclaration {
    enabled?: boolean;
}
export declare function createPermissionPolicy(options?: PermissionPolicyOptions): CanUseToolFn;
export {};
//# sourceMappingURL=PermissionPolicy.d.ts.map