/**
 * messageBridge — ConversationMessage ⇄ KernelMessage conversion.
 *
 * Single source of truth for the resume-path conversion (previously duplicated
 * in AgenticSession and CampaignSession, both of which dropped all kernel
 * metadata — review finding F-1). Flags must survive the round-trip:
 * history.jsonl stores whole message objects, so isCompactSummary /
 * isCompactBoundary / isMeta / isSteering / isKeepSetClone ride along in
 * persistence and are restored here. Without them, a resumed session treats
 * compact summaries and keep-set clones as real user messages — breaking
 * boundary slicing and poisoning the top-level goal anchor.
 */
import type { ConversationMessage } from '../core/types.js'
import type { KernelMessage } from '../kernel/index.js'

export function toKernelMessages(
  messages: readonly ConversationMessage[] | undefined,
): KernelMessage[] {
  return (messages ?? []).map(message => {
    const kernel: KernelMessage = {
      // Preserve the original kernel uuid when the record carries one so
      // sourceUuid references and dedupe sets stay valid across resume.
      uuid: message.uuid ?? crypto.randomUUID(),
      role: message.role,
      content: typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content as KernelMessage['content'],
    }
    if (message.isMeta) kernel.isMeta = true
    if (message.isCompactSummary) kernel.isCompactSummary = true
    if (message.isCompactBoundary) kernel.isCompactBoundary = true
    if (message.isSteering) kernel.isSteering = true
    if (message.isInterruption) kernel.isInterruption = true
    if (message.isKeepSetClone) kernel.isKeepSetClone = true
    if (message.sourceUuid) kernel.sourceUuid = message.sourceUuid
    if (message.sourceToolAssistantUUID) {
      kernel.sourceToolAssistantUUID = message.sourceToolAssistantUUID
    }
    return kernel
  })
}
