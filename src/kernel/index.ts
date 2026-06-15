/**
 * @meta-agent/cc-kernel — public API surface
 *
 * The library is intentionally thin: consumers get KernelSession as their
 * primary entry point, plus all the types they need to configure it and
 * consume its events.
 */

// ── Primary entry point ───────────────────────────────────────────────────────
export { KernelSession } from './KernelSession.js'
export type { ManualCompactResult } from './KernelSession.js'

// ── Configuration types ───────────────────────────────────────────────────────
export type {
  KernelConfig,
  CompactConfig,
  ThinkingConfig,
  CanUseToolFn,
  CanUseToolResult,
} from './types/KernelConfig.js'

// ── Event types ───────────────────────────────────────────────────────────────
export type {
  KernelEvent,
  TextDeltaEvent,
  ToolUseEvent,
  ToolResultEvent,
  CompactBoundaryEvent,
  ApiRetryEvent,
  ToolUseSummaryEvent,
  SystemMessageEvent,
  ResultEvent,
  ResultSubtype,
  PermissionDenial,
} from './types/KernelEvent.js'

// ── Tool interface ────────────────────────────────────────────────────────────
export type {
  KernelTool,
  KernelToolContext,
  KernelToolResult,
  ToolInputJSONSchema,
  ZodCompatSchema,
  ToolPermissionContext,
} from './types/KernelTool.js'

// ── Message types ─────────────────────────────────────────────────────────────
export type {
  KernelMessage,
  ContentBlock,
  MessageRole,
} from './types/KernelMessage.js'

export {
  makeUserMessage,
  makeAssistantMessage,
  makeTextUserMessage,
  makeToolResultMessage,
  makeInterruptionMessage,
  makeSystemMessage,
} from './messages/MessageFactory.js'

// ── Token usage / cost ────────────────────────────────────────────────────────
export type { TokenUsage } from './types/TokenUsage.js'
export { emptyUsage, addUsage } from './types/TokenUsage.js'
export { calcCostUsd } from './utils/CostTracker.js'

// ── File state cache ─────────────────────────────────────────────────────────
export { FileStateCache, cloneFileStateCache, createFileStateCacheWithSizeLimit } from './session/FileStateCache.js'

// ── Compact utilities ─────────────────────────────────────────────────────────
export { compactConversation } from './compact/CompactConversation.js'
export { buildCompactPrompt, formatCompactSummary } from './compact/CompactPrompt.js'

// ── Context window utils ─────────────────────────────────────────────────────
export { getContextWindowSize, calculateTokenWarningState } from './utils/Context.js'

// ── Permission helpers ────────────────────────────────────────────────────────
export { defaultCanUseTool } from './permissions/CanUseTool.js'
export { createPermissionPolicy } from './permissions/PermissionPolicy.js'
export type {
  PermissionConfig,
  PermissionPolicyOptions,
  ToolPermissionOverride,
} from './permissions/PermissionPolicy.js'
