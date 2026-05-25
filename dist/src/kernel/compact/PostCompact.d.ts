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
import type { KernelMessage } from '../types/KernelMessage.js';
import type { FileStateCache } from '../session/FileStateCache.js';
export interface CompactionResult {
    postCompactMessages: KernelMessage[];
    summaryTokenEstimate: number;
}
/**
 * Build the post-compact message block.
 *
 * @param rawSummary    - Formatted summary text from the compact agent
 * @param fileCache     - Will be cleared (files need re-reading after compact)
 */
export declare function buildPostCompactMessages(rawSummary: string, fileCache: FileStateCache): CompactionResult;
//# sourceMappingURL=PostCompact.d.ts.map