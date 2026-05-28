/**
 * context/ — demand-paged knowledge management for LLM prompts.
 *
 * Public exports for use by session modes (robotics, campaign, agentic).
 */
export { ContextPager } from './ContextPager.js';
export type { PageSlot, SlotPriority, SlotSource, ContextPagerOptions } from './types.js';
export { estimateTokens, estimateTokensForObject } from './TokenEstimator.js';
export { QueryAnalyzer } from './QueryAnalyzer.js';
export type { QueryIntent } from './QueryAnalyzer.js';
export type { IKnowledgeSource, ExperienceMatch, ExperienceListOpts } from './sources/IKnowledgeSource.js';
export { ExperienceSource } from './sources/ExperienceSource.js';
//# sourceMappingURL=index.d.ts.map