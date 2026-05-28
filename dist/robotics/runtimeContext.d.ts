/**
 * createRoboticsRuntimeContext — factory for the robotics VV + paging stack.
 *
 * Assembles all robotics-specific intelligence components into a single
 * cohesive stack:
 *
 *   FlashClient              ← shared flash-model client (one Anthropic instance)
 *   ExperiencePatternChecker ← flash-ranked failure pattern awareness (warn only)
 *   OOMChecker               ← order-of-magnitude sanity check
 *   PhysicsConstraintChecker ← hard physics bounds
 *   NoopProvenanceTracker    ← VV hooks run, but NO provenance recording or annotation
 *   RuntimeContext           ← wraps VVHookChain + JobManager + NoopProvenanceTracker
 *   QueryAnalyzer            ← flash-based intent analysis for pre-loading
 *
 * Why NoopProvenanceTracker:
 *   ProvenanceTracker is a campaign-mode concept — it records every simulation
 *   result to disk so DOE audit trails are complete.  In robotics mode the tools
 *   (progress_note, experience_search, git_diff, …) are control/orchestration
 *   operations, not simulation computations.  Provenance recording adds disk I/O
 *   on every tool call and injects "[provenance: prov-xxx]" into every tool result,
 *   polluting the context with irrelevant tokens.  The VV hooks still run — only
 *   the recording and annotation steps are suppressed.
 *
 * Extension for other modes:
 *   Campaign → createCampaignRuntimeContext() with real ProvenanceTracker
 *   Agentic  → plain runtimeContext (no VV hooks needed)
 */
import { FlashClient } from '../core/flash/FlashClient.js';
import { QueryAnalyzer } from '../context/QueryAnalyzer.js';
import type { ExperienceStore } from './ExperienceStore.js';
import type { ContextPager } from '../context/ContextPager.js';
import type { RuntimeContext } from '../runtime/RuntimeContext.js';
import type { MetaAgentConfig } from '../core/config.js';
export interface RoboticsRuntimeContextOptions {
    sessionId: string;
    /** Used by FlashClient to resolve API key and flash model identifier */
    config: Pick<MetaAgentConfig, 'apiKey' | 'baseURL' | 'model'>;
    experienceStore: ExperienceStore;
    contextPager: ContextPager;
}
export interface RoboticsRuntimeContextResult {
    /** Pass this to AgenticSession via MetaAgentConfig.runtimeContext */
    runtimeContext: RuntimeContext;
    /** Use in RoboticsSession.submit() to analyze query intent */
    queryAnalyzer: QueryAnalyzer;
    /** Expose for testing and cache management */
    flashClient: FlashClient;
}
export declare function createRoboticsRuntimeContext(opts: RoboticsRuntimeContextOptions): RoboticsRuntimeContextResult;
//# sourceMappingURL=runtimeContext.d.ts.map