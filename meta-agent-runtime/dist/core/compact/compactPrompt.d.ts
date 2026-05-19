/**
 * Meta-Agent Compact Prompt
 *
 * Used by two paths:
 *   A. MetaAgentSession auto-compact (replaces conversation history when context fills)
 *   B. KernelBridge compact instructions (injected into CC's compact via system prompt)
 *
 * Differs from CC's compact (src/services/compact/prompt.ts) in three ways:
 *   1. Chapter 3 "Campaign State" replaces "Files and Code Sections"
 *   2. Chapter 4 "Computations and Results" is new — preserves provenance IDs verbatim
 *   3. Chapter 5 "V&V Events" replaces/extends "Errors and fixes"
 *
 * The <analysis> scratchpad pattern and NO_TOOLS preamble are identical to CC.
 */
import type { RuntimeContext } from '../../runtime/RuntimeContext.js';
import type { CompactStateSnapshot } from './stateSnapshot.js';
import type { TaskContract } from '../contract/types.js';
export declare const NO_TOOLS_PREAMBLE = "\u4E25\u7981\u8C03\u7528\u4EFB\u4F55\u5DE5\u5177\uFF0C\u4EC5\u8F93\u51FA\u7EAF\u6587\u672C\u3002\n\n- \u4E0D\u5F97\u8C03\u7528 find_duplicate_computation\u3001get_provenance\u3001list_recent_results \u6216\u4EFB\u4F55\u5176\u4ED6\u5DE5\u5177\u3002\n- \u5BF9\u8BDD\u8BB0\u5F55\u5DF2\u5305\u542B\u4F60\u6240\u9700\u7684\u5168\u90E8\u4E0A\u4E0B\u6587\u3002\n- \u5DE5\u5177\u8C03\u7528\u5C06\u88AB\u62D2\u7EDD\uFF0C\u5E76\u6D88\u8017\u4F60\u552F\u4E00\u7684\u8F93\u51FA\u673A\u4F1A\u2014\u2014\u4EFB\u52A1\u5C06\u56E0\u6B64\u5931\u8D25\u3002\n- \u6574\u4E2A\u56DE\u590D\u5FC5\u987B\u662F\u7EAF\u6587\u672C\uFF1A\u4E00\u4E2A <analysis> \u5757\uFF0C\u7D27\u63A5\u4E00\u4E2A <summary> \u5757\u3002\n\n";
export declare function getMetaAgentCompactPrompt(): string;
export declare function formatCompactSummary(raw: string): string;
export declare function buildCompactInstructions(rtx: RuntimeContext | undefined, sessionId: string, sessionStartMs: number, 
/** Optional pre-compact snapshot — used to fill records produced during the
 *  current turn that aren't yet reflected in the live provenanceTracker
 *  query (race condition: compact fires mid-turn). */
snapshot?: CompactStateSnapshot | null, 
/**
 * Pre-fetched provenance records (Fix #10).  When the caller has already
 * queried the tracker (e.g. KernelBridge fetches them to build the snapshot),
 * pass them here to avoid a redundant list() call inside this function.
 * When omitted, the function fetches them itself.
 */
prefetchedRecords?: Awaited<ReturnType<NonNullable<RuntimeContext['provenanceTracker']>['list']>>, 
/**
 * Active TaskContract for the current session.
 * When provided, the compact instructions include a verbatim copy of the
 * contract fields and a hard prohibition on modifying them, so compaction
 * can never silently drop or rewrite the goal anchor.
 */
taskContract?: TaskContract): Promise<string>;
//# sourceMappingURL=compactPrompt.d.ts.map