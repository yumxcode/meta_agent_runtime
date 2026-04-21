/**
 * @hermes/runtime — Core Type Definitions
 *
 * All shared interfaces and types used across the runtime.
 */

// ---------------------------------------------------------------------------
// Content blocks (multimodal)
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** Canonical message format used internally across all adapters. */
export interface Message {
  role: MessageRole;
  /** Either a plain string or structured content blocks. */
  content: string | ContentBlock[];
  /** For role=tool: links this result back to a tool_call id. */
  tool_call_id?: string;
  /** For role=assistant with tool calls (OpenAI format). */
  tool_calls?: ToolCall[];
  /** Optional name field (OpenAI function call name). */
  name?: string;
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-stringified arguments. */
    arguments: string;
  };
}

export interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** JSON Schema subset for tool parameters. */
export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JSONSchema;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

// ---------------------------------------------------------------------------
// Tool system
// ---------------------------------------------------------------------------

/** Context passed to every tool handler invocation. */
export interface ToolContext {
  /** The agent that owns this invocation. */
  agentId: string;
  /** The current conversation / session ID. */
  sessionId?: string;
  /** Arbitrary metadata passed from the agent. */
  metadata?: Record<string, unknown>;
  /** Signal for cancellation. */
  signal?: AbortSignal;
}

/**
 * The function signature every tool must implement.
 *
 * Handlers may return either a plain string (wrapped into an okObservation by
 * the registry) or a fully structured Observation (used when the handler wants
 * to attach metadata such as staleness_risk).
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Promise<string | Observation>;

/** Toolset tag for grouping tools. */
export type Toolset =
  | 'file'
  | 'web'
  | 'terminal'
  | 'memory'
  | 'todo'
  | 'vision'
  | 'code'
  | 'custom'
  | string;

export interface ToolEntry {
  name: string;
  toolset: Toolset;
  definition: ToolDefinition;
  handler: ToolHandler;
  /** Return false to skip registration when prerequisites are absent. */
  checkFn?: () => boolean;
  /**
   * Feature Gate: evaluated at getDefinitions() time.
   * Return false to hide this tool from the LLM in the current context.
   * Unlike checkFn (which gates registration), condition gates visibility per-call.
   */
  condition?: (ctx: ToolFilterContext) => boolean;
  /** Whether this tool is safe to run in parallel with others. */
  parallelSafe?: boolean;
  /** Emoji shown in progress display. */
  emoji?: string;
  /** Maximum result size in characters before truncation. */
  maxResultSizeChars?: number;
}

// ---------------------------------------------------------------------------
// LLM response
// ---------------------------------------------------------------------------

export interface LLMResponse {
  /** The text content of the response (if any). */
  text: string;
  /** Parsed tool calls from the response. */
  toolCalls: ParsedToolCall[];
  /** Raw usage statistics. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** Stop reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop' */
  stopReason?: string;
  /** Thinking / reasoning text (extended thinking). */
  thinking?: string;
}

// ---------------------------------------------------------------------------
// Provider / adapter configuration
// ---------------------------------------------------------------------------

export type ProviderType = 'anthropic' | 'openai' | 'gemini' | 'glm';

export interface ProviderConfig {
  type: ProviderType;
  apiKey: string;
  /** Override the default base URL (useful for proxies / self-hosted). */
  baseUrl?: string;
  /** Model string, e.g. "claude-sonnet-4-6" */
  model: string;
  /** Extra provider-specific options. */
  options?: Record<string, unknown>;
}

/** Fallback chain: if the primary provider fails, try these in order. */
export interface FallbackConfig {
  provider: ProviderConfig;
  /** Errors to trigger fallback on; defaults to any error. */
  onErrors?: string[];
}

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export interface AgentCallbacks {
  /** Called for each streaming text delta. */
  onStreamDelta?: (delta: string) => void;
  /** Called when a tool starts executing (current agent). */
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  /** Called when a tool finishes executing (current agent). */
  onToolComplete?: (name: string, result: string, durationMs: number) => void;
  /** Called after each LLM + tool iteration (current agent). */
  onStep?: (step: AgentStep) => void;
  /** Called to display thinking/reasoning content. */
  onThinking?: (thinking: string) => void;
  /** Called for user-facing progress messages. */
  onProgress?: (message: string) => void;

  // ---------------------------------------------------------------------------
  // 委托事件（透明冒泡模式）
  // ---------------------------------------------------------------------------

  /** 子 Agent 被 spawn 时触发。depth 从 1 开始。 */
  onDelegateStart?: (task: string, childId: string, depth: number) => void;

  /** 子 Agent 完成时触发，携带结构化结果。 */
  onDelegateComplete?: (childId: string, result: DelegateResult, depth: number) => void;

  /**
   * 子 Agent 中的工具调用开始时冒泡到此。
   * depth 表示是哪一层子 Agent 触发的（1=直接子 Agent，2=孙 Agent...）。
   */
  onChildToolStart?: (
    name: string,
    args: Record<string, unknown>,
    childId: string,
    depth: number,
  ) => void;

  /** 子 Agent 中的工具调用完成时冒泡到此。 */
  onChildToolComplete?: (
    name: string,
    result: string,
    durationMs: number,
    childId: string,
    depth: number,
  ) => void;

  /** 子 Agent 完成一个 LLM + 工具 iteration 时冒泡到此。 */
  onChildStep?: (step: AgentStep, childId: string, depth: number) => void;
}

// ---------------------------------------------------------------------------
// 子 Agent 委托结果（公共类型，与 delegation/types.ts 中的一致）
// ---------------------------------------------------------------------------

export interface DelegateResult {
  success: boolean;
  summary: string;
  iterations_used: number;
  budget_remaining: number;
  tools_called: string[];
  agent_id: string;
  depth: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// 委托配置（嵌入 AgentConfig）
// ---------------------------------------------------------------------------

export interface DelegationConfig {
  /** 是否启用委托功能。默认 true。 */
  enabled?: boolean;
  /** 最大委托深度（根 Agent = 0）。默认 3。 */
  maxDepth?: number;
  /** 子 Agent 默认最大 iteration 数（从共享预算消耗）。默认 20。 */
  defaultChildIterations?: number;
  /** 子 Agent 是否默认继承父 Agent 的工具集（含 delegation toolset）。默认 true。 */
  inheritToolsets?: boolean;
}

export interface AgentConfig {
  /** Agent identifier (used in logs and sub-agent delegation). */
  id?: string;
  /** Primary LLM provider. */
  provider: ProviderConfig;
  /** Optional fallback providers. */
  fallbacks?: FallbackConfig[];
  /** System prompt. If omitted a default is used. */
  systemPrompt?: string;
  /**
   * Project working directory.  Used by the prompt-assembly pipeline:
   *  - AGENTS.md walk starts here (in addition to process.cwd())
   *  - Skills are looked up in {workDir}/.hermes/skills/
   * Defaults to process.cwd() when not specified.
   */
  workDir?: string;
  /**
   * AGENTS.md loading options.
   * Set to `false` to disable AGENTS.md loading entirely.
   * Set to an object to customise discovery (extra dirs, disable global, etc.)
   * @default true  (auto-loads from standard hierarchy)
   */
  agentsMd?: boolean | import('./prompt/agents-md.js').AgentsMdOptions;
  /**
   * Task acceptance criteria spec.  Injected as the final section of the
   * system prompt so it has the highest recency weight.
   * Can also be the path to a .json / .md spec file.
   */
  spec?: import('./prompt/spec.js').TaskSpec | string;
  /**
   * Skills configuration — reusable operation procedures loaded from
   * ~/.hermes/skills/ and {workDir}/.hermes/skills/.
   */
  skills?: import('./prompt/skills.js').SkillsConfig;
  /** Maximum tool-call iterations before stopping. */
  maxIterations?: number;
  /** Which toolsets to enable. Defaults to ['file', 'web', 'terminal', 'memory', 'todo']. */
  enabledToolsets?: Toolset[];
  /** Toolsets to explicitly disable (overrides enabledToolsets). */
  disabledToolsets?: Toolset[];
  /** Path to the memory file (MEMORY.md). Defaults to ~/.hermes/MEMORY.md */
  memoryPath?: string;
  /** Path to the session directory for history persistence and session logs. */
  sessionDir?: string;
  /**
   * Layer 2: Directory for per-topic memory files.
   * Defaults to ~/.hermes/topics
   */
  topicDir?: string;
  /**
   * Layer 1: Whether to auto-inject the memory index at the start of each
   * run() call. Enabled by default; set false to disable for child agents or
   * latency-sensitive use cases.
   */
  memoryIndexEnabled?: boolean;
  /**
   * Layer 3: Whether to persist AgentSteps to session JSONL logs.
   * Enabled by default when sessionDir is set. Set false to disable.
   */
  sessionLogEnabled?: boolean;
  /** Context window fraction at which compression is triggered (0–1). Default 0.5 */
  compressionThreshold?: number;
  /** Max concurrent parallel tool executions. Default 4. */
  maxParallelTools?: number;
  /** Sub-agent delegation configuration. */
  delegation?: DelegationConfig;
  /** Pluggable stop conditions evaluated after each step. */
  stopHooks?: StopHook[];
  /** Tool permission configuration. */
  permissionConfig?: PermissionConfig;
  /**
   * Circuit breaker: stop the run after this many consecutive steps where
   * every tool call in the step failed (error: true). Default: 3.
   * Set to 0 to disable.
   */
  maxConsecutiveToolErrors?: number;
  /**
   * Stagnation detection: maximum number of consecutive steps with identical
   * tool calls before intervention.
   *   • At (N-1) repeats: a warning hint is injected into history.
   *   • At N repeats: the run is stopped.
   * Default: 3. Set to 0 to disable.
   */
  maxStagnationSteps?: number;
  /**
   * External acceptance criteria evaluated when the LLM proposes to end
   * (produces no tool calls). If any guard is unsatisfied, its feedback is
   * injected as a user message and the loop continues.
   * Guards are skipped once the loop has fewer than 2 budget iterations left
   * to avoid infinite continuation.
   */
  completionGuards?: CompletionGuard[];
  /**
   * Dynamic tool-narrowing hook — called before every LLM invocation.
   *
   * Receives the current iteration number, the full conversation history, and
   * the complete set of available tool definitions.  Returns the subset that
   * the LLM should see for this step.  Return the input array unchanged to use
   * the full tool pool.
   *
   * Rationale (Principle 4): keeping the visible tool pool small (< 10,
   * non-overlapping) measurably improves call quality.  This hook is the
   * primary mechanism for achieving that — it lets callers phase-in tools,
   * restrict capabilities by task type, or gate tools on prior tool results.
   *
   * @example Phase-based filtering
   * ```ts
   * stepFilter: (step, _history, tools) =>
   *   step < 3
   *     ? tools.filter(t => ['web_search', 'read_file'].includes(t.name))
   *     : tools,
   * ```
   */
  stepFilter?: (
    step:    number,
    history: Message[],
    tools:   ToolDefinition[],
  ) => ToolDefinition[];
  /** Event / progress callbacks. */
  callbacks?: AgentCallbacks;
}

// ---------------------------------------------------------------------------
// Agent step / conversation
// ---------------------------------------------------------------------------

export interface AgentStep {
  iteration: number;
  /** LLM response text before tool calls. */
  assistantText: string;
  /** Tool calls dispatched in this step. */
  toolCalls: ParsedToolCall[];
  /** Results of each tool call. */
  toolResults: Array<{ id: string; name: string; result: string; error?: boolean }>;
  /** Token usage for this step. */
  usage?: LLMResponse['usage'];
}

export interface ConversationResult {
  /** Final text response from the agent. */
  response: string;
  /** All steps taken. */
  steps: AgentStep[];
  /** Total iterations consumed. */
  iterations: number;
  /** Whether the run was interrupted. */
  interrupted: boolean;
  /** Aggregate usage across all steps. */
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Per-tool usage statistics for this run. */
  toolUsageSummary: ToolUsageSummary[];
  /**
   * Unique run identifier. Always present; use with AgentRuntime.resume(runId)
   * to continue an interrupted run.
   */
  runId: string;
  /**
   * Absolute path of the checkpoint file (only set when sessionDir is configured
   * and checkpointing is enabled).
   */
  checkpointPath?: string;
}

// ---------------------------------------------------------------------------
// Context compression
// ---------------------------------------------------------------------------

export interface CompressionSummary {
  resolvedTasks: string;
  pendingWork: string;
  keyFindings: string;
  activeTask: string;
}

// ---------------------------------------------------------------------------
// Stop hooks
// ---------------------------------------------------------------------------

/**
 * Pluggable termination condition evaluated after each agent step.
 * Return true (or resolve to true) to halt the run early.
 */
export type StopHook = (step: AgentStep, history: Message[]) => boolean | Promise<boolean>;

/**
 * External acceptance criterion evaluated when the LLM proposes to end
 * (i.e. produces no tool calls). If any guard is not satisfied, the agent
 * injects the feedback as a user message and continues the loop.
 *
 * Return values:
 *   • true / { satisfied: true }          → criterion met, allow completion
 *   • false / { satisfied: false }        → not met, continue (generic feedback injected)
 *   • { satisfied: false, feedback: '…' } → not met, inject specific feedback
 */
export type CompletionGuard = (
  proposedResponse: string,
  steps: AgentStep[],
  history: Message[],
) =>
  | boolean
  | { satisfied: boolean; feedback?: string }
  | Promise<boolean>
  | Promise<{ satisfied: boolean; feedback?: string }>;

// ---------------------------------------------------------------------------
// Tool usage summary
// ---------------------------------------------------------------------------

export interface ToolUsageSummary {
  /** Tool name. */
  tool: string;
  /** Total number of invocations in this run. */
  callCount: number;
  /** Cumulative wall-clock time in milliseconds. */
  totalDurationMs: number;
  /** Number of invocations that returned an error. */
  errorCount: number;
  /** The last result string (may be truncated). */
  lastResult?: string;
}

// ---------------------------------------------------------------------------
// Permission system
// ---------------------------------------------------------------------------

export type PermissionLevel = 'always_allow' | 'always_deny' | 'ask' | 'auto';

export interface PermissionRule {
  /** Tool name glob pattern (exact match or '*' wildcard). */
  tool: string;
  level: PermissionLevel;
}

export interface PermissionConfig {
  /** Default permission level for tools not matched by any rule. */
  defaultLevel?: PermissionLevel;
  /** Ordered rule list — first match wins. */
  rules?: PermissionRule[];
  /**
   * Called when level='ask' to obtain a runtime decision.
   * Must return 'allow' | 'deny'.
   */
  onAsk?: (toolName: string, args: Record<string, unknown>) => Promise<'allow' | 'deny'>;
}

// ---------------------------------------------------------------------------
// Tool filter context (Feature Gates)
// ---------------------------------------------------------------------------

export interface ToolFilterContext {
  /** Current agent depth (0 = root). */
  agentDepth?: number;
  /** Resolved permission context (from permission.ts). */
  permissions?: PermissionConfig;
  /** Arbitrary metadata for condition evaluation. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  key: string;
  value: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Extract plain text from a Message's content field. */
export function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Build a simple user Message. */
export function userMessage(text: string): Message {
  return { role: 'user', content: text };
}

/** Build a simple assistant Message. */
export function assistantMessage(text: string): Message {
  return { role: 'assistant', content: text };
}

/** Build a system Message. */
export function systemMessage(text: string): Message {
  return { role: 'system', content: text };
}

// ---------------------------------------------------------------------------
// Structured Observation — unified tool result envelope
// ---------------------------------------------------------------------------

/**
 * Every tool result is serialised as an Observation JSON string so the LLM
 * always has an unambiguous success/failure signal rather than raw text it
 * must semantically interpret.
 *
 * Wire format (the string stored in Message.content / ToolCallResult.result):
 *   {"status":"ok","content":"..."}
 *   {"status":"error","error_type":"execution_error","content":"..."}
 */
export interface Observation {
  /** Whether the tool executed successfully. */
  status: 'ok' | 'error';
  /** Primary output (success) or error message (failure). */
  content: string;
  /**
   * Machine-readable error classification — only present when status='error'.
   *   validation_error  — args failed JSON-Schema validation before dispatch
   *   execution_error   — handler threw at runtime
   *   permission_denied — blocked by the permission policy
   */
  error_type?: 'validation_error' | 'execution_error' | 'permission_denied';
  /** Optional structured metadata (e.g. truncation info). */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Staleness risk (used by the memory tool)
// ---------------------------------------------------------------------------

/**
 * Risk assessment attached to memory reads when an entry might be stale.
 * Carried in `Observation.metadata.staleness_risk`.
 */
export interface StalenessRisk {
  /** Severity of the staleness concern. */
  level: 'low' | 'medium' | 'high';
  /** Human-readable reason (pattern that triggered the flag). */
  reason: string;
  /** Age of the entry in hours at time of read (-1 = unknown). */
  age_hours: number;
  /** Hint injected for the LLM. */
  hint: string;
}

/** Serialise a successful tool result. */
export function okObservation(content: string, metadata?: Record<string, unknown>): string {
  const obs: Observation = { status: 'ok', content };
  if (metadata && Object.keys(metadata).length > 0) obs.metadata = metadata;
  return JSON.stringify(obs);
}

/** Serialise a failed tool result. */
export function errorObservation(
  content: string,
  error_type: NonNullable<Observation['error_type']> = 'execution_error',
): string {
  const obs: Observation = { status: 'error', error_type, content };
  return JSON.stringify(obs);
}

/**
 * Try to parse a string as an Observation.
 * Returns null if the string is not a valid Observation JSON (e.g. legacy bare string).
 */
export function parseObservation(s: string): Observation | null {
  try {
    const obj = JSON.parse(s) as Record<string, unknown>;
    if (
      typeof obj === 'object' &&
      obj !== null &&
      (obj['status'] === 'ok' || obj['status'] === 'error') &&
      typeof obj['content'] === 'string'
    ) {
      return obj as unknown as Observation;
    }
  } catch { /* not JSON */ }
  return null;
}
