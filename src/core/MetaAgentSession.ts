/**
 * MetaAgentSession — the primary entry point for meta-agent conversations.
 *
 * Architecture (facade over AgenticSession):
 *
 *   MetaAgentSession
 *     ├─ SectionRegistry      — per-session prompt section memoisation
 *     ├─ toolRegistry         — MetaAgentTool map (used for dynamic sections)
 *     ├─ _planModeRef         — shared mutable plan-mode flag
 *     └─ _inner: AgenticSession  ← handles the actual agentic loop
 *          └─ KernelSession      ← the cc-kernel rewrite (query loop, compact, etc.)
 *
 * On every submit():
 *   1. Build the full system prompt (static + dynamic + appendSuffix)
 *   2. Push it into the inner session via setAppendSystemPrompt()
 *      (the inner session was created with systemPrompt:'', so the full
 *       prompt is always the appendSystemPrompt value)
 *   3. Delegate to AgenticSession.submit() and yield its events
 *
 * Compared to the old direct-Anthropic-SDK implementation:
 *   • The ~500-line agentic loop, streaming, tool execution, and auto-compact
 *     code are fully removed — all handled by cc-kernel via KernelSession.
 *   • System prompt building, SectionRegistry, plan-mode gating, and the
 *     beforeToolCall hook remain here and are wired in via tool wrappers and
 *     setAppendSystemPrompt().
 */

