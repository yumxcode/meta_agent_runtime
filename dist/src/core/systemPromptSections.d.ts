/**
 * System Prompt Section Registry
 *
 * A lightweight memoization layer for system prompt sections, inspired by the
 * pattern used in Claude Code (src/constants/systemPromptSections.ts).
 *
 * Two section types:
 *   - memoized  : computed once per session, cached until invalidated
 *   - volatile  : recomputed on every call (DANGEROUS — breaks prompt cache)
 *
 * One SectionRegistry is created per MetaAgentSession.  Sections that depend
 * on per-turn state (campaign_context, phase_guidance) are marked volatile.
 * All others are memoized and only recomputed when explicitly invalidated.
 */
type ComputeFn = () => string | null | Promise<string | null>;
export interface SystemPromptSection {
    readonly name: string;
    readonly compute: ComputeFn;
    /** If true, recompute every call (cache-breaking). */
    readonly volatile: boolean;
}
/**
 * Create a memoized section.
 * Computed once and cached until `registry.invalidate(name)` or `invalidateAll()`.
 */
export declare function systemPromptSection(name: string, compute: ComputeFn): SystemPromptSection;
/**
 * Create a volatile section that recomputes on every resolve() call.
 *
 * WARNING: Volatile sections break the Anthropic prompt cache whenever their
 * content changes.  Only use when the value genuinely changes between turns
 * and staleness would cause incorrect model behaviour.
 *
 * @param _reason  — document why cache-breaking is acceptable here.
 */
export declare function DANGEROUS_uncachedSystemPromptSection(name: string, compute: ComputeFn, _reason: string): SystemPromptSection;
/**
 * Per-session cache for memoized system prompt sections.
 *
 * Usage:
 *   const registry = new SectionRegistry()
 *   const sections = [memorySection, envSection, campaignContextSection, ...]
 *   const strings = await registry.resolve(sections)
 *   const systemPrompt = strings.filter(Boolean).join('\n\n')
 */
export declare class SectionRegistry {
    private readonly cache;
    /**
     * Remove a single section from the cache so it will be recomputed next call.
     * No-op if the section was not yet cached.
     */
    invalidate(name: string): void;
    /**
     * Clear the entire section cache (e.g. on /clear or /compact equivalent).
     */
    invalidateAll(): void;
    /**
     * Resolve all sections in parallel, returning their string values in order.
     * Memoized sections are read from cache when available.
     * Volatile sections are always recomputed.
     * Null/empty-string results are preserved — callers should filter them out.
     */
    resolve(sections: SystemPromptSection[]): Promise<(string | null)[]>;
    /**
     * Resolve sections and join non-empty results with double newlines.
     * Convenience wrapper over resolve().
     */
    resolveToString(sections: SystemPromptSection[]): Promise<string>;
}
export {};
//# sourceMappingURL=systemPromptSections.d.ts.map