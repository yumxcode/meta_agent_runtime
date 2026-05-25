/**
 * Post-session memory writer.
 *
 * Runs a small Haiku side-call at session shutdown to decide whether the
 * conversation contains public, mode-wide memories worth persisting.  The model
 * returns structured proposals only; this module performs all filesystem writes
 * so frontmatter stays constrained and mode boundaries are enforced.
 */
import type Anthropic from '@anthropic-ai/sdk';
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
}
export declare function runPostSessionMemoryWriter(opts: RunMemoryWriterOptions): Promise<MemoryWriteResult>;
//# sourceMappingURL=memoryWriter.d.ts.map