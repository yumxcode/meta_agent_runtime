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
 *   - max 5 candidate files (same as CC)
 */
import type Anthropic from '@anthropic-ai/sdk';
import { type MemoryType } from './types.js';
import type { AgentMode } from '../dynamicPrompt.js';
/** Valid scope values for memory entries. */
export type MemoryScope = 'global' | 'project' | 'campaign' | 'domain';
/** Valid confidence levels for memory entries. */
export type MemoryConfidence = 'high' | 'medium' | 'low';
export type TopicFileHeader = {
    filename: string;
    filePath: string;
    /** From frontmatter `name:` field, or derived from filename */
    name: string;
    /** From frontmatter `description:` field */
    description: string;
    type: MemoryType | undefined;
    date: string | undefined;
    campaign: string | undefined;
    source: string | undefined;
    mtimeMs: number;
    /** Applicability scope.  Defaults to 'global' when absent. */
    scope: MemoryScope | undefined;
    /** Engineering domain tag for domain-scoped memories. */
    domain: string | undefined;
    /**
     * ISO date string (YYYY-MM-DD) after which this memory should not be recalled.
     * Prevents stale standard values / outdated material properties from polluting
     * long-running task context.
     */
    validUntil: string | undefined;
    /** Model confidence in the stored fact. */
    confidence: MemoryConfidence | undefined;
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
     * When provided, memories whose `scope` is `project` but whose project tag
     * does not match are excluded.  Pass the current project/campaign identifier.
     * Memories with `scope: 'global'` or no scope are always included.
     */
    projectScope?: string;
    /**
     * Current campaign ID.  Memories with `scope: 'campaign'` whose `campaign`
     * field does not match are excluded.
     */
    campaignScope?: string;
    /**
     * Current engineering domain.  Memories with `scope: 'domain'` whose
     * `domain` field does not match are excluded.
     */
    domainScope?: string;
    /**
     * When true (default), memories whose `valid_until` date is in the past are
     * excluded from recall.  Set to false to include expired memories (e.g., for
     * debugging or explicit "show me all memories" queries).
     */
    filterStale?: boolean;
    /**
     * Current session mode.  Used to exclude mode-irrelevant memory types:
     *   - 'robotics': excludes campaign_lessons (DOE-specific) unless domain='robotics'
     *   - 'campaign': excludes memories with domain='robotics'
     *   - 'direct' / 'agentic': no extra filtering beyond scope/freshness
     * Prevents cross-mode memory contamination (e.g. battery DOE lessons appearing
     * in a humanoid robot session).
     */
    sessionMode?: string;
}
/**
 * Find and load the memory files most relevant to the current query.
 *
 * Always loads: user + feedback topic files (small, always applicable).
 * Loads from candidates: domain_knowledge, campaign_lessons, reference files
 *   selected by Haiku side-call (when client provided) or keyword match.
 *
 * Applies scope and freshness filters before selection so stale or out-of-scope
 * memories cannot pollute a long-running task's context.
 *
 * Returns an array of { header, content } objects ready to inject into the
 * system prompt.  Empty array when no memory files exist yet.
 */
export declare function findRelevantMemories(opts: FindRelevantMemoriesOptions): Promise<RelevantMemory[]>;
//# sourceMappingURL=findRelevantMemories.d.ts.map