import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  resolveConfig,
  isAnthropicProvider,
  DEFAULT_SYSTEM_PROMPT,
  type MetaAgentConfig,
  type ResolvedConfig,
} from './config.js'
import { createSandboxExecutor } from '../sandbox/index.js'
import type { SandboxHandle, SandboxConfig } from '../sandbox/types.js'
import type { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import type {
  ConversationMessage,
  MetaAgentEvent,
  MetaAgentTool,
  TokenUsage,
} from './types.js'
import { SectionRegistry } from './systemPromptSections.js'
import { buildStaticSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './staticPrompt.js'
import { buildDynamicSections, type AgentMode } from './dynamicPrompt.js'
import type { TaskContract } from './contract/types.js'
import { AgenticSession } from '../modes/AgenticSession.js'

// ─────────────────────────────────────────────────────────────────────────────
// MetaAgentSession
// ─────────────────────────────────────────────────────────────────────────────

export class MetaAgentSession {
  // ── Identity ──────────────────────────────────────────────────────────────
  readonly sessionId: string
  private readonly sessionStartMs = Date.now()

  // ── Prompt engineering ────────────────────────────────────────────────────
  private readonly staticPrompt: string = buildStaticSystemPrompt()
  private readonly sectionRegistry = new SectionRegistry()
  private readonly _usingDefaultPrompt: boolean
  /**
   * Fully-assembled system prompt from the most recent submit() call.
   * null until the first submit().
   */
  private _lastSystemPrompt: string | null = null
  /**
   * Dynamic suffix set by setAppendSystemPrompt().
   * Injected after the dynamic sections on every submit().
   */
  private _appendSuffix = ''
  /**
   * True when callTool() has written a new provenance record since the last
   * submit(). Causes session_provenance to be re-resolved next turn.
   */
  private _provenanceDirty = false

  // ── Plan mode ─────────────────────────────────────────────────────────────
  /**
   * Shared mutable ref — EnterPlanMode / ExitPlanMode tools flip .active.
   * Exposed as `readonly` so callers can read it but only tools write it.
   */
  readonly _planModeRef: { active: boolean } = { active: false }

  // ── External attachments ──────────────────────────────────────────────────
  private _subAgentBridge: SubAgentBridge | undefined = undefined
  private _taskContract: TaskContract | undefined = undefined

  // ── Inner engine ──────────────────────────────────────────────────────────
  private readonly _inner: AgenticSession

  // ── Tool registry (for dynamic sections) ─────────────────────────────────
  private readonly toolRegistry: Map<string, MetaAgentTool>

  // ── Config (for prompt building) ──────────────────────────────────────────
  private readonly config: ResolvedConfig

  // ── Anthropic client (for memory relevance side-calls) ───────────────────
  private readonly client: Anthropic

  // ── Concurrency guard ─────────────────────────────────────────────────────
  private _submitInFlight = false

  // ── Per-session sandbox handle cache ──────────────────────────────────────
  // Keyed by JSON.stringify(sandboxConfig) so tools with identical policies
  // share one handle rather than each spawning their own executor.
  // `true` policy is stored under the key '__default__'.
  private _sandboxHandles = new Map<string, SandboxHandle>()

  // ─────────────────────────────────────────────────────────────────────────
  // Constructor
  // ─────────────────────────────────────────────────────────────────────────

  constructor(config: MetaAgentConfig = {}) {
    // Detect "no custom system prompt" BEFORE resolveConfig fills in the default
    this._usingDefaultPrompt =
      config.systemPrompt === undefined || config.systemPrompt === DEFAULT_SYSTEM_PROMPT

    this.config = resolveConfig(config)
    this._appendSuffix = config.appendSystemPrompt ?? ''

    if (!this.config.apiKey) {
      throw new Error(
        'API key is required. Set DEEPSEEK_API_KEY (DeepSeek), ANTHROPIC_API_KEY (Anthropic), ' +
        'or QWEN_API_KEY (Qwen) — the provider and endpoint are auto-detected from the key.\n' +
        'You can also pass config.apiKey and optionally config.baseURL for custom endpoints.',
      )
    }

    // Anthropic client for memory relevance side-calls (not used for the loop)
    this.client = new Anthropic({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
      maxRetries: this.config.maxRetries,
    })

    // Tool registry (for dynamic prompt sections)
    this.toolRegistry = new Map(this.config.tools.map(t => [t.name, t]))

    // ── Inner AgenticSession ─────────────────────────────────────────────────
    // Crucially, we set systemPrompt to '' so that the full assembled prompt
    // (built per-submit below) can be injected via setAppendSystemPrompt().
    // Empty string is falsy — KernelLoop's filter(Boolean) removes it so the
    // model only sees the dynamically-injected full prompt.
    this._inner = new AgenticSession({
      ...config,
      systemPrompt: '',       // placeholder; real prompt injected per-submit
      appendSystemPrompt: '', // starts empty; set on first submit()
      tools: [],              // registered below after MetaAgentSession wrapping
      planModeRef: this._planModeRef,
    })

    this.sessionId = this._inner.getSessionId()

    for (const tool of this.config.tools) {
      this.registerTool(tool)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Submit a prompt and receive a stream of MetaAgentEvents.
   *
   * @param prompt — the user message to submit.
   * @param mode   — agent execution mode hint (used for dynamic prompt sections).
   *                 Defaults to 'agentic'.
   */
  async *submit(
    prompt: string,
    mode: AgentMode = 'agentic',
  ): AsyncGenerator<MetaAgentEvent, void, unknown> {
    if (this._submitInFlight) {
      throw new Error(
        `[MetaAgent:${this.sessionId.slice(0, 8)}] Cannot call submit() concurrently on the same session. ` +
        'Wait for the current turn to complete before submitting a new prompt.',
      )
    }
    this._submitInFlight = true
    try {
      yield* this._submitInner(prompt, mode)
    } finally {
      this._submitInFlight = false
    }
  }

  private async *_submitInner(
    prompt: string,
    mode: AgentMode,
  ): AsyncGenerator<MetaAgentEvent, void, unknown> {
    // ── Build system prompt ────────────────────────────────────────────────
    if (this._provenanceDirty) {
      this.sectionRegistry.invalidate('session_provenance')
      this._provenanceDirty = false
    }

    const dynamicSections = buildDynamicSections({
      sessionId:    this.sessionId,
      sessionStartMs: this.sessionStartMs,
      mode,
      domain:       this.config.domain,
      rtx:          this.config.runtimeContext,
      language:     this.config.language,
      mcpServers:   this.config.mcpServers,
      outputStyle:  this.config.outputStyle,
      currentQuery: prompt,
      // Only pass Anthropic client for providers that support haiku side-calls
      client: isAnthropicProvider(this.config.baseURL) ? this.client : undefined,
      subAgentBridge: this._subAgentBridge,
      taskContract:   this._taskContract,
      projectDir:     this.config.projectDir,
    })

    const dynamicPrompt = await this.sectionRegistry.resolveToString(dynamicSections)

    // Assemble the full effective system prompt
    // Ordering mirrors the original MetaAgentSession exactly:
    //   Default  → staticPrompt + BOUNDARY + dynamicPrompt + '\n\n' + appendSuffix
    //   Custom   → config.systemPrompt + '\n\n' + appendSuffix + '\n\n' + dynamicPrompt
    let fullPrompt: string
    if (!this._usingDefaultPrompt) {
      fullPrompt = this.config.systemPrompt ?? ''
      if (this._appendSuffix) fullPrompt += '\n\n' + this._appendSuffix
      if (dynamicPrompt)      fullPrompt += '\n\n' + dynamicPrompt
    } else {
      fullPrompt = this.staticPrompt + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + dynamicPrompt
      if (this._appendSuffix) fullPrompt += '\n\n' + this._appendSuffix
    }

    this._lastSystemPrompt = fullPrompt

    // Inject into the inner session — because inner was created with
    // systemPrompt:'', the full prompt is injected entirely via appendSystemPrompt.
    this._inner.setAppendSystemPrompt(fullPrompt)

    // ── Delegate to AgenticSession ────────────────────────────────────────
    yield* this._inner.submit(prompt)
  }

  /**
   * Register a tool with the session.
   *
   * Wraps the tool's call() function to apply:
   *   1. The beforeToolCall hook (interactive confirmation guard)
   *   2. Plan-mode gating (ask user before non-safe tools)
   *   3. Provenance dirty-flagging (triggers session_provenance refresh)
   */
  registerTool(tool: MetaAgentTool): void {
    const wrapped = this._wrapTool(tool)
    this.toolRegistry.set(tool.name, wrapped)
    this._inner.registerTool(wrapped)
  }

  /** Interrupt the currently-running submit(). */
  interrupt(): void {
    this._inner.interrupt()
  }

  /** All messages in the current conversation. */
  getMessages(): readonly ConversationMessage[] {
    // KernelMessage is structurally compatible with ConversationMessage
    return this._inner.getMessages() as unknown as readonly ConversationMessage[]
  }

  /** Accumulated token usage across all turns. */
  getUsage(): TokenUsage {
    return this._inner.getUsage()
  }

  /** Estimated total cost in USD. */
  getEstimatedCost(): number {
    return this._inner.getEstimatedCost()
  }

  getSessionId(): string {
    return this.sessionId
  }

  /**
   * Returns the full system prompt assembled during the most recent submit() call.
   * null until the first submit().
   */
  getLastSystemPrompt(): string | null {
    return this._lastSystemPrompt
  }

  /**
   * Dynamically update the suffix appended to the system prompt.
   * Called by RoboticsSession to inject R1-R5 sections before each submit.
   * The new value takes effect on the NEXT submit() call.
   */
  setAppendSystemPrompt(text: string): void {
    this._appendSuffix = text
  }

  /**
   * Attach a SubAgentBridge so sub-agent completion notifications are
   * injected into the system prompt on every submit turn (D11 section).
   */
  setSubAgentBridge(bridge: SubAgentBridge): void {
    this._subAgentBridge = bridge
  }

  /**
   * Attach a TaskContract so a memoized D0 goal-anchor section is prepended
   * to every prompt turn, embedding the original user intent and acceptance criteria.
   */
  setTaskContract(contract: TaskContract): void {
    this._taskContract = contract
  }

  /**
   * Release per-session resources. Call when a long-lived host is done with
   * this session; safe to call multiple times.
   */
  async dispose(): Promise<void> {
    const handles = [...this._sandboxHandles.values()]
    this._sandboxHandles.clear()
    await Promise.allSettled(handles.map(handle => handle.destroy()))
  }

  /** Backward-compatible synchronous teardown alias. */
  destroy(): void {
    void this.dispose()
  }

  /** Return the debug log directory for this session (may not exist yet). */
  getDebugDir(): string {
    return join(homedir(), '.meta-agent', 'debug', this.sessionId)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Static helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Write a debug snapshot to ~/.meta-agent/debug/<sessionId>/turn-NNN-<kind>.json
   * Called fire-and-forget — errors are silently swallowed so debug I/O
   * never interrupts the main conversation flow.
   */
  static async _writeDebugFile(
    sessionId: string,
    turn: number,
    kind: 'req' | 'res',
    payload: unknown,
  ): Promise<void> {
    try {
      const dir = join(homedir(), '.meta-agent', 'debug', sessionId)
      await mkdir(dir, { recursive: true })
      const filename = `turn-${String(turn).padStart(3, '0')}-${kind}.json`
      await writeFile(join(dir, filename), JSON.stringify(payload, null, 2), 'utf8')
    } catch (err) {
      process.stderr.write(
        `[meta-agent DEBUG] ⚠ 写入调试文件失败: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Lazily create (or retrieve from cache) a SandboxHandle for the given policy.
   *
   * - `true`         → default policy: workspaceRoot writable, network unrestricted
   * - SandboxConfig  → caller-specified policy
   *
   * Handles are cached per session by policy key so tools with identical
   * policies reuse the same handle instance.  The Noop executor's handle is
   * also cached, so the overhead is just one Map lookup per tool call.
   */
  private async _getOrCreateSandboxHandle(
    policy: true | SandboxConfig,
  ): Promise<SandboxHandle> {
    const cacheKey = policy === true ? '__default__' : JSON.stringify(policy)

    const cached = this._sandboxHandles.get(cacheKey)
    if (cached) return cached

    const config: SandboxConfig = policy === true ? {} : policy
    const workspaceRoot = this.config.projectDir ?? process.cwd()
    const executor = createSandboxExecutor()
    if (executor.platform === 'noop' && !config.allowUnsandboxedFallback) {
      throw new Error(
        'Sandbox requested, but no supported sandbox backend is available. ' +
        'Install sandbox-exec/bwrap or set sandbox.allowUnsandboxedFallback=true.',
      )
    }
    const handle = await executor.create(config, workspaceRoot)

    this._sandboxHandles.set(cacheKey, handle)
    return handle
  }

  /**
   * Wrap a MetaAgentTool's call() to apply:
   *   1. Sandbox injection — if tool.permission.sandbox is set, a SandboxHandle
   *      is lazily created and injected into ToolCallContext.sandboxHandle before
   *      the tool's call() is invoked.  The tool reads ctx.sandboxHandle to wrap
   *      its subprocess execution (see BashTool).
   *   2. Provenance dirty-flag (triggers session_provenance refresh next turn)
   *
   * V&V/provenance instrumentation is applied by AgenticSession so direct
   * AgenticSession consumers and MetaAgentSession share one instrumentation path.
   * Permission hooks and plan-mode checks are enforced by the kernel policy.
   */
  private _wrapTool(tool: MetaAgentTool): MetaAgentTool {
    const hasRtx  = Boolean(this.config.runtimeContext)
    const facade  = this
    const sandboxPolicy = tool.permission?.sandbox

    return {
      ...tool,
      call: async (input, ctx) => {
        try {
          // ── Sandbox context injection ──────────────────────────────────
          // Enrich ctx with a sandboxHandle when the tool declares a sandbox
          // policy.  The handle is created lazily and cached for the session.
          let enrichedCtx = ctx
          if (sandboxPolicy !== undefined) {
            const sandboxHandle = await facade._getOrCreateSandboxHandle(sandboxPolicy)
            enrichedCtx = { ...ctx, sandboxHandle }
          }

          const result = await tool.call(input, enrichedCtx)
          // Mark provenance dirty on any completion (success or error)
          if (hasRtx) facade._provenanceDirty = true
          return result
        } catch (err) {
          if (hasRtx) facade._provenanceDirty = true
          return { content: `Tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
        }
      },
    }
  }

  /** Register a wrapped tool into the tool registry (for initial tools in constructor). */
  private _registerWrapped(tool: MetaAgentTool): void {
    const wrapped = this._wrapTool(tool)
    this.toolRegistry.set(tool.name, wrapped)
  }
}
