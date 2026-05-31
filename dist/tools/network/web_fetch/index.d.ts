import type { MetaAgentTool } from '../../../core/types.js';
/**
 * M4: Allow tests / callers to clear the module-level cache.
 *
 * Exposed so vitest can reset state between cases and so application code
 * can drop cached pages on demand (e.g. when network conditions change or
 * the user explicitly asks for a fresh fetch).
 */
export declare function clearWebFetchCache(): void;
export declare function createWebFetchTool(): Promise<MetaAgentTool>;
//# sourceMappingURL=index.d.ts.map