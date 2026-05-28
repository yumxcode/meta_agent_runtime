/**
 * TokenEstimator — lightweight heuristic token count.
 *
 * Exact tokenisation requires the model's tokeniser library.
 * For budget management purposes a rough estimate is sufficient:
 *   ~4 characters ≈ 1 token (English/code mixed content)
 *
 * This avoids importing a tokeniser dependency and keeps the hot path fast.
 */
/**
 * Estimate the number of tokens in a string.
 * Rounds up to avoid under-estimating and hitting context limits.
 */
export declare function estimateTokens(text: string): number;
/**
 * Estimate tokens for an object by serialising it first.
 * Useful for structured data (ExperienceEntry fields, etc.).
 */
export declare function estimateTokensForObject(obj: unknown): number;
//# sourceMappingURL=TokenEstimator.d.ts.map