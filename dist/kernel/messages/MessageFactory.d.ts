/**
 * MessageFactory — helper functions that build KernelMessages.
 *
 * Mirrors CC's messages.ts factory functions but scoped to what the kernel needs.
 */
import { makeUserMessage, makeAssistantMessage, makeCompactBoundaryMessage, type KernelMessage, type ContentBlock } from '../types/KernelMessage.js';
export { makeUserMessage, makeAssistantMessage, makeCompactBoundaryMessage };
/** User message that injects a string as a text block */
export declare function makeTextUserMessage(text: string, meta?: Partial<Pick<KernelMessage, 'isMeta' | 'isCompactSummary' | 'isInterruption'>>): KernelMessage;
/** User interruption message (added when the agentic loop is aborted) */
export declare function makeInterruptionMessage(afterToolUse: boolean): KernelMessage;
/**
 * Tool-result user message.
 * CC wraps these as user messages with a tool_result content block.
 */
export declare function makeToolResultMessage(toolUseId: string, content: string | ContentBlock[], isError: boolean, sourceToolAssistantUUID: string): KernelMessage;
/** System/warning text message (not a real API message, used for UI events) */
export declare function makeSystemMessage(text: string, subtype?: 'warning' | 'info'): KernelMessage;
/**
 * Recovery continuation message (isMeta=true, not shown to user).
 * Injected after max_output_tokens to prompt the model to continue.
 */
export declare const MAX_OUTPUT_TOKENS_RECOVERY_TEXT: string;
export declare function makeMaxOutputTokensRecoveryMessage(): KernelMessage;
//# sourceMappingURL=MessageFactory.d.ts.map