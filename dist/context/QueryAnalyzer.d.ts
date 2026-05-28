/**
 * QueryAnalyzer — flash-model based query intent analysis.
 *
 * Analyzes the user's prompt before each turn to determine:
 *   - Which robotics domains are relevant
 *   - Whether real hardware execution is likely
 *   - Risk level (drives safety limit pre-loading)
 *   - Keywords to pre-fetch failure records from ExperienceStore
 *   - Broad intent classification (debug / deploy / experiment / etc.)
 *
 * Uses a FlashModel side-call (3 s timeout) for semantic understanding.
 * Falls back to heuristic keyword analysis on timeout/failure.
 *
 * Results are cached by query content hash, so identical follow-up prompts
 * incur zero additional latency.
 */
import type { FlashClient } from '../core/flash/FlashClient.js';
import type { RoboticsDomain } from '../robotics/types.js';
export interface QueryIntent {
    /** Robotics domains likely relevant to this query */
    domains: RoboticsDomain[];
    /** True if the query likely involves real hardware execution */
    hasHardware: boolean;
    /** True if the query likely involves simulation only */
    hasSimulation: boolean;
    /** Risk level: drives whether safety limits are pre-loaded */
    riskLevel: 'low' | 'medium' | 'high';
    /** Keywords to use for ExperienceStore failure pre-fetch */
    searchKeywords: string[];
    /** Broad intent classification */
    intent: 'debug' | 'deploy' | 'experiment' | 'calibrate' | 'query' | 'plan';
}
export declare class QueryAnalyzer {
    private readonly flash;
    constructor(flash: FlashClient);
    /**
     * Analyze a user query to determine what context should be pre-loaded.
     *
     * Always returns a valid QueryIntent — falls back to heuristics if the
     * flash model call times out or returns unparseable output.
     */
    analyze(query: string): Promise<QueryIntent>;
}
//# sourceMappingURL=QueryAnalyzer.d.ts.map