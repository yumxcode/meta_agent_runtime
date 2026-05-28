/**
 * Campaign memory block builder.
 *
 * Builds the MEMORY.md + recalled topic files section for CampaignSession.
 * Extracted from _buildEnrichedSuffix() so it can be unit-tested independently.
 *
 * Mirrors the logic in buildMemoryContentSection() (dynamicPrompt.ts) but returns
 * a plain string instead of a SystemPromptSection — CampaignSession doesn't use
 * SectionRegistry for its per-turn context injection.
 */
/**
 * Build the memory context block for a campaign turn.
 *
 * @param prompt  The current user query — used for per-query relevance selection.
 * @returns       Markdown string with MEMORY.md index + recalled files, or null if
 *                both index and recalled list are empty (nothing to inject).
 */
export declare function buildCampaignMemoryBlock(prompt: string): Promise<string | null>;
//# sourceMappingURL=campaignMemory.d.ts.map