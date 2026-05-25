/**
 * CompactPrompt — the 9-section summarisation prompt.
 * Mirrors CC's prompt.ts exactly, including the ## Compact Instructions injection.
 */
/**
 * Extract the content of a ## Compact Instructions section from a system prompt.
 * Returns undefined if the section is not found.
 */
export declare function extractCompactInstructions(systemPrompt: string): string | undefined;
/**
 * Build the full compact prompt sent to the summarisation agent.
 *
 * @param customInstructions  - From config.compact.customInstructions or
 *                              extracted from ## Compact Instructions in system prompt
 */
export declare function buildCompactPrompt(customInstructions?: string): string;
/**
 * Format the raw compact summary from the model:
 * 1. Strip <analysis>...</analysis> (private reasoning scratchpad)
 * 2. Replace <summary>...</summary> wrapper with "Summary:\n[content]"
 * 3. Collapse excessive blank lines
 */
export declare function formatCompactSummary(raw: string): string;
/**
 * Build the compact summary user message text.
 * Mirrors CC's getCompactUserSummaryMessage.
 */
export declare function buildCompactSummaryMessage(formattedSummary: string): string;
//# sourceMappingURL=CompactPrompt.d.ts.map