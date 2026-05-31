/**
 * ModeDetector — two-layer mode classification.
 *
 * Layer 1: Explicit hint (zero cost)
 *   If the caller passed mode !== 'auto', return immediately.
 *
 * Layer 2: Prompt classification
 *   Preferred: one-shot flash-model call when an Anthropic client is provided
 *   (handles every edge case the heuristics can't).
 *   Fallback: prompt-pattern heuristics, in this priority order:
 *     0. ROBOTICS_ALWAYS — robotics-domain imperative patterns (ROS, SLAM,
 *        gait, manipulation, sim-to-real, RL-for-robots). Override everything.
 *     A. CAMPAIGN_ALWAYS — inherent action patterns that are unambiguously
 *        "run a campaign now" (parameter sweep, background execution, etc.).
 *     C. CAMPAIGN_ACTION — action verb (run / compute / launch / 做 / 优化…)
 *        combined with campaign vocabulary anywhere in the prompt.
 *     D. CAMPAIGN_VOCAB — campaign vocabulary without any action verb.
 *     F. Default → AGENTIC.
 *
 * (An earlier draft also looked at CampaignStateStore on disk as a Layer 3
 *  signal — see git history. It was removed because the on-disk store is not
 *  authoritative for mode selection, and the LLM/heuristic path already
 *  defaults to AGENTIC.)
 *
 * Note on Chinese text:
 *   \b word-boundary anchors do NOT work for CJK characters (all CJK chars
 *   are \W, so \b never fires around them). All Chinese patterns use plain
 *   substring matching with no \b.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ModeDetectionResult, SessionModeHint } from './types.js';
export declare class ModeDetector {
    /**
     * Full async detect — layers 1–3 including the env disk check.
     *
     * When `client` is provided, Layer 2 uses a one-shot flash model call instead of
     * regex heuristics. This costs ~300–500 ms and ~$0.00012 per session, and
     * handles every edge case (language, intent, domain vocabulary) that the
     * heuristics cannot. Falls back to heuristics automatically on any error.
     *
     * Without `client`, behaviour is unchanged from the previous heuristic-only
     * implementation.
     */
    static detect(prompt: string, hint?: SessionModeHint, hasTools?: boolean, client?: Anthropic, model?: string): Promise<ModeDetectionResult>;
    /**
     * One-shot flash model classification. Returns a result with confidence='llm'.
     * On any error (network, timeout, unexpected output) silently falls back
     * to the heuristic path so the session always proceeds.
     */
    private static _detectWithLLM;
    /**
     * Synchronous detect — layers 1 and 2 only (no disk I/O).
     */
    static detectSync(prompt: string, hint?: SessionModeHint, hasTools?: boolean): ModeDetectionResult;
}
//# sourceMappingURL=ModeDetector.d.ts.map