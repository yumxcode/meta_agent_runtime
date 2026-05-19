/**
 * CapsuleBuilder — deterministic, LLM-free context capsule generator.
 *
 * Input:  CampaignStateStore (current state) + ParetoFront | null
 * Output: CampaignContextCapsule
 *
 * The capsule's contextBlock is a compact Markdown summary (< 500 tokens)
 * injected into the conversation context when the user resumes a session.
 * Because it is pre-computed at phase-transition time, injection at session
 * start costs zero compute — just a disk read.
 *
 * No API calls, no LLM, fully deterministic. Safe to run inside CampaignMonitor.
 */
import type { CampaignContextCapsule, ParetoFront } from './types.js';
import type { CampaignStateStore } from './CampaignStateStore.js';
export declare function buildCapsule(store: CampaignStateStore, front: ParetoFront | null): CampaignContextCapsule;
//# sourceMappingURL=CapsuleBuilder.d.ts.map