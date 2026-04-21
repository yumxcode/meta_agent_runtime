/**
 * @hermes/runtime — Public API
 *
 * Main entry point for the Hermes Agent Runtime TypeScript package.
 *
 * @example
 * ```ts
 * import { AgentRuntime } from '@hermes/runtime';
 *
 * const agent = new AgentRuntime({
 *   provider: {
 *     type: 'anthropic',
 *     apiKey: process.env.ANTHROPIC_API_KEY!,
 *     model: 'claude-sonnet-4-6',
 *   },
 *   callbacks: {
 *     onStreamDelta: (text) => process.stdout.write(text),
 *     onToolStart: (name) => console.log(`→ ${name}`),
 *   },
 * });
 *
 * const result = await agent.run('Write a hello world Python script');
 * console.log(result.response);
 * ```
 */

// ---------------------------------------------------------------------------
// Core runtime
// ---------------------------------------------------------------------------
export { AgentRuntime, ChatSession } from './agent.js';

// ---------------------------------------------------------------------------
// Delegation system
// ---------------------------------------------------------------------------
export { SharedBudget } from './delegation/budget.js';
export type {
  DelegateTaskInput,
  DelegateResult as DelegationResult,
  DelegationContext,
  DelegationBubbleCallbacks,
  ChildAgentInitOptions,
} from './delegation/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type {
  // Core types
  AgentConfig,
  AgentCallbacks,
  AgentStep,
  ConversationResult,
  // Message types
  Message,
  MessageRole,
  ContentBlock,
  TextBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  // Tool types
  ToolDefinition,
  ToolHandler,
  ToolContext,
  ToolEntry,
  Toolset,
  // LLM types
  LLMResponse,
  ParsedToolCall,
  ToolCall,
  JSONSchema,
  // Provider types
  ProviderConfig,
  ProviderType,
  FallbackConfig,
  // Memory
  MemoryEntry,
  // Helpers
  CompressionSummary,
  // Delegation public types
  DelegateResult,
  DelegationConfig,
  // Phase 3 — new types
  StopHook,
  ToolUsageSummary,
  PermissionLevel,
  PermissionRule,
  PermissionConfig,
  ToolFilterContext,
  // 缺口修复 — 停滞检测 + 外部验收条件
  CompletionGuard,
  // 缺口修复 — 结构化 Observation + 记忆风险
  Observation,
  StalenessRisk,
} from './types.js';

// Helper functions
export {
  extractText,
  userMessage,
  assistantMessage,
  systemMessage,
  // Observation helpers
  okObservation,
  errorObservation,
  parseObservation,
} from './types.js';

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------
export {
  createAdapter,
  AnthropicAdapter,
  OpenAIAdapter,
  GeminiAdapter,
  GLMAdapter,
  roughTokenCount,
  getContextWindow,
  MODEL_CONTEXT_WINDOWS,
} from './adapters/index.js';
export type { LLMAdapter, LLMCallOptions } from './adapters/index.js';

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
export {
  // Registry
  ToolRegistry,
  registry,
  registerTool,
  registerTools,
  dispatchTool,
  executeToolBatch,
  isParallelSafe,
  // Built-in stores
  MemoryStore,
  getMemoryStore,
  TodoStore,
  getTodoStore,
} from './tools/index.js';
export type { ToolCallRequest, ToolCallResult, Todo, TodoStatus, TodoPriority } from './tools/index.js';

// Phase 3 — Permission system
export { ToolPermissionContext, createPermissionContext } from './tools/permission.js';

// Phase 3 — Memory categories & config
export type { MemoryCategory, MemoryConfig } from './tools/memory-tool.js';

// ---------------------------------------------------------------------------
// Three-layer memory system
// ---------------------------------------------------------------------------
export { buildMemoryIndex }                                  from './memory/index-injector.js';
export type { MemoryIndexOptions }                           from './memory/index-injector.js';

