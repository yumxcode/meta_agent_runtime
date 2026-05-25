/**
 * modes/ — KernelSession-backed session implementations.
 *
 * Drop-in replacements for MetaAgentSession / KernelBridge that use the
 * new cc-kernel TypeScript rewrite instead of the compiled CC source.
 */
export { DirectSession } from './DirectSession.js';
export { AgenticSession } from './AgenticSession.js';
export { CampaignSession } from './CampaignSession.js';
export { toKernelTool, toKernelTools } from './toolAdapter.js';
export { translateKernelEvent } from './eventAdapter.js';
//# sourceMappingURL=index.d.ts.map