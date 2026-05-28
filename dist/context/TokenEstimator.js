/**
 * TokenEstimator — lightweight heuristic token count.
 *
 * Exact tokenisation requires the model's tokeniser library.
 * For budget management purposes a rough estimate is sufficient:
 *   ~4 characters ≈ 1 token (English/code mixed content)
 *
 * This avoids importing a tokeniser dependency and keeps the hot path fast.
 */
const CHARS_PER_TOKEN = 4;
/**
 * Estimate the number of tokens in a string.
 * Rounds up to avoid under-estimating and hitting context limits.
 */
export function estimateTokens(text) {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}
/**
 * Estimate tokens for an object by serialising it first.
 * Useful for structured data (ExperienceEntry fields, etc.).
 */
export function estimateTokensForObject(obj) {
    return estimateTokens(JSON.stringify(obj) ?? '');
}
//# sourceMappingURL=TokenEstimator.js.map