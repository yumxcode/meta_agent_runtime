import type { KernelMessage } from '../types/KernelMessage.js';
import type { FileStateCache } from '../session/FileStateCache.js';
import type { ThinkingConfig } from '../types/KernelConfig.js';
import type { CompactionResult } from './PostCompact.js';
export interface CompactOptions {
    model?: string;
    apiKey?: string;
    baseURL?: string;
    systemPrompt?: string;
    customInstructions?: string;
    thinkingConfig?: ThinkingConfig;
    abortSignal?: AbortSignal;
    maxRetries?: number;
}
/**
 * Run the compact summarisation.
 * Returns the CompactionResult (boundary + summary messages), or throws on failure.
 */
export declare function compactConversation(messages: readonly KernelMessage[], fileCache: FileStateCache, options?: CompactOptions): Promise<CompactionResult>;
//# sourceMappingURL=CompactConversation.d.ts.map