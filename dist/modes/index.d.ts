/**
 * modes/ — KernelSession-backed session implementations.
 *
 * Drop-in replacements for MetaAgentSession / KernelBridge that use the
 * new cc-kernel TypeScript rewrite instead of the compiled CC source.
 *
 * Note: `DirectSession` was removed in v0.2.x — the SessionRouter never
 * routed to it and `SessionMode` no longer includes 'direct'. Use
 * AgenticSession (or SessionRouter with `mode: 'agentic'`) for single-turn
 * conversations and lower `maxTurns` to 1 if needed.
 */
export { AgenticSession } from './AgenticSession.js';
export { CampaignSession } from './CampaignSession.js';
export { toKernelTool, toKernelTools } from './toolAdapter.js';
export { translateKernelEvent } from './eventAdapter.js';
//# sourceMappingURL=index.d.ts.map