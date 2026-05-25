/**
 * KernelTool — the interface every tool must satisfy.
 *
 * Mirrors CC's Tool interface, but slimmed to what the kernel actually needs.
 * UI-only methods (renderToolResultMessage, etc.) are omitted.
 */
import type { KernelMessage } from './KernelMessage.js';
import type { FileStateCache } from '../session/FileStateCache.js';
import type { ToolPermissionDeclaration } from '../../core/types.js';
export interface ToolDescriptionContext {
    sessionId: string;
    model: string;
}
export interface ToolPermissionContext {
    /** Whether the session is in plan (read-only) mode */
    planMode: boolean;
    /** Whether permissions are fully bypassed (e.g. --dangerously-skip-permissions) */
    bypassPermissions: boolean;
}
export interface KernelToolContext {
    sessionId: string;
    agentId?: string;
    abortSignal: AbortSignal;
    readFileState: FileStateCache;
    messages: readonly KernelMessage[];
    workspaceRoot?: string;
    planMode?: boolean;
    askUser?: (question: string, choices?: string[]) => Promise<string>;
    /** Escape hatch for mode-specific context (Campaign, Robotics, etc.) */
    extensions?: Record<string, unknown>;
}
export interface KernelToolResult {
    /** The result content. String is used as tool_result text content. */
    data: string | ContentBlockLike[];
    isError?: boolean;
    /** Optional additional messages to inject after the tool result */
    newMessages?: KernelMessage[];
    /** Optional context modifier applied after this tool runs */
    contextModifier?: (ctx: KernelToolContext) => KernelToolContext;
}
export type ContentBlockLike = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
};
export interface ZodCompatSchema {
    safeParse(input: unknown): {
        success: true;
        data: unknown;
    } | {
        success: false;
        error: unknown;
    };
}
export interface ToolInputJSONSchema {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    [key: string]: unknown;
}
export interface KernelTool {
    readonly name: string;
    readonly aliases?: string[];
    /**
     * Description sent to the model as part of the tool schema.
     * Can be a static string or a function for dynamic descriptions.
     */
    readonly description: string | ((ctx: ToolDescriptionContext) => Promise<string>);
    /**
     * Zod-compatible schema.  safeParse result is passed to isConcurrencySafe.
     * If safeParse fails, the tool is treated as non-concurrency-safe.
     */
    readonly inputSchema: ZodCompatSchema;
    /** JSON Schema version of the input — sent verbatim to the Anthropic API */
    readonly inputJSONSchema: ToolInputJSONSchema;
    readonly permission?: ToolPermissionDeclaration;
    /**
     * Execute the tool.
     * The kernel guarantees input has already been validated via inputSchema.safeParse.
     */
    call(input: unknown, context: KernelToolContext): Promise<KernelToolResult>;
    /**
     * Whether this tool can safely be run in parallel with other safe tools.
     * Receives the already-parsed input (safeParse.data).
     * Must not throw — if it does, treated as false.
     */
    isConcurrencySafe(parsedInput?: unknown): boolean;
    /** Whether this tool is available given the current permissions */
    isEnabled?(permissions: ToolPermissionContext): boolean;
    /**
     * Maximum number of characters to keep in a tool result content string.
     * Undefined / Infinity → no limit (e.g. sub-agent calls).
     */
    maxResultSizeChars?: number;
}
//# sourceMappingURL=KernelTool.d.ts.map