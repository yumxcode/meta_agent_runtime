/**
 * Meta-Agent Memory — per-query topic file relevance selection
 *
 * Architecture mirrors CC's findRelevantMemories.ts:
 *   1. Scan all topic files and extract frontmatter headers
 *   2. Split files into always-relevant (user + feedback) and candidates
 *   3. Select candidates via Haiku side-call (when Anthropic client provided)
 *      or keyword match (fallback)
 *   4. Load and return file content for selected files
 *
 * Differences from CC:
 *   - Uses Haiku (not Sonnet) for relevance — task is simpler, cost lower
 *   - No alreadySurfaced dedup (all injected via system prompt, not per-turn)
 *   - campaign_lessons type: only loaded in campaign mode by default
 *   - robot_lessons type: only loaded in robotics mode by default
 *   - max 5 candidate files (same as CC)
 */
import type Anthropic from '@anthropic-ai/sdk';
import { type MemoryType } from './types.js';
import type { AgentMode } from '../dynamicPrompt.js';
/** Valid scope values for memory entries. */
export type MemoryScope = 'global' | 'domain';
export type TopicFileHeader = {
    filename: string;
    filePath: string;
    /** From frontmatter `name:` field, or derived from filename */
    name: string;
    /** From frontmatter `description:` field */
    description: string;
    type: MemoryType | undefined;
    date: string | undefined;
    source: string | undefined;
    mtimeMs: number;
    /** Applicability scope.  Defaults to 'global' when absent. */
    scope: MemoryScope | undefined;
    /** Engineering domain tag for domain-scoped memories. */
    domain: string | undefined;
    /** Whether the fact has been verified against a primary source. */
    sourceVerified: boolean | undefined;
    /**
     * When true the memory should be presented with a revalidation notice
     * so the model knows to confirm before use.
     */
    requiresRevalidation: boolean | undefined;
};
export type RelevantMemory = {
    header: TopicFileHeader;
    /** Full file content including frontmatter */
    content: string;
};
/**
 * Read all *.md files in the memory directory (excluding MEMORY.md) and
 * extract their frontmatter headers.  Files that cannot be parsed are skipped.
 */
export declare function scanTopicFiles(memoryDir?: string): Promise<TopicFileHeader[]>;
export interface FindRelevantMemoriesOptions {
    query: string;
    mode?: AgentMode;
    memoryDir?: string;
    client?: Anthropic;
    /** Maximum number of candidate (non-always-relevant) topic files to load. Default: 5 */
    maxCandidates?: number;
    /**
     * Current engineering domain.  Memories with `scope: 'domain'` whose
     * `domain` field does not match are excluded.
     */
    domainScope?: string;
    /**
     * Current session mode.  Used to exclude mode-irrelevant memory types:
     *   - 'robotics': excludes campaign_lessons; includes robot_lessons
     *   - 'campaign': excludes robot_lessons; includes campaign_lessons
     *   - 'agentic': excludes both mode-specific lesson types
     * Prevents cross-mode memory contamination (e.g. battery DOE lessons appearing
     * in a humanoid robot session).
     */
    sessionMode?: string;
}
/**
 * Find and load the memory files most relevant to the current query.
 *
 * Always loads: user + feedback topic files (small, always applicable).
 * Loads from candidates: domain_knowledge, campaign_lessons, robot_lessons, reference files
 *   selected by Haiku side-call (when client provided) or keyword match.
 *
 * Applies scope and mode filters before selection so out-of-scope memories
 * cannot pollute a long-running task's context.
 *
 * Returns an array of { header, content } objects ready to inject into the
 * system prompt.  Empty array when no memory files exist yet.
 */
export declare function findRelevantMemories(opts: FindRelevantMemoriesOptions): Promise<RelevantMemory[]>;
//# sourceMappingURL=findRelevantMemories.d.ts.map