export { TopicStore, getTopicStore, DEFAULT_TOPIC_DIR, COMMON_TOPICS } from './memory/topic-store.js';
export type { TopicMeta, TopicSearchResult }                 from './memory/topic-store.js';

export {
  SessionLogger,
  searchSessionLogs,
  getRecentSessionLogs,
  DEFAULT_SESSION_DIR,
}                                                            from './memory/session-log.js';
export type { SessionLogEntry, SessionSearchResult }         from './memory/session-log.js';

// ---------------------------------------------------------------------------
// Prompt assembly (AGENTS.md + Skills + Spec layers)
// ---------------------------------------------------------------------------
export { scanContent, stripYamlFrontmatter } from './prompt/injection-guard.js';
export type { ScanResult }          from './prompt/injection-guard.js';

export { loadAgentsMd }             from './prompt/agents-md.js';
export type { AgentsMdResult, AgentsMdOptions } from './prompt/agents-md.js';

export { resolveTaskSpec, formatTaskSpec } from './prompt/spec.js';
export type { TaskSpec }            from './prompt/spec.js';

export { loadSkills, formatSkills } from './prompt/skills.js';
export type { Skill, SkillsConfig } from './prompt/skills.js';

export { buildSystemPrompt }        from './prompt/builder.js';
export type { SystemPromptLayers, BuiltPrompt } from './prompt/builder.js';

// ---------------------------------------------------------------------------
// Checkpoint (Gap 8 / Gap 9)
// ---------------------------------------------------------------------------
export {
  CheckpointWriter,
  generateRunId,
  captureToDoSnapshot,
  buildResumePrompt,
} from './checkpoint/index.js';
export type {
  CheckpointData,
  CheckpointSummary,
  TodoSnapshot,
} from './checkpoint/index.js';

// ---------------------------------------------------------------------------
// Verification — executable acceptance criteria (Principle 8)
// ---------------------------------------------------------------------------
export {
  createVerificationGuard,
  fileExists,
  fileContains,
  shellPasses,
} from './verification/index.js';
export type {
  VerificationAssertion,
  VerificationResult,
} from './verification/index.js';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
export { ContextCompressor, isContextLengthError } from './context/index.js';
export type { CompressionConfig } from './context/index.js';

// ---------------------------------------------------------------------------
// Services  (optional — import explicitly when needed; not part of core loop)
// ---------------------------------------------------------------------------
// DreamService is a background memory-consolidation service.
// It is intentionally NOT re-exported from the main entry point:
// library consumers should opt-in explicitly rather than pulling in a
// background service as a side-effect of importing the runtime.
//
//   import { DreamService, getDreamService } from '@hermes/runtime/services/dream';
//

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
export { withRetry, isRetryableError, isFatalError } from './utils/retry.js';
export type { RetryOptions } from './utils/retry.js';
export { Logger, logger } from './utils/logger.js';
export type { LogLevel, LogEntry } from './utils/logger.js';

// ---------------------------------------------------------------------------
// Built-in tool loaders
// (Import these to register the respective toolsets with the global registry)
// ---------------------------------------------------------------------------
export const loadDelegationTool = async () => import('./tools/delegate-tool.js');
export const loadFileTools = async () => import('./tools/file-tools.js');
export const loadWebTools = async () => import('./tools/web-tools.js');
export const loadTerminalTools = async () => import('./tools/terminal-tool.js');
export const loadMemoryTools = async () => import('./tools/memory-tool.js');
export const loadTodoTools = async () => import('./tools/todo-tool.js');

/**
 * Load all built-in tools at once.
 * Call this before creating an AgentRuntime if you want all default tools.
 */
export async function loadAllTools(): Promise<void> {
  await Promise.all([
    import('./tools/file-tools.js'),
    import('./tools/web-tools.js'),
    import('./tools/terminal-tool.js'),
    import('./tools/memory-tool.js'),
    import('./tools/todo-tool.js'),
    import('./tools/delegate-tool.js'),
  ]);
}
