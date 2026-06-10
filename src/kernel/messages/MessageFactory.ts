/**
 * MessageFactory — helper functions that build KernelMessages.
 *
 * Mirrors CC's messages.ts factory functions but scoped to what the kernel needs.
 */
import {
  makeUserMessage,
  makeAssistantMessage,
  makeCompactBoundaryMessage,
  type KernelMessage,
  type ContentBlock,
} from '../types/KernelMessage.js'

export { makeUserMessage, makeAssistantMessage, makeCompactBoundaryMessage }

// ── Specialised factories ────────────────────────────────────────────────────

/** User message that injects a string as a text block */
export function makeTextUserMessage(text: string, meta?: Partial<Pick<KernelMessage, 'isMeta' | 'isCompactSummary' | 'isInterruption' | 'isSteering'>>): KernelMessage {
  return makeUserMessage([{ type: 'text', text }], meta)
}

/** User interruption message (added when the agentic loop is aborted) */
export function makeInterruptionMessage(afterToolUse: boolean): KernelMessage {
  const text = afterToolUse
    ? '[Interrupted by user — operation may be incomplete]'
    : '[Interrupted by user]'
  return makeUserMessage([{ type: 'text', text }], { isInterruption: true })
}

/**
 * Tool-result user message.
 * CC wraps these as user messages with a tool_result content block.
 */
export function makeToolResultMessage(
  toolUseId: string,
  content: string | ContentBlock[],
  isError: boolean,
  sourceToolAssistantUUID: string,
): KernelMessage {
  // The SDK's ToolResultBlockParam.content only accepts string | (TextBlockParam | ImageBlockParam)[].
  // We cast through unknown to satisfy TS while preserving our broader ContentBlock[] support.
  const resultContent = (
    typeof content === 'string'
      ? {
          type: 'tool_result' as const,
          tool_use_id: toolUseId,
          content: content,
          is_error: isError,
        }
      : {
          type: 'tool_result' as const,
          tool_use_id: toolUseId,
          content: content as unknown as string,
          is_error: isError,
        }
  ) as unknown as ContentBlock

  return makeUserMessage([resultContent], { sourceToolAssistantUUID })
}

/** System/warning text message (not a real API message, used for UI events) */
export function makeSystemMessage(
  text: string,
  subtype: 'warning' | 'info' = 'info',
): KernelMessage {
  return {
    uuid: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    systemSubtype: subtype,
  }
}

/**
 * Recovery continuation message (isMeta=true, not shown to user).
 * Injected after max_output_tokens to prompt the model to continue.
 */
export const MAX_OUTPUT_TOKENS_RECOVERY_TEXT =
  'Output token limit hit. Resume directly — no apology, no recap of what you were doing. ' +
  'Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.'

export function makeMaxOutputTokensRecoveryMessage(): KernelMessage {
  return makeTextUserMessage(MAX_OUTPUT_TOKENS_RECOVERY_TEXT, { isMeta: true })
}
