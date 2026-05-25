import { makeCompactBoundaryMessage, makeTextUserMessage } from '../messages/MessageFactory.js';
import { buildCompactSummaryMessage } from './CompactPrompt.js';
/**
 * Build the post-compact message block.
 *
 * @param rawSummary    - Formatted summary text from the compact agent
 * @param fileCache     - Will be cleared (files need re-reading after compact)
 */
export function buildPostCompactMessages(rawSummary, fileCache) {
    // 1. Boundary marker
    const boundaryMarker = makeCompactBoundaryMessage();
    // 2. Summary user message
    const summaryText = buildCompactSummaryMessage(rawSummary);
    const summaryMessage = makeTextUserMessage(summaryText, { isCompactSummary: true });
    // 3. Clear file state cache (files need to be re-read in the new context)
    fileCache.clear();
    // rough token estimate: 1 token ≈ 4 chars
    const summaryTokenEstimate = Math.ceil(summaryText.length / 4);
    const postCompactMessages = [
        boundaryMarker,
        summaryMessage,
    ];
    return { postCompactMessages, summaryTokenEstimate };
}
//# sourceMappingURL=PostCompact.js.map