/**
 * eventAdapter — KernelEvent → MetaAgentEvent translation.
 *
 * KernelEvent uses snake_case event types that mirror CC's internal SDKMessage.
 * MetaAgentEvent uses the same structure but with slightly different names.
 * This module provides a pure translator with no side effects.
 */
import type { KernelEvent } from '../kernel/index.js';
import type { MetaAgentEvent, TokenUsage } from '../core/types.js';
export interface TranslationState {
    sessionId: string;
    startMs: number;
    turnCount: number;
    totalCostUsd: number;
    usage: TokenUsage;
}
/**
 * Translate a single KernelEvent to zero or more MetaAgentEvents.
 * Returns a (possibly empty) array — not a generator — to keep callers simple.
 */
export declare function translateKernelEvent(event: KernelEvent, state: TranslationState): MetaAgentEvent[];
//# sourceMappingURL=eventAdapter.d.ts.map