/**
 * @meta-agent/cc-kernel — public API surface
 *
 * The library is intentionally thin: consumers get KernelSession as their
 * primary entry point, plus all the types they need to configure it and
 * consume its events.
 */
// ── Primary entry point ───────────────────────────────────────────────────────
export { KernelSession } from './KernelSession.js';
export { makeUserMessage, makeAssistantMessage, makeTextUserMessage, makeToolResultMessage, makeInterruptionMessage, makeSystemMessage, } from './messages/MessageFactory.js';
export { emptyUsage, addUsage } from './types/TokenUsage.js';
export { calcCostUsd } from './utils/CostTracker.js';
// ── File state cache ─────────────────────────────────────────────────────────
export { FileStateCache, cloneFileStateCache, createFileStateCacheWithSizeLimit } from './session/FileStateCache.js';
// ── Compact utilities ─────────────────────────────────────────────────────────
export { compactConversation } from './compact/CompactConversation.js';
export { buildCompactPrompt, formatCompactSummary } from './compact/CompactPrompt.js';
// ── Context window utils ─────────────────────────────────────────────────────
export { getContextWindowSize, calculateTokenWarningState } from './utils/Context.js';
// ── Permission helpers ────────────────────────────────────────────────────────
export { defaultCanUseTool } from './permissions/CanUseTool.js';
export { createPermissionPolicy } from './permissions/PermissionPolicy.js';
//# sourceMappingURL=index.js.map