/**
 * KernelLoop — the while(true) agentic loop.
 *
 * Direct equivalent of CC's query.ts queryLoop().
 * Step numbers match cc-kernel-rewrite-detailed-plan.md §2.2.
 */
import type { KernelConfig } from '../types/KernelConfig.js';
import type { KernelEvent, PermissionDenial } from '../types/KernelEvent.js';
import type { KernelMessage } from '../types/KernelMessage.js';
import type { TokenUsage } from '../types/TokenUsage.js';
import { type AutoCompactTrackingState } from '../compact/AutoCompact.js';
import type { FileStateCache } from '../session/FileStateCache.js';
export type LoopTerminationReason = 'success' | 'max_turns' | 'no_progress' | 'blocking_limit' | 'aborted_streaming' | 'aborted_tools' | 'max_budget_usd' | 'error';
export interface LoopResult {
    reason: LoopTerminationReason;
    totalUsage: TokenUsage;
    costUsd: number;
    numTurns: number;
    resultText: string;
    finalModel: string;
    fallbackTriggered: boolean;
    permissionDenials: PermissionDenial[];
    finalMessages: KernelMessage[];
    autoCompactTracking: AutoCompactTrackingState | undefined;
}
export interface KernelLoopContext {
    config: KernelConfig;
    /** Shared mutable array — the loop appends to it; KernelSession owns it */
    mutableMessages: KernelMessage[];
    abortController: AbortController;
    fileCache: FileStateCache;
    sessionId: string;
    cwd: string;
    cumulativeCostUsd: number;
    autoCompactTracking?: AutoCompactTrackingState;
}
export declare function runKernelLoop(ctx: KernelLoopContext): AsyncGenerator<KernelEvent, LoopResult>;
//# sourceMappingURL=KernelLoop.d.ts.map