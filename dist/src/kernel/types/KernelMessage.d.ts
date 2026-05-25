/**
 * KernelMessage — internal message representation.
 *
 * CC uses a complex Message union with many subtypes. We keep the essential
 * structure that the API and loop need, while stripping CLI-only fields.
 */
import type Anthropic from '@anthropic-ai/sdk';
export type TextBlock = Anthropic.TextBlockParam;
export type ImageBlock = Anthropic.ImageBlockParam;
export type ToolUseBlock = Anthropic.ToolUseBlockParam;
export type ToolResultBlock = Anthropic.ToolResultBlockParam;
export type ThinkingBlock = {
    type: 'thinking';
    thinking: string;
};
export type RedactedThinkingBlock = {
    type: 'redacted_thinking';
    data: string;
};
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | RedactedThinkingBlock;
export type MessageRole = 'user' | 'assistant';
/**
 * Base message that maps 1:1 to API messages (role + content).
 * Additional metadata is stored in optional fields.
 */
export interface KernelMessage {
    uuid: string;
    role: MessageRole;
    content: ContentBlock[];
    isMeta?: boolean;
    isCompactSummary?: boolean;
    isInterruption?: boolean;
    usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
    };
    stopReason?: string | null;
    sourceToolAssistantUUID?: string;
    isCompactBoundary?: boolean;
    systemSubtype?: 'compact_boundary' | 'api_retry' | 'warning' | 'info';
}
/** Create a minimal user message */
export declare function makeUserMessage(content: ContentBlock[], meta?: Partial<Pick<KernelMessage, 'isMeta' | 'isCompactSummary' | 'isInterruption' | 'sourceToolAssistantUUID'>>): KernelMessage;
/** Create a minimal assistant message */
export declare function makeAssistantMessage(content: ContentBlock[], meta?: Partial<Pick<KernelMessage, 'usage' | 'stopReason'>>): KernelMessage;
/** Compact boundary sentinel – treated as a system message in the loop */
export declare function makeCompactBoundaryMessage(): KernelMessage;
//# sourceMappingURL=KernelMessage.d.ts.map