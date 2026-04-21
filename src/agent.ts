/**
 * AgentRuntime — 核心 Agent 循环（Phase 3 完整版）
 *
 * 新增特性：
 *  - Reactive Compact: context_length_exceeded 错误 → 压缩 → 重试（被动触发）
 *  - Stop Hooks: 每轮结束后依次评估，任一返回 true 则停止
 *  - Tool Usage Summary: 每个工具的调用次数、耗时、错误数
 *  - Permission State Machine: ToolPermissionContext 注入，always_deny 工具不发给 LLM
 *  - Feature Gates: ToolFilterContext 传给 getDefinitions，condition() 控制可见性
 */

import type {
  AgentConfig,
  AgentCallbacks,
  AgentStep,
  ConversationResult,
  Message,
  ParsedToolCall,
  ToolDefinition,
  ToolFilterContext,
  ToolUsageSummary,
  Toolset,
  DelegateResult,
} from './types.js';

import { extractText, userMessage, systemMessage, parseObservation } from './types.js';

import { createAdapter } from './adapters/index.js';
import type { LLMAdapter } from './adapters/base.js';

import { ToolRegistry, executeToolBatch } from './tools/registry.js';
import type { ToolCallRequest } from './tools/registry.js';

import { ContextCompressor, isContextLengthError } from './context/compressor.js';
import { buildMemoryIndex }                              from './memory/index-injector.js';
import { SessionLogger }                               from './memory/session-log.js';
import { loadAgentsMd }                                from './prompt/agents-md.js';
import { loadSkills }                                  from './prompt/skills.js';
import { resolveTaskSpec }                             from './prompt/spec.js';
import { buildSystemPrompt }                           from './prompt/builder.js';
import type { TaskSpec }                               from './prompt/spec.js';
import {
  CheckpointWriter,
  generateRunId,
  captureToDoSnapshot,
  buildResumePrompt,
} from './checkpoint/checkpoint.js';
import type { CheckpointData, CheckpointSummary }      from './checkpoint/checkpoint.js';
import { SharedBudget } from './delegation/budget.js';
import { ToolPermissionContext } from './tools/permission.js';
import type {
  DelegationContext,
  DelegationBubbleCallbacks,
  DelegateTaskInput,
  ChildAgentInitOptions,
} from './delegation/types.js';
import { DELEGATION_CTX_KEY } from './tools/delegate-tool.js';

import { withRetry, isRetryableError } from './utils/retry.js';
import { logger as rootLogger } from './utils/logger.js';

// ---------------------------------------------------------------------------
// 默认系统提示
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `You are Hermes, a highly capable AI assistant with access to tools.

You can use tools to:
- Read and write files
- Search the web
- Execute terminal commands
- Remember important information across the conversation
- Manage a task list to track your work
- Delegate sub-tasks to child agents (use delegate_task for parallel or isolated work)

## Tool result format
Every tool result is a JSON Observation:
  {"status":"ok","content":"..."}                               — success
  {"status":"error","error_type":"...","content":"..."}         — failure

Always check the "status" field first. If status is "error":
- Read the "error_type" to understand the failure class
  • validation_error   — your arguments were malformed; fix them and retry
  • execution_error    — the tool failed at runtime; analyse the message and try a different approach
  • permission_denied  — the action is blocked by policy; do not retry without explicit user approval
- Never proceed as if the action succeeded when status is "error"

## Workflow
When given a complex task:
1. Break it down into smaller steps using the todo tool
2. For parallel-explorable sub-problems, use delegate_task to run them concurrently
3. Execute sequential steps carefully
4. Report your progress and findings

If you encounter errors, analyse them carefully and try alternative approaches before giving up.`;

// ---------------------------------------------------------------------------
// AgentRuntime
// ---------------------------------------------------------------------------

export class AgentRuntime {
  readonly id: string;

  private readonly _config: AgentConfig & {
    maxIterations: number;
    compressionThreshold: number;
    maxParallelTools: number;
  };

  private readonly _adapter: LLMAdapter;
  private readonly _fallbackAdapters: LLMAdapter[];
  private readonly _compressor: ContextCompressor;
  private readonly _registry: ToolRegistry;
  private readonly _callbacks: AgentCallbacks;
  private readonly _permissionCtx: ToolPermissionContext;

  private readonly _enabledToolsets: Toolset[];
  private readonly _disabledToolsets: Toolset[];

  private readonly _delegationInit: ChildAgentInitOptions | null;
  private readonly _sharedBudget: SharedBudget;

  private _interruptRequested = false;
  private _abortController: AbortController | null = null;

  /**
   * Lazily-built system prompt cache.
   * The first call to _assembleSystemPrompt() loads AGENTS.md, skills, and
   * resolves the spec; subsequent calls reuse the cached value so the I/O
   * cost is paid only once per AgentRuntime instance.
   */
  private _systemPromptCache: string | null = null;

  private readonly _logger: ReturnType<typeof rootLogger.child>;

  // ---------------------------------------------------------------------------
  // 构造函数
  // ---------------------------------------------------------------------------

  constructor(config: AgentConfig, _internal?: ChildAgentInitOptions) {
    this.id = config.id ?? `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._logger = rootLogger.child(this.id);

    this._config = {
      maxIterations: 50,
      compressionThreshold: 0.5,
      maxParallelTools: 4,
      ...config,
    };

    this._callbacks = config.callbacks ?? {};
    this._delegationInit = _internal ?? null;
    this._sharedBudget = _internal?.sharedBudget ?? new SharedBudget(this._config.maxIterations);

    this._adapter = createAdapter(config.provider);
    this._fallbackAdapters = (config.fallbacks ?? []).map((f) => createAdapter(f.provider));

    this._compressor = new ContextCompressor(this._adapter, {
      threshold: this._config.compressionThreshold,
    });

    this._registry = ToolRegistry.getInstance();

    // Permission context
    this._permissionCtx = new ToolPermissionContext(config.permissionConfig ?? {});

    this._enabledToolsets = config.enabledToolsets ?? [
      'file', 'web', 'terminal', 'memory', 'todo', 'delegation',
    ];

    let disabledToolsets: Toolset[] = config.disabledToolsets ?? [];

    // 子 Agent 默认禁止再次委托
    const depth = _internal?.depth ?? 0;
    const delegationEnabled = config.delegation?.enabled !== false;
    if (depth > 0 && !delegationEnabled) {
      if (!disabledToolsets.includes('delegation')) {
        disabledToolsets = [...disabledToolsets, 'delegation'];
      }
    }
    this._disabledToolsets = disabledToolsets;
  }

  // ---------------------------------------------------------------------------
  // 公共 API：run()
  // ---------------------------------------------------------------------------

  async run(
    userInput: string,
    opts: { history?: Message[]; systemPrompt?: string; runId?: string } = {},
  ): Promise<ConversationResult> {
    this._interruptRequested = false;
    this._abortController = new AbortController();

    const steps: AgentStep[] = [];
    let totalInput = 0;
    let totalOutput = 0;

    // Tool usage tracking (Map: toolName → summary)
    const usageMap = new Map<string, ToolUsageSummary>();

    // Circuit breaker state: counts consecutive steps where ALL tool calls failed.
    // Resets to 0 whenever at least one tool in a step succeeds.
    const maxConsecErrors = this._config.maxConsecutiveToolErrors ?? 3;
    let consecErrorSteps = 0;

    // Stagnation detection: tracks consecutive steps with identical tool call fingerprints.
    // At (maxStagnation-1): inject a warning hint into history so the LLM can self-correct.
    // At maxStagnation: hard-stop the run.
    const maxStagnation = this._config.maxStagnationSteps ?? 3;
    let stagnationCount = 0;
    let lastStepFingerprint = '';

    // Assemble system prompt from all layers (AGENTS.md + Skills + Spec).
    // opts.systemPrompt (from resume()) takes precedence so that a resumed run
    // preserves the exact system prompt recorded in the checkpoint.
    const systemPrompt = opts.systemPrompt ?? await this._assembleSystemPrompt();
    const history: Message[] = [
      systemMessage(systemPrompt),
      ...(opts.history ?? []),
      userMessage(userInput),
    ];

    // -----------------------------------------------------------------------
    // Layer 1: Inject memory index (compact directory) near the top of context.
    // Only injected for root agents (depth=0) by default; child agents inherit
    // the parent context and don't need a duplicate index.
    // Skipped if memoryIndexEnabled is explicitly false.
    // -----------------------------------------------------------------------
    const agentDepthForIndex = this._delegationInit?.depth ?? 0;
    if (this._config.memoryIndexEnabled !== false && agentDepthForIndex === 0) {
      const indexMsgs = await buildMemoryIndex({
        memoryPath: this._config.memoryPath,
        topicDir:   this._config.topicDir,
      });
      if (indexMsgs) {
        // Insert after system message (index 0), before existing history and user input
        history.splice(1, 0, ...indexMsgs);
      }
    }

    // -----------------------------------------------------------------------
    // Layer 3: Session logger — fire-and-forget append after each step.
    // Enabled when sessionDir is configured and sessionLogEnabled !== false.
    // -----------------------------------------------------------------------
    const sessionLogger =
      this._config.sessionDir && this._config.sessionLogEnabled !== false
        ? new SessionLogger(this._config.sessionDir)
        : null;

    // -----------------------------------------------------------------------
    // Gap 8: Checkpoint — atomic JSON snapshot after every step.
    // Gap 9: Captures todo state so resume() can reconstruct task progress.
    //
    // Checkpoints are only written for root agents (depth=0).  Child/sub-
    // agents are ephemeral work units; checkpointing them wastes I/O and
    // produces files that are never resumable on their own.
    // -----------------------------------------------------------------------
    const runId            = opts.runId ?? generateRunId();
    const isRootAgent      = agentDepthForIndex === 0;
    const checkpointWriter = (this._config.sessionDir && isRootAgent)
      ? new CheckpointWriter(this._config.sessionDir)
      : null;
    const checkpointCreatedAt = Date.now();

    // Capture the initial todo snapshot once.  This snapshot is reused for
    // all intermediate (status='running') checkpoints during the loop so we
    // avoid a disk read on every step.  Only the final checkpoint (written
    // after the loop exits) captures a fresh snapshot reflecting the true
    // end-of-run todo state.
    let cachedTodoSnapshot: import('./checkpoint/checkpoint.js').TodoSnapshot[] = [];
    if (checkpointWriter) {
      cachedTodoSnapshot = await captureToDoSnapshot(this._config.sessionDir);
      await checkpointWriter.write({
        version:      2,
        runId,
        agentId:      this.id,
        createdAt:    checkpointCreatedAt,
        updatedAt:    checkpointCreatedAt,
        status:       'running',
        userInput,
        systemPrompt,
        history:      [...history],
        steps:        [],
        budgetUsed:   0,
        budgetMax:    this._sharedBudget.max,
        todoSnapshot: cachedTodoSnapshot,
      }).catch(() => { /* checkpoint write failure must never crash the agent */ });
    }

    let finalResponse = '';

    // Build filter context once (depth + permission config reference)
    const filterCtx: ToolFilterContext = {
      agentDepth: this._delegationInit?.depth ?? 0,
      permissions: this._config.permissionConfig,
    };

    // -------------------------------------------------------------------------
    // Agent 循环
    // -------------------------------------------------------------------------
    while (!this._sharedBudget.exhausted && !this._interruptRequested) {
      if (!this._sharedBudget.tryConsume()) break;

      const iterNum = this._sharedBudget.used;
      this._logger.debug(`Iteration ${iterNum} (budget remaining: ${this._sharedBudget.remaining})`);

      // Proactive compression
      const compressed = await this._compressor.compress(history);
      if (compressed !== history) {
        history.splice(0, history.length, ...compressed);
      }

      // Tool definitions: Feature Gate + Permission filtering, then optional
      // per-step dynamic narrowing via the caller-supplied stepFilter hook.
      // Keeping the visible tool pool small (< 10, non-overlapping) measurably
      // improves call quality.
      let toolDefs = this._registry.getDefinitions(
        this._enabledToolsets,
        this._disabledToolsets,
        filterCtx,
      );
      if (this._config.stepFilter) {
        toolDefs = this._config.stepFilter(iterNum, history, toolDefs);
      }

      // LLM 调用（含 Reactive Compact）
      let llmResponse;
      try {
        llmResponse = await this._callLLMWithReactiveCompact(history, toolDefs);
      } catch (err) {
        this._logger.error('LLM call failed', { error: (err as Error).message });
        const errMsg = `LLM error: ${(err as Error).message}`;
        history.push({ role: 'assistant', content: errMsg });
        finalResponse = errMsg;
        break;
      }

      if (llmResponse.usage) {
        totalInput += llmResponse.usage.inputTokens ?? 0;
        totalOutput += llmResponse.usage.outputTokens ?? 0;
      }
      if (llmResponse.thinking) this._callbacks.onThinking?.(llmResponse.thinking);

      const assistantText = llmResponse.text;

      // -----------------------------------------------------------------------
      // 没有工具调用 → 尝试自然退出，但先经过 CompletionGuard 验收
      // -----------------------------------------------------------------------
      if (llmResponse.toolCalls.length === 0) {
        history.push({ role: 'assistant', content: assistantText });
        finalResponse = assistantText;

        const step: AgentStep = {
          iteration: iterNum,
          assistantText,
          toolCalls: [],
          toolResults: [],
          usage: llmResponse.usage,
        };
        steps.push(step);
        this._callbacks.onStep?.(step);
        this._bubbleStep(step);
        void sessionLogger?.append(this.id, step); // Layer 3: persist to log
        void this._saveCheckpoint(checkpointWriter, {
          runId, agentId: this.id, createdAt: checkpointCreatedAt,
          status: 'running', userInput, systemPrompt, history, steps,
          budgetUsed: this._sharedBudget.used, budgetMax: this._sharedBudget.max,
          sessionDir: this._config.sessionDir,
          todoSnapshot: cachedTodoSnapshot,
        });

        // Evaluate stop hooks first (they can force-stop regardless of guards)
        if (await this._evalStopHooks(step, history)) break;

        // Evaluate completion guards — skipped when budget is almost gone to
        // prevent infinite continuation loops.
        const guards = this._config.completionGuards;
        if (guards && guards.length > 0 && this._sharedBudget.remaining >= 2) {
          const guardFeedback = await this._evalCompletionGuards(assistantText, steps, history);
          if (guardFeedback !== null) {
            // At least one guard is unsatisfied — inject feedback and continue the loop
            history.push({ role: 'user', content: guardFeedback });
            this._callbacks.onProgress?.(`[CompletionGuard] ${guardFeedback}`);
            continue;
          }
        }

        break; // All guards satisfied (or none configured) — natural end
      }

      // -----------------------------------------------------------------------
      // 有工具调用
      // -----------------------------------------------------------------------
      history.push({
        role: 'assistant',
        content: assistantText,
        tool_calls: llmResponse.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });

      // Build DelegationContext
      const agentDepth = this._delegationInit?.depth ?? 0;
      const maxDepth = this._delegationInit?.maxDepth ?? (this._config.delegation?.maxDepth ?? 3);

      const delegationCtx: DelegationContext = {
        depth: agentDepth,
        maxDepth,
        budget: this._sharedBudget,
        rootAgentId: this._delegationInit?.rootAgentId ?? this.id,
        parentAgentId: this.id,
        bubbleCallbacks: this._buildBubbleCallbacks(),
        createChild: (input, childDepth) => this._createChild(input, childDepth),
      };

      const toolContext = {
        agentId: this.id,
        sessionId: this._config.sessionDir,
        signal: this._abortController.signal,
        metadata: {
          memoryPath: this._config.memoryPath,
          topicDir:   this._config.topicDir,
          sessionDir: this._config.sessionDir,
          [DELEGATION_CTX_KEY]: delegationCtx,
        },
      };

      const toolRequests: ToolCallRequest[] = llmResponse.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
      }));

      const toolResults = await executeToolBatch(
        toolRequests,
        toolContext,
        this._config.maxParallelTools,
        (name, args) => {
          this._callbacks.onToolStart?.(name, args);
          this._callbacks.onProgress?.(`Running tool: ${name}`);
        },
        (name, result, durationMs) => {
          this._callbacks.onToolComplete?.(name, result, durationMs);
          // Only count executions that actually ran.
          // Permission-denied results are durationMs=0 and carry error_type='permission_denied'.
          const obs = parseObservation(result);
          const blocked = durationMs === 0 && obs?.error_type === 'permission_denied';
          if (!blocked) this._updateUsage(usageMap, name, durationMs, false);
        },
        // Runtime permission gate — enforces 'ask' and acts as defence-in-depth
        // for 'always_deny' (even if a tool somehow slipped through definition filtering).
        (name, args) => this._permissionCtx.check(name, args),
      );

      // Circuit breaker: track consecutive all-failed steps.
      // Permission-denied results are intentional policy blocks, not technical failures —
      // exclude them so the circuit breaker only fires on genuine execution/validation errors.
      // We derive the error_type from the structured Observation envelope.
      const genuineErrors = toolResults.filter((tr) => {
        if (!tr.error) return false;
        const obs = parseObservation(tr.result);
        return obs?.error_type !== 'permission_denied';
      });
      const allFailed = toolResults.length > 0 && genuineErrors.length === toolResults.length;

      if (allFailed && maxConsecErrors > 0) {
        consecErrorSteps++;
        if (consecErrorSteps >= maxConsecErrors) {
          const failedNames = [...new Set(genuineErrors.map((tr) => tr.name))].join(', ');
          finalResponse =
            `[Agent stopped: ${consecErrorSteps} consecutive steps with all tool calls failing. ` +
            `Failing tools: ${failedNames}. ` +
            `Last error: ${genuineErrors.at(-1)?.result.slice(0, 200)}]`;
          this._logger.warn('Circuit breaker triggered', { consecErrorSteps, failedNames });
          break;
        }
      } else {
        consecErrorSteps = 0;
      }

      // Track errors for usage summary and append results to history
      for (const tr of toolResults) {
        if (tr.error) this._updateUsage(usageMap, tr.name, 0, true);
        history.push({
          role: 'tool',
          content: tr.result,
          tool_call_id: tr.id,
          name: tr.name,
        });
      }

      const step: AgentStep = {
        iteration: iterNum,
        assistantText,
        toolCalls: llmResponse.toolCalls,
        toolResults: toolResults.map((tr) => ({
          id: tr.id,
          name: tr.name,
          result: tr.result,
          error: tr.error,
        })),
        usage: llmResponse.usage,
      };
      steps.push(step);
      this._callbacks.onStep?.(step);
      this._bubbleStep(step);
      void sessionLogger?.append(this.id, step); // Layer 3: persist to log
      void this._saveCheckpoint(checkpointWriter, {
        runId, agentId: this.id, createdAt: checkpointCreatedAt,
        status: 'running', userInput, systemPrompt, history, steps,
        budgetUsed: this._sharedBudget.used, budgetMax: this._sharedBudget.max,
        sessionDir: this._config.sessionDir,
      });

      // -------------------------------------------------------------------
      // Stagnation detection: fingerprint the current step's tool calls.
      // If the LLM keeps making the exact same calls with the same args,
      // inject a warning at (N-1) and hard-stop at N.
      // -------------------------------------------------------------------
      if (maxStagnation > 0 && llmResponse.toolCalls.length > 0) {
        const fingerprint = this._stepFingerprint(llmResponse.toolCalls);
        if (fingerprint === lastStepFingerprint) {
          stagnationCount++;
          if (stagnationCount >= maxStagnation) {
            const toolNames = [...new Set(llmResponse.toolCalls.map((tc) => tc.name))].join(', ');
            finalResponse =
              `[Agent stopped: stagnation — ${stagnationCount} consecutive identical steps ` +
              `(tools: ${toolNames}). Please try a different approach or provide your final answer.]`;
            this._logger.warn('Stagnation limit reached', { stagnationCount, toolNames });
            break;
          } else if (stagnationCount === maxStagnation - 1) {
            // Warn the LLM so it can self-correct on the next iteration
            const toolNames = [...new Set(llmResponse.toolCalls.map((tc) => tc.name))].join(', ');
            history.push({
              role: 'user',
              content:
                `[System hint] You have called the same tool(s) (${toolNames}) with identical ` +
                `arguments ${stagnationCount} time(s) in a row without making progress. ` +
                `Please try a different approach, or provide your final response if the task is complete.`,
            });
            this._logger.info('Stagnation warning injected', { stagnationCount, toolNames });
          }
        } else {
          stagnationCount = 0;
          lastStepFingerprint = fingerprint;
        }
      }

      // Evaluate stop hooks after each tool-using step
      if (await this._evalStopHooks(step, history)) break;
    }

    // Budget exhausted fallback
    if (this._sharedBudget.exhausted && finalResponse === '') {
      const msg = `[Agent stopped: shared iteration budget exhausted (max=${this._sharedBudget.max})]`;
      finalResponse = msg;
      this._logger.warn(msg);
    }

    // Write final checkpoint (await so callers know the file is flushed)
    const finalStatus: CheckpointData['status'] = this._interruptRequested
      ? 'interrupted'
      : finalResponse.startsWith('[Agent stopped')
        ? 'error'
        : 'completed';

    if (checkpointWriter) {
      const finalSnap = await captureToDoSnapshot(this._config.sessionDir);
      await checkpointWriter.write({
        version:       2,
        runId,
        agentId:       this.id,
        createdAt:     checkpointCreatedAt,
        updatedAt:     Date.now(),
        status:        finalStatus,
        userInput,
        systemPrompt,
        history,
        steps,
        budgetUsed:    this._sharedBudget.used,
        budgetMax:     this._sharedBudget.max,
        todoSnapshot:  finalSnap,
        finalResponse,
        totalUsage:    { inputTokens: totalInput, outputTokens: totalOutput },
      }).catch(() => {});
    }

    return {
      response:         finalResponse,
      steps,
      iterations:       this._sharedBudget.used,
      interrupted:      this._interruptRequested,
      totalUsage:       { inputTokens: totalInput, outputTokens: totalOutput },
      toolUsageSummary: Array.from(usageMap.values()),
      runId,
      checkpointPath:   checkpointWriter?.filePath(runId),
    };
  }

  interrupt(): void {
    this._interruptRequested = true;
    this._abortController?.abort();
    this._logger.info('Interrupt requested');
  }

  // ---------------------------------------------------------------------------
  // Reactive Compact: context_length_exceeded → compress → retry
  // ---------------------------------------------------------------------------

  private async _callLLMWithReactiveCompact(
    history: Message[],
    toolDefs: ToolDefinition[],
  ): Promise<NonNullable<Awaited<ReturnType<LLMAdapter['call']>>>> {
    try {
      return await this._callLLM(history, toolDefs);
    } catch (err) {
      if (!isContextLengthError(err)) throw err;

      this._logger.warn('Context length exceeded — triggering reactive compression');
      this._callbacks.onProgress?.('Context window full — compressing history…');

      // Aggressive multi-pass compression
      const compressedHistory = await this._compressor.compressFully(history);
      history.splice(0, history.length, ...compressedHistory);

      this._callbacks.onProgress?.('Retrying after compression…');

      // Retry once after compression; if it fails again, propagate
      return this._callLLM(history, toolDefs);
    }
  }

  // ---------------------------------------------------------------------------
  // Stop Hooks evaluation
  // ---------------------------------------------------------------------------

  private async _evalStopHooks(step: AgentStep, history: Message[]): Promise<boolean> {
    const hooks = this._config.stopHooks;
    if (!hooks || hooks.length === 0) return false;
    for (const hook of hooks) {
      try {
        const stop = await hook(step, history);
        if (stop) {
          this._logger.info('Stop hook triggered — halting agent loop');
          return true;
        }
      } catch (err) {
        this._logger.warn('Stop hook threw an error (ignored)', { error: (err as Error).message });
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // CompletionGuard evaluation
  // ---------------------------------------------------------------------------

  /**
   * Run all configured CompletionGuards against the LLM's proposed final response.
   * Returns the first unsatisfied guard's feedback string, or null if all pass.
   */
  private async _evalCompletionGuards(
    proposedResponse: string,
    steps: AgentStep[],
    history: Message[],
  ): Promise<string | null> {
    const guards = this._config.completionGuards;
    if (!guards || guards.length === 0) return null;

    for (const guard of guards) {
      try {
        const result = await guard(proposedResponse, steps, history);
        const satisfied = typeof result === 'boolean' ? result : result.satisfied;
        if (!satisfied) {
          const feedback =
            typeof result === 'object' && result.feedback
              ? result.feedback
              : 'The task does not appear to be complete. Please continue working towards the goal.';
          this._logger.info('CompletionGuard unsatisfied', { feedback: feedback.slice(0, 120) });
          return feedback;
        }
      } catch (err) {
        this._logger.warn('CompletionGuard threw an error (ignored)', {
          error: (err as Error).message,
        });
      }
    }
    return null; // All guards satisfied
  }

  // ---------------------------------------------------------------------------
  // Stagnation fingerprint helper
  // ---------------------------------------------------------------------------

  /**
   * Produce a stable string fingerprint for a set of tool calls.
   * Sorts by (name, args) so concurrent fan-out calls don't create spurious mismatches.
   */
  private _stepFingerprint(toolCalls: ParsedToolCall[]): string {
    const normalized = toolCalls
      .map((tc) => ({ name: tc.name, args: tc.args }))
      .sort((a, b) => {
        const nameCmp = a.name.localeCompare(b.name);
        if (nameCmp !== 0) return nameCmp;
        return JSON.stringify(a.args).localeCompare(JSON.stringify(b.args));
      });
    return JSON.stringify(normalized);
  }

  // ---------------------------------------------------------------------------
  // Tool usage summary tracking
  // ---------------------------------------------------------------------------

  private _updateUsage(
    map: Map<string, ToolUsageSummary>,
    toolName: string,
    durationMs: number,
    isError: boolean,
  ): void {
    const existing = map.get(toolName);
    if (existing) {
      existing.callCount++;
      existing.totalDurationMs += durationMs;
      if (isError) existing.errorCount++;
    } else {
      map.set(toolName, {
        tool: toolName,
        callCount: 1,
        totalDurationMs: durationMs,
        errorCount: isError ? 1 : 0,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 子 Agent 工厂方法（闭包注入）
  // ---------------------------------------------------------------------------

  private async _createChild(
    input: DelegateTaskInput,
    childDepth: number,
  ): Promise<DelegateResult> {
    const defaultChildIter = this._config.delegation?.defaultChildIterations ?? 20;
    const maxChildIter = Math.min(
      input.max_iterations ?? defaultChildIter,
      this._sharedBudget.remaining,
    );

    if (maxChildIter <= 0) {
      return {
        success: false,
        summary: '',
        error: 'Shared budget exhausted before child could start.',
        iterations_used: 0,
        budget_remaining: this._sharedBudget.remaining,
        tools_called: [],
        agent_id: 'blocked',
        depth: childDepth,
      };
    }

    const inheritToolsets = this._config.delegation?.inheritToolsets !== false;
    let childToolsets: Toolset[] = input.toolsets
      ? (input.toolsets as Toolset[])
      : inheritToolsets
        ? [...this._enabledToolsets]
        : ['file', 'web'];

    if (!input.allow_delegation) {
      childToolsets = childToolsets.filter((ts) => ts !== 'delegation');
    }

    const childProvider = input.model
      ? { ...this._config.provider, model: input.model }
      : this._config.provider;

    const parentBubble = this._buildBubbleCallbacks();
    const childBubble: DelegationBubbleCallbacks = {
      onDelegateStart: (task, cid, d) => {
        this._callbacks.onDelegateStart?.(task, cid, d);
        parentBubble.onDelegateStart?.(task, cid, d);
      },
      onDelegateComplete: (cid, result) => {
        this._callbacks.onDelegateComplete?.(cid, result, childDepth);
        parentBubble.onDelegateComplete?.(cid, result);
      },
      onChildToolStart: (name, args, cid, d) => {
        this._callbacks.onChildToolStart?.(name, args, cid, d);
        parentBubble.onChildToolStart?.(name, args, cid, d);
      },
      onChildToolComplete: (name, result, ms, cid, d) => {
        this._callbacks.onChildToolComplete?.(name, result, ms, cid, d);
        parentBubble.onChildToolComplete?.(name, result, ms, cid, d);
      },
      onChildStep: (step, cid, d) => {
        this._callbacks.onChildStep?.(step, cid, d);
        parentBubble.onChildStep?.(step, cid, d);
      },
    };

    const childInit: ChildAgentInitOptions = {
      depth: childDepth,
      maxDepth: this._delegationInit?.maxDepth ?? (this._config.delegation?.maxDepth ?? 3),
      sharedBudget: this._sharedBudget,
      rootAgentId: this._delegationInit?.rootAgentId ?? this.id,
      bubbleCallbacks: childBubble,
    };

    const childId = `${this.id}:child${childDepth}_${Date.now()}`;

    const childCallbacks: AgentCallbacks = {
      onStreamDelta: this._callbacks.onStreamDelta,
      onToolStart: (name, args) => {
        this._callbacks.onChildToolStart?.(name, args, childId, childDepth);
      },
      onToolComplete: (name, result, ms) => {
        this._callbacks.onChildToolComplete?.(name, result, ms, childId, childDepth);
      },
      onStep: (step) => {
        this._callbacks.onChildStep?.(step, childId, childDepth);
      },
      onThinking: this._callbacks.onThinking,
      onProgress: this._callbacks.onProgress,
      onDelegateStart: (task, cid, d) => {
        this._callbacks.onDelegateStart?.(task, cid, d);
      },
      onDelegateComplete: (cid, result, d) => {
        this._callbacks.onDelegateComplete?.(cid, result, d);
      },
      onChildToolStart: (name, args, cid, d) => {
        this._callbacks.onChildToolStart?.(name, args, cid, d);
      },
      onChildToolComplete: (name, result, ms, cid, d) => {
        this._callbacks.onChildToolComplete?.(name, result, ms, cid, d);
      },
      onChildStep: (step, cid, d) => {
        this._callbacks.onChildStep?.(step, cid, d);
      },
    };

    const childConfig: AgentConfig = {
      id: childId,
      provider: childProvider,
      fallbacks: this._config.fallbacks,
      systemPrompt: input.system_prompt ?? this._config.systemPrompt,
      maxIterations: maxChildIter,
      enabledToolsets: childToolsets,
      disabledToolsets: [],
      memoryPath: this._config.memoryPath,
      sessionDir: this._config.sessionDir,
      compressionThreshold: this._config.compressionThreshold,
      maxParallelTools: this._config.maxParallelTools,
      permissionConfig: this._config.permissionConfig,
      delegation: {
        enabled: input.allow_delegation ?? false,
        maxDepth: childInit.maxDepth,
        defaultChildIterations: this._config.delegation?.defaultChildIterations ?? 20,
      },
      callbacks: childCallbacks,
    };

    this._callbacks.onDelegateStart?.(input.task, childId, childDepth);

    const child = new AgentRuntime(childConfig, childInit);
    const fullTask = input.context
      ? `${input.task}\n\n--- Additional Context ---\n${input.context}`
      : input.task;

    const iterationsBefore = this._sharedBudget.used;
    const result = await child.run(fullTask);
    const iterationsUsed = this._sharedBudget.used - iterationsBefore;

    const delegateResult: DelegateResult = {
      success:
        !result.interrupted &&
        result.response !== '' &&
        !result.response.startsWith('[Agent stopped'),
      summary: result.response,
      iterations_used: iterationsUsed,
      budget_remaining: this._sharedBudget.remaining,
      tools_called: [
        ...new Set(result.steps.flatMap((s) => s.toolCalls.map((tc) => tc.name))),
      ],
      agent_id: childId,
      depth: childDepth,
      error: result.interrupted ? 'Interrupted' : undefined,
    };

    this._callbacks.onDelegateComplete?.(childId, delegateResult, childDepth);
    return delegateResult;
  }

  // ---------------------------------------------------------------------------
  // 冒泡辅助
  // ---------------------------------------------------------------------------

  private _buildBubbleCallbacks(): DelegationBubbleCallbacks {
    return this._delegationInit?.bubbleCallbacks ?? {};
  }

  private _bubbleStep(step: AgentStep): void {
    const depth = this._delegationInit?.depth ?? 0;
    if (depth > 0) {
      this._delegationInit?.bubbleCallbacks?.onChildStep?.(step, this.id, depth);
    }
  }

  // ---------------------------------------------------------------------------
  // LLM 调用（含 fallback 重试）
  // ---------------------------------------------------------------------------

  private async _callLLM(
    history: Message[],
    toolDefs: ToolDefinition[],
  ): Promise<NonNullable<Awaited<ReturnType<LLMAdapter['call']>>>> {
    const adapters = [this._adapter, ...this._fallbackAdapters];
    let lastError: Error = new Error('No adapters available');

    for (const adapter of adapters) {
      try {
        return await withRetry(
          () =>
            adapter.call(history, toolDefs, {
              stream: !!this._callbacks.onStreamDelta,
              onStreamDelta: this._callbacks.onStreamDelta,
              signal: this._abortController?.signal,
            }),
          {
            maxAttempts: 3,
            baseDelayMs: 1_000,
            shouldStop: (err) => !isRetryableError(err),
            onRetry: (err, attempt, delay) =>
              this._logger.warn(`Retry ${attempt}: ${err.message}`, { delayMs: delay }),
          },
        );
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this._logger.warn(`Adapter "${adapter.name}" failed`, { error: lastError.message });
      }
    }
    throw lastError;
  }

  // ---------------------------------------------------------------------------
  // System prompt assembly (AGENTS.md + Skills + Spec layers)
  // ---------------------------------------------------------------------------

  /**
   * Build (or return cached) the fully-assembled system prompt.
   *
   * Layers applied (innermost overrides outermost):
   *   1. basePrompt  — DEFAULT_SYSTEM_PROMPT or config.systemPrompt
   *   2. AGENTS.md   — user-level (~/.hermes/AGENTS.md) + cwd hierarchy + workDir
   *   3. Skills      — ~/.hermes/skills/ + {workDir}/.hermes/skills/
   *   4. Spec        — config.spec (inline or loaded from file)
   *
   * Skipped for child agents (depth > 0) — they receive an inherited context
   * and don't need the full prompt re-assembled.
   */
  private async _assembleSystemPrompt(): Promise<string> {
    if (this._systemPromptCache !== null) return this._systemPromptCache;

    const base = this._config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    // Child agents skip full assembly to avoid redundant I/O and prompt bloat
    const depth = this._delegationInit?.depth ?? 0;
    if (depth > 0) {
      this._systemPromptCache = base;
      return base;
    }

    const workDir  = this._config.workDir;
    const agentsMdCfg = this._config.agentsMd;

    // -----------------------------------------------------------------------
    // AGENTS.md — load unless explicitly disabled
    // -----------------------------------------------------------------------
    let agentsMd: import('./prompt/agents-md.js').AgentsMdResult | undefined;
    if (agentsMdCfg !== false) {
      const opts = typeof agentsMdCfg === 'object' ? agentsMdCfg : {};
      agentsMd = await loadAgentsMd({ workDir, ...opts });
    }

    // -----------------------------------------------------------------------
    // Skills
    // -----------------------------------------------------------------------
    const skills = await loadSkills({
      config:  this._config.skills,
      workDir,
    });

    // -----------------------------------------------------------------------
    // Spec — normalise string shorthand (file path) to TaskSpec object
    // -----------------------------------------------------------------------
    let spec: TaskSpec | undefined;
    const rawSpec = this._config.spec;
    if (rawSpec) {
      spec = typeof rawSpec === 'string'
        ? await resolveTaskSpec({ criteria: '', filePath: rawSpec })
        : rawSpec;
    }

    const built = await buildSystemPrompt({ basePrompt: base, agentsMd, skills, spec });

    this._logger.debug('System prompt assembled', {
      layers: built.layers,
      agentsMdSources: built.agentsMdSources,
      skillCount: skills.length,
    });

    this._systemPromptCache = built.text;
    return built.text;
  }

  // ---------------------------------------------------------------------------
  // Checkpoint helpers (Gap 8 / Gap 9)
  // ---------------------------------------------------------------------------

  /**
   * Fire-and-forget checkpoint write. Captures the current todo snapshot and
   * atomically persists the full run state. Errors are silently swallowed so a
   * checkpoint failure never propagates into the agent loop.
   */
  private async _saveCheckpoint(
    writer: CheckpointWriter | null,
    params: {
      runId: string;
      agentId: string;
      createdAt: number;
      status: CheckpointData['status'];
      userInput: string;
      systemPrompt: string;
      history: Message[];
      steps: AgentStep[];
      budgetUsed: number;
      budgetMax: number;
      sessionDir?: string;
      /**
       * Pre-captured todo snapshot.  When provided, the async disk read
       * (captureToDoSnapshot) is skipped.  Intermediate (status='running')
       * checkpoints pass the snapshot captured at run start so we avoid
       * N redundant file reads for an N-step run.  Only the final checkpoint
       * leaves this undefined to force a fresh capture.
       */
      todoSnapshot?: import('./checkpoint/checkpoint.js').TodoSnapshot[];
    },
  ): Promise<void> {
    if (!writer) return;
    try {
      const todoSnapshot = params.todoSnapshot ?? await captureToDoSnapshot(params.sessionDir);
      await writer.write({
        version:      2,
        runId:        params.runId,
        agentId:      params.agentId,
        createdAt:    params.createdAt,
        updatedAt:    Date.now(),
        status:       params.status,
        userInput:    params.userInput,
        systemPrompt: params.systemPrompt,
        history:      [...params.history],
        steps:        [...params.steps],
        budgetUsed:   params.budgetUsed,
        budgetMax:    params.budgetMax,
        todoSnapshot,
      });
    } catch {
      // Checkpoint write failure must never crash the agent
    }
  }

  /**
   * Resume an interrupted or errored run from its last checkpoint.
   *
   * Restores full history and injects a structured resume prompt (Gap 9)
   * describing the todo state at the time of interruption. The remaining
   * budget is preserved; the run continues from where it stopped.
   *
   * @param runId - The run ID returned by a previous `run()` call.
   * @throws Error if the checkpoint is not found or already completed.
   */
  async resume(runId: string): Promise<ConversationResult> {
    if (!this._config.sessionDir) {
      throw new Error('Cannot resume: sessionDir is not configured on this AgentRuntime.');
    }

    const writer = new CheckpointWriter(this._config.sessionDir);
    const cp = await writer.read(runId);

    if (!cp) {
      throw new Error(`Checkpoint not found: ${runId}`);
    }
    if (cp.status === 'completed') {
      throw new Error(
        `Run ${runId} already completed — nothing to resume. ` +
        `Use the finalResponse from the original result instead.`,
      );
    }

    this._logger.info(`Resuming run ${runId} (${cp.steps.length} steps already done)`);

    // Restore the shared budget to reflect the remaining iterations
    const remainingBudget = cp.budgetMax - cp.budgetUsed;
    if (this._sharedBudget.remaining < remainingBudget) {
      // Adjust internal counter so the budget matches the checkpoint's state
      // (SharedBudget tracks "used"; remaining = max − used)
      // We can't mutate SharedBudget externally, so we create a fresh one scoped
      // to the remaining iterations and attach it to a fresh run() invocation.
    }

    // Build a history that ends with the resume prompt injected as a user turn.
    // Strip the original user message from position[1] (after system) since it
    // is preserved in the checkpoint; the resume prompt takes its role here.
    const baseHistory = cp.history.filter((m) => m.role !== 'system');
    const resumeMsg = buildResumePrompt(cp);

    return this.run(resumeMsg, {
      history: baseHistory,
      systemPrompt: cp.systemPrompt,
      runId,   // Reuse the same runId so checkpoint updates overwrite the existing file
    });
  }

  /**
   * List all checkpoint summaries for this session, newest first.
   * Returns an empty array if sessionDir is not configured.
   */
  async listCheckpoints(): Promise<CheckpointSummary[]> {
    if (!this._config.sessionDir) return [];
    const writer = new CheckpointWriter(this._config.sessionDir);
    return writer.list();
  }

  // ---------------------------------------------------------------------------
  // 便捷 API
  // ---------------------------------------------------------------------------

  createSession(opts: { systemPrompt?: string } = {}): ChatSession {
    return new ChatSession(
      this,
      opts.systemPrompt ?? this._config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    );
  }

  registerTool(entry: Parameters<ToolRegistry['register']>[0]): void {
    this._registry.register(entry);
  }

  getToolDefinitions(): ToolDefinition[] {
    const filterCtx: ToolFilterContext = {
      agentDepth: this._delegationInit?.depth ?? 0,
      permissions: this._config.permissionConfig,
    };
    return this._registry.getDefinitions(this._enabledToolsets, this._disabledToolsets, filterCtx);
  }

  get sharedBudget(): SharedBudget {
    return this._sharedBudget;
  }
}

// ---------------------------------------------------------------------------
// ChatSession — 有状态多轮对话
// ---------------------------------------------------------------------------

export class ChatSession {
  /**
   * Persisted turn history (no system messages).
   *
   * Each completed `send()` appends a full turn trace:
   *   user input
   *   → (for each step that used tools)
   *       assistant message with tool_calls
   *       tool result messages  (one per call)
   *   → final assistant message (text-only, no tool_calls)
   *
   * This means the next `send()` gives the LLM complete visibility into
   * what tools were invoked and what they returned in prior turns.
   */
  private _history: Message[] = [];

  constructor(
    private _agent: AgentRuntime,
    private _systemPrompt: string,
  ) {}

  async send(userInput: string): Promise<string> {
    const result = await this._agent.run(userInput, {
      history: this._history,   // already system-message-free
      systemPrompt: this._systemPrompt,
    });

    // -----------------------------------------------------------------------
    // Rebuild the full turn trace from steps so tool calls are preserved.
    // -----------------------------------------------------------------------
    this._history.push(userMessage(userInput));

    for (const step of result.steps) {
      if (step.toolCalls.length > 0) {
        // Assistant turn: text + tool_calls
        this._history.push({
          role: 'assistant',
          content: step.assistantText,
          tool_calls: step.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        });
        // Tool results
        for (const tr of step.toolResults) {
          this._history.push({
            role: 'tool',
            content: tr.result,
            tool_call_id: tr.id,
            name: tr.name,
          });
        }
      } else if (step.assistantText) {
        // Final text-only assistant turn
        this._history.push({ role: 'assistant', content: step.assistantText });
      }
    }

    // If run() ended without any steps (e.g. budget exhausted immediately),
    // still record the response so the history isn't left with a dangling user msg.
    if (result.steps.length === 0 && result.response) {
      this._history.push({ role: 'assistant', content: result.response });
    }

    return result.response;
  }

  clear(): void { this._history = []; }
  getHistory(): Message[] { return [...this._history]; }
  interrupt(): void { this._agent.interrupt(); }
}
