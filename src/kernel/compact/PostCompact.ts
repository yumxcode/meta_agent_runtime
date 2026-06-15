/**
 * PostCompact — build the messages that follow a compact boundary.
 * Mirrors CC's buildPostCompactMessages / getDeferredToolsDeltaAttachment.
 *
 * Order (must match CC):
 *   1. boundaryMarker
 *   2. summaryMessages
 *   3. messagesToKeep (reactive compact path — we skip this)
 *   4. attachments (file re-declarations, tool deltas)
 *   5. hookResults (❌ not implemented)
 */
import type { KernelMessage } from '../types/KernelMessage.js'
import type { FileStateCache } from '../session/FileStateCache.js'
import { makeCompactBoundaryMessage, makeTextUserMessage } from '../messages/MessageFactory.js'
import { buildCompactSummaryMessage } from './CompactPrompt.js'

export interface CompactionResult {
  postCompactMessages: KernelMessage[]
  summaryTokenEstimate: number
}

/**
 * Build the post-compact message block.
 *
 * @param rawSummary    - Formatted summary text from the compact agent
 * @param fileCache     - Will be cleared (files need re-reading after compact)
 * @param messagesToKeep - Verbatim tail preserved outside the summary
 * @param turnComplete  - true when compaction ran at a finished turn boundary;
 *   selects the "await next instruction" summary postamble over "resume".
 */
export function buildPostCompactMessages(
  rawSummary: string,
  fileCache: FileStateCache,
  messagesToKeep: readonly KernelMessage[] = [],
  turnComplete = false,
): CompactionResult {
  // 1. Boundary marker
  const boundaryMarker = makeCompactBoundaryMessage()

  // 2. Summary user message
  const summaryText = buildCompactSummaryMessage(rawSummary, turnComplete)
  const summaryMessage = makeTextUserMessage(summaryText, { isCompactSummary: true })

  // 3. Preserve lightweight file-awareness before clearing the cache. The file
  // contents are intentionally not reattached; the model should re-read only
  // files it still needs after compact.
  const fileEntries = fileCache.getAll()
  const fileReminder = fileEntries.length > 0
    ? makeTextUserMessage(
        [
          'Files read before compaction are no longer present in context.',
          'Re-read any file before relying on its contents:',
          ...fileEntries
            .slice(0, 50)
            .map(entry => `- ${entry.path} (${entry.sizeBytes} bytes)`),
          ...(fileEntries.length > 50
            ? [`- ... ${fileEntries.length - 50} more file(s) omitted`]
            : []),
        ].join('\n'),
        { isMeta: true },
      )
    : null

  // 4. Clear file state cache (files need to be re-read in the new context)
  fileCache.clear()

  // rough token estimate: 1 token ≈ 4 chars
  const summaryTokenEstimate = Math.ceil(summaryText.length / 4)

  const postCompactMessages: KernelMessage[] = [
    boundaryMarker,
    summaryMessage,
    ...messagesToKeep,
    ...(fileReminder ? [fileReminder] : []),
  ]

  return { postCompactMessages, summaryTokenEstimate }
}
