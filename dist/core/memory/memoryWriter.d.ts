/**
 * Post-session memory writer.
 *
 * Runs a small flash model side-call at session shutdown to decide whether the
 * conversation contains public, mode-wide memories worth persisting.  The model
 * returns structured proposals only; this module performs all filesystem writes
 * so frontmatter stays constrained and mode boundaries are enforced.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ConversationMessage } from '../types.js';
import type { AgentMode } from '../dynamicPrompt.js';
export type MemoryWriteResult = {
    attempted: boolean;
    written: string[];
    skipped: string[];
};
export interface RunMemoryWriterOptions {
    client?: Anthropic | null;
    mode: AgentMode | string;
    domain?: string;
    messages: readonly ConversationMessage[];
    memoryDir?: string;
    /**
     * Model to use for the post-session memory writer side-call.
     *
     * Defaults to `DEFAULT_MEMORY_WRITER_MODEL` ('deepseek-v4-flash').
     * Pass `resolvedConfig.flashModel` (e.g. 'claude-haiku-4-5') when the
     * session uses a pure-Anthropic configuration without a DeepSeek API key,
     * otherwise the side-call will fail silently and no memories will be written.
     */
    model?: string;
    /** API key/baseURL used when the memory writer must create its own side-call client. */
    apiKey?: string;
    baseURL?: string;
}
export declare function runPostSessionMemoryWriter(opts: RunMemoryWriterOptions): Promise<MemoryWriteResult>;
//# sourceMappingURL=memoryWriter.d.ts.map