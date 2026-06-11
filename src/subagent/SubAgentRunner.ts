/**
 * SubAgentRunner — isolated sub-agent lifecycle manager
 *
 * Wraps a MetaAgentSession in a fully isolated context:
 *   - Empty conversation history (no inheritance from parent)
 *   - Circuit-breaker enforcement (maxTurns, maxBudgetUsd)
 *   - Periodic checkpoint writes to SubAgentTaskStore
 *   - CampaignEventBus publication on completion / failure
 *
 * The runner is fire-and-forget from the caller's perspective:
 *   const runner = new SubAgentRunner(record, toolRegistry, abortSignal)
 *   runner.start()   // resolves internally; errors are converted to failed status
 *
 * Status progression: queued → running → completed | failed | cancelled
 */

import { MetaAgentSession } from '../core/MetaAgentSession.js'
import type { MetaAgentConfig } from '../core/config.js'
import type { MetaAgentTool } from '../core/types.js'
import { DEFAULT_SUB_AGENT_SYSTEM_PROMPT } from '../core/staticPrompt.js'
import { writeTask, readTask, mutateTask, releaseWriteChain } from './SubAgentTaskStore.js'
import { CampaignEventBus } from './CampaignEventBus.js'
import {
  TERMINAL_STATUSES,
  type SubAgentRecord,
  type SubAgentResult,
  type SubAgentProgressState,
  type SubAgentTaskId,
} from './types.js'
import { createSandboxExecutor } from '../sandbox/index.js'
import type { SandboxHandle } from '../sandbox/types.js'
import { createBashTool } from '../tools/shell/bash/index.js'
import { makeReturnResultTool, type ReturnedResult } from './tools/return_result.js'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SUMMARY_MAX_CHARS = 8_000
const ERROR_MAX_CHARS   = 500

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...'
}

/** Matches fenced ```json … ``` blocks (the structured payload sub-agents emit). */
const JSON_BLOCK_RE = /```json\s*[\s\S]*?```/gi

/** Return the LAST fenced ```json``` block (fences included), or null. */
export function extractLastJsonBlock(text: string): string | null {
  let match: RegExpExecArray | null
  let last: string | null = null
  JSON_BLOCK_RE.lastIndex = 0
  while ((match = JSON_BLOCK_RE.exec(text)) !== null) last = match[0]
  return last
}

/**
 * Build a summary that fits in `max` chars WITHOUT discarding the structured
 * result.  Sub-agents are instructed to place a ```json``` block at the end —
 * naive head-truncation would cut exactly that off.  So when the text overflows,
 * we keep the JSON block whole and fill the remaining budget with the narration
 * prefix, rather than slicing the head and losing the payload.
 */
export function buildSummaryFromText(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed

  const jsonBlock = extractLastJsonBlock(trimmed)
  if (jsonBlock && jsonBlock.length <= max) {
    const prefix = trimmed.slice(0, trimmed.indexOf(jsonBlock)).trim()
    const budget = max - jsonBlock.length - 2 // 2 for the joining newlines
    if (budget <= 0 || prefix.length === 0) return jsonBlock
    const keptPrefix = prefix.length <= budget ? prefix : prefix.slice(0, budget - 3) + '...'
    return `${keptPrefix}\n\n${jsonBlock}`
  }

  // No usable JSON block (or it alone overflows) — fall back to head truncation.
  return truncate(trimmed, max)
}

// ── Progress state extraction ─────────────────────────────────────────────────

/** Regex matching provenance IDs: prov-{8+ hex chars} */
const PROV_ID_RE = /\bprov-[a-f0-9]{8,}\b/g

/**
 * Regex for numbered-step markers.  Matches common patterns:
 *   "Step 1:", "Step 1 —", "## Step 2", "**Step 3**", "### 4."
 * Counts distinct step numbers to avoid inflating from repeated references.
 */
const STEP_NUMBER_RE = /(?:^|\s)(?:##+ )?(?:\*{0,2})step\s+(\d+)(?:\*{0,2})?(?:[:\s—]|$)/gim

/**
 * Extract a `SubAgentProgressState` from the accumulated output text.
 *
 * This is best-effort regex analysis — callers must treat the output as an
 * orientation cue only, not as authoritative structured data.
 */
function extractProgressState(
  text: string,
  toolCallsCompleted: number,
  lastCheckpoint: string | undefined,
): SubAgentProgressState {
  // Collect unique provenance IDs
  const provenanceIds: string[] = []
  const seenIds = new Set<string>()
  for (const match of text.matchAll(PROV_ID_RE)) {
    const id = match[0]
    if (!seenIds.has(id)) {
      seenIds.add(id)
      provenanceIds.push(id)
    }
  }

  // Count distinct step numbers (not raw match count — avoids double-counting)
  const stepNums = new Set<string>()
  for (const match of text.matchAll(STEP_NUMBER_RE)) {
    if (match[1]) stepNums.add(match[1])
  }

  return {
    toolCallsCompleted,
    provenanceIds,
    stepsCompleted: stepNums.size,
    ...(lastCheckpoint ? { lastCheckpoint } : {}),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SubAgentRunner
// ─────────────────────────────────────────────────────────────────────────────

export class SubAgentRunner {
  private readonly record:          SubAgentRecord
  private readonly toolRegistry:    Map<string, MetaAgentTool>
  private readonly parentAbortSignal: AbortSignal
  private readonly abortSignal:     AbortSignal
  private readonly _abortController: AbortController
  private readonly _forwardAbort:    () => void
  private readonly _interruptSessionOnAbort: () => void
  private session?: MetaAgentSession
  private _done: Promise<void> | undefined
  private _cancelReason: string | undefined
  /** Set when the wall-clock cap (maxDurationMs) fired — distinguishes timeout from user cancel. */
  private _timedOut = false
  /** Authoritative result the sub-agent submitted via the return_result tool, if any. */
  private _returnedResult?: ReturnedResult

  constructor(
    record: SubAgentRecord,
    /** All tools available in the runtime — runner filters by config.allowedTools */
    toolRegistry: Map<string, MetaAgentTool>,
    abortSignal: AbortSignal,
  ) {
    this.record          = { ...record }   // local copy — mutated as status progresses
    this.toolRegistry    = toolRegistry
    this.parentAbortSignal = abortSignal
    this._abortController = new AbortController()
    this.abortSignal     = this._abortController.signal
    // Forward parent abort signal into our internal controller
    this._forwardAbort = () => {
      this._cancelReason = 'cancelled'
      this._abortController.abort('parent-abort')
    }
    this._interruptSessionOnAbort = () => this.session?.interrupt()
    if (abortSignal.aborted) {
      this._forwardAbort()
    } else {
      abortSignal.addEventListener('abort', this._forwardAbort, { once: true })
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get taskId(): SubAgentTaskId { return this.record.taskId }

  /**
   * Start the sub-agent.  This is fire-and-forget — it resolves when the
   * sub-agent reaches a terminal state.  Errors are caught and written as
   * `failed` status, never rethrown.
   *
   * P1-1: The outer catch guarantees a terminal TaskStore write even if the
   * inner _run() catch handler itself throws — preventing the task from being
   * permanently stuck in 'running' state.
   */
  start(): Promise<void> {
    if (this._done) return this._done
    const startMs = Date.now()
    this._done = this._run().catch(async (err) => {
      // Inner _run() already writes terminal state for expected errors.
      // This outer handler catches unexpected throws from _run()'s own
      // error-handling code (e.g., writeTask() threw inside the catch block).
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[SubAgentRunner:${this.taskId}] Unhandled error in _run() catch handler:`, err)
      try {
        await this._writeTerminal('failed', {
          success:      false,
          summary:      '',
          error:        truncate(`Internal runner error: ${errMsg}`, ERROR_MAX_CHARS),
          turnsUsed:    0,
          inputTokens:  0,
          outputTokens: 0,
          costUsd:      0,
          durationMs:   Date.now() - startMs,
        })
      } catch (writeErr) {
        // Last resort — at least log it; task will remain stale on disk
        console.error(`[SubAgentRunner:${this.taskId}] Failed to write terminal state after crash:`, writeErr)
      }
    })
    return this._done
  }

  /** Resolves when the runner has reached terminal state and released resources. */
  wait(): Promise<void> {
    return this._done ?? Promise.resolve()
  }

  /**
   * Abort the sub-agent's internal session.
   * Called by SubAgentBridge.destroy() to cancel in-flight sub-agents when
   * the parent session ends.
   */
  abort(reason = 'cancelled'): void {
    this._cancelReason = reason
    this._abortController.abort(reason)
    this.session?.interrupt()
  }

  // ── Internal execution ──────────────────────────────────────────────────────

  private async _run(): Promise<void> {
    // Mark as running
    this.record.status    = 'running'
    this.record.startedAt = Date.now()
    await writeTask(this.record)

    const cfg = this.record.config
    const startMs = Date.now()
    let lastText = ''
    let turnsUsed = 0
    let inputTokens = 0
    let outputTokens = 0
    let toolResultCount = 0   // counts completed tool-call rounds (turn proxy)

    // ── Sandbox initialisation ─────────────────────────────────────────────
    // When cfg.sandbox is set, create an OS-level sandbox handle and inject
    // it into a sandboxed bash tool that replaces the plain bash tool in the
    // resolved tool list.  The handle is destroyed after the session reaches
    // a terminal state (see finally block at the bottom of this method).
    let sandboxHandle: SandboxHandle | undefined
    if (cfg.sandbox) {
      const executor = createSandboxExecutor()
      const workspaceRoot = process.cwd()
      if (executor.platform === 'noop' && !cfg.sandbox.allowUnsandboxedFallback) {
        throw new Error(
          'Sandbox requested, but no supported sandbox backend is available. ' +
          'Install sandbox-exec/bwrap or set sandbox.allowUnsandboxedFallback=true.',
        )
      }
      sandboxHandle = await executor.create(cfg.sandbox, workspaceRoot)
      process.stderr.write(
        `[meta-agent/sandbox:${this.taskId}] sandbox active — ${sandboxHandle.description}\n`,
      )
    }

    // L3-fix: every step below (tool resolution, session creation, the agentic
    // loop) runs inside this try so the finally block ALWAYS destroys the
    // sandbox handle — previously an exception thrown between handle creation
    // and the old try boundary leaked the handle.
    let durationTimer: ReturnType<typeof setTimeout> | undefined
    try { // ← outer try: ensures sandboxHandle.destroy() always runs

    // Build the isolated session config.
    // Forward provider credentials from the parent session when explicit —
    // otherwise MetaAgentSession.resolveConfig() picks them up from env vars.
    //
    // systemPrompt: when the caller omits it, default to DEFAULT_SUB_AGENT_SYSTEM_PROMPT
    // (the lean execution-focused identity) rather than falling through to the full
    // S1-S10 static prompt.  Sub-agents have no need for campaign/DOE domain knowledge,
    // V&V protocols, or provenance tooling guidance — those belong to the main agent.
    const tools = await this._resolveToolsWithSandbox(sandboxHandle)

    // Guard: if the task requested tools but none resolved, the agent would run
    // with an empty toolset — emitting a single line and terminating with
    // turnsUsed=0, which deceptively looks like success. Fail loudly instead so
    // the misconfiguration (e.g. bridge.setToolRegistry never called, or a typo
    // in allowedTools) surfaces rather than producing a hollow "complete".
    const requestedTools = cfg.allowedTools ?? []
    if (requestedTools.length > 0 && tools.length === 0) {
      // (sandboxHandle is destroyed by the outer finally)
      await this._writeTerminal('failed', {
        success:      false,
        summary:      '',
        error:        truncate(
          `No tools resolved for sub-agent. Requested [${requestedTools.join(', ')}] ` +
          `but the dispatcher's tool registry is empty or has no matching names. ` +
          `Ensure bridge.setToolRegistry() was called with these tools registered.`,
          ERROR_MAX_CHARS,
        ),
        turnsUsed:    0,
        inputTokens:  0,
        outputTokens: 0,
        costUsd:      0,
        durationMs:   Date.now() - startMs,
      })
      return
    }

    // Always give the sub-agent an explicit result channel. The payload it submits
    // here becomes the authoritative summary (see _summaryFor), independent of how
    // chatty the run was. Injected on top of the resolved tools so it never masks
    // the "no tools resolved" guard above.
    const returnResultTool = makeReturnResultTool(r => { this._returnedResult = r })
    const sessionTools = [...tools, returnResultTool]

    const sessionConfig: MetaAgentConfig = {
      systemPrompt: cfg.systemPrompt ?? DEFAULT_SUB_AGENT_SYSTEM_PROMPT,
      maxTurns:     cfg.maxTurns,
      maxBudgetUsd: cfg.maxBudgetUsd,
      tools:        sessionTools,
      verbose: false,
      includeStreamEvents: false,
      // Optional credential forwarding — omit when undefined so env-var detection still works
      ...(cfg.apiKey   !== undefined && { apiKey:   cfg.apiKey }),
      ...(cfg.baseURL  !== undefined && { baseURL:  cfg.baseURL }),
      ...(cfg.model    !== undefined && { model:    cfg.model }),
      ...(cfg.fallbackModel !== undefined && { fallbackModel: cfg.fallbackModel }),
    }

    this.session = new MetaAgentSession(sessionConfig)

    // Wall-clock cap (default 5 min): force-stop a sub-agent that runs too long
    // — e.g. an inner web_fetch that never returns. Interrupting the session
    // ends the submit() generator; _timedOut steers terminal handling below.
    const maxDurationMs = cfg.maxDurationMs ?? 300_000
    durationTimer = maxDurationMs > 0
      ? setTimeout(() => {
          this._timedOut = true
          this._cancelReason = 'timeout'
          this._abortController.abort('timeout')
          this.session?.interrupt()
        }, maxDurationMs)
      : undefined

    try {
      // Abort signal forwarding
      if (this.abortSignal.aborted) {
        await this._writeTerminal('cancelled', {
          success:      false,
          summary:      'Cancelled before start',
          error:        this._cancelReason ?? 'cancelled',
          turnsUsed:    0,
          inputTokens:  0,
          outputTokens: 0,
          costUsd:      0,
          durationMs:   0,
        })
        return
      }

      this.abortSignal.addEventListener('abort', this._interruptSessionOnAbort, { once: true })

      // Run the agentic loop — consume the generator
      const gen = this.session.submit(cfg.taskDescription)

      for await (const event of gen) {
        // Accumulate text
        if (event.type === 'text') {
          lastText += event.text
        }

        // Each tool_result marks the end of one tool-use round.
        // We use this as a turn proxy for checkpoint scheduling.
        if (event.type === 'tool_result') {
          toolResultCount++
          if (
            cfg.checkpointEveryNTurns > 0 &&
            toolResultCount % cfg.checkpointEveryNTurns === 0 &&
            lastText.trim()
          ) {
            await this._saveCheckpoint(lastText, toolResultCount)
          }
        }

        // Terminal: final result event from the agentic loop
        if (event.type === 'result') {
          turnsUsed    = event.numTurns
          inputTokens  = event.usage.inputTokens
          outputTokens = event.usage.outputTokens

          // Abort may have fired mid-stream — timeout → failed, user cancel → cancelled
          if (this._timedOut || this.abortSignal.aborted) {
            await this._writeTerminal(this._timedOut ? 'failed' : 'cancelled', {
              success:      false,
              summary:      this._summaryFor(lastText),
              error:        this._timedOut
                ? `Sub-agent exceeded ${maxDurationMs}ms wall-clock limit`
                : (this._cancelReason ?? 'cancelled'),
              turnsUsed,
              inputTokens,
              outputTokens,
              costUsd:      event.totalCostUsd,
              durationMs:   Date.now() - startMs,
              progressState: extractProgressState(
                lastText, toolResultCount, this.record.latestCheckpoint,
              ),
            })
            return
          }

          const isError = event.subtype !== 'success'
          const result: SubAgentResult = {
            success:      !isError,
            summary:      this._summaryFor(lastText, event.result),
            error:        isError
              ? truncate(this._stopReasonToError(event.subtype), ERROR_MAX_CHARS)
              : undefined,
            turnsUsed,
            inputTokens,
            outputTokens,
            costUsd:      event.totalCostUsd,
            durationMs:   Date.now() - startMs,
            progressState: extractProgressState(
              lastText, toolResultCount, this.record.latestCheckpoint,
            ),
          }

          await this._writeTerminal(isError ? 'failed' : 'completed', result)
          return
        }
      }

      // Generator exhausted without a 'result' event — either the wall-clock
      // cap interrupted the session, or (unexpectedly) the loop ended early.
      await this._writeTerminal('failed', {
        success:      false,
        summary:      this._summaryFor(lastText),
        error:        this._timedOut
          ? `Sub-agent exceeded ${maxDurationMs}ms wall-clock limit`
          : 'Session ended without a result event',
        turnsUsed,
        inputTokens,
        outputTokens,
        costUsd:      this.session.getEstimatedCost(),
        durationMs:   Date.now() - startMs,
        progressState: extractProgressState(
          lastText, toolResultCount, this.record.latestCheckpoint,
        ),
      })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await this._writeTerminal('failed', {
        success:      false,
        summary:      this._summaryFor(lastText),
        error:        truncate(errMsg, ERROR_MAX_CHARS),
        turnsUsed,
        inputTokens,
        outputTokens,
        costUsd:      this.session?.getEstimatedCost() ?? 0,
        durationMs:   Date.now() - startMs,
        progressState: extractProgressState(
          lastText, toolResultCount, this.record.latestCheckpoint,
        ),
      })
    }
    } finally {
      if (durationTimer) clearTimeout(durationTimer)
      this.parentAbortSignal.removeEventListener('abort', this._forwardAbort)
      this.abortSignal.removeEventListener('abort', this._interruptSessionOnAbort)
      await this.session?.dispose().catch(() => undefined)
      // Always release the sandbox handle, even if _writeTerminal or the loop
      // threw an unexpected error.  destroy() is a no-op for Noop/macOS handles
      // and is safe to call multiple times.
      await sandboxHandle?.destroy()
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Resolve the allowed tool list for this sub-agent session.
   *
   * When a sandboxHandle is provided, the 'bash' tool is replaced with a
   * freshly-created sandboxed variant that captures the handle in its closure.
   * All other tools are returned unchanged from the tool registry.
   */
  private async _resolveToolsWithSandbox(
    sandboxHandle?: SandboxHandle,
  ): Promise<MetaAgentTool[]> {
    const allowed = this.record.config.allowedTools
    if (!allowed || allowed.length === 0) return []

    const tools = allowed
      .map(name => this.toolRegistry.get(name))
      .filter((t): t is MetaAgentTool => t !== undefined)

    if (!sandboxHandle) return tools

    // Replace the 'bash' tool with a sandboxed version
    return Promise.all(
      tools.map(async t =>
        t.name === 'bash'
          ? createBashTool({ sandboxHandle })
          : t,
      ),
    )
  }

  /**
   * Resolve the summary for a terminal record.
   *
   * Prefers the result the sub-agent explicitly submitted via return_result —
   * that is the authoritative answer and is independent of run-time narration.
   * The structured `data` is appended as a ```json``` block so downstream
   * consumers (and JSON-priority truncation) can recover it.  Falls back to the
   * accumulated `lastText` (JSON-block-preserving truncation) for sub-agents that
   * never called return_result.
   */
  private _summaryFor(lastText: string, fallback = ''): string {
    if (this._returnedResult) {
      const { summary, data } = this._returnedResult
      let out = summary.trim()
      if (data !== undefined) {
        let json: string
        try { json = JSON.stringify(data, null, 2) } catch { json = String(data) }
        out = out ? `${out}\n\n\`\`\`json\n${json}\n\`\`\`` : `\`\`\`json\n${json}\n\`\`\``
      }
      return buildSummaryFromText(out, SUMMARY_MAX_CHARS)
    }
    const source = (lastText.trim() || fallback).trim()
    return buildSummaryFromText(source, SUMMARY_MAX_CHARS)
  }

  private _stopReasonToError(subtype: string): string {
    switch (subtype) {
      case 'error_max_turns':   return `Turn limit exceeded (${this.record.config.maxTurns} turns)`
      case 'error_max_budget':  return `Budget exceeded ($${this.record.config.maxBudgetUsd.toFixed(2)} limit)`
      case 'error_during_execution': return 'Error during execution'
      default: return `Stopped: ${subtype}`
    }
  }

  /**
   * Write a terminal status record and publish the corresponding event.
   * Also sets pendingHumanApproval if requireHumanApproval=true and completed.
   */
  private async _writeTerminal(
    status: 'completed' | 'failed' | 'cancelled',
    result: SubAgentResult,
  ): Promise<void> {
    // Guard against double-terminal (e.g. abort + error racing)
    if (TERMINAL_STATUSES.has(this.record.status) && this.record.status !== 'running') return

    // L1-fix: the read-decide-write below runs atomically on the per-task
    // write chain (mutateTask), so a concurrent cancelTask() 'cancelled' write
    // can no longer be overwritten by this runner's 'completed' in the window
    // between an unsynchronised read and write.
    const candidate: SubAgentRecord = {
      ...this.record,
      status,
      completedAt: Date.now(),
      result,
      pendingHumanApproval:
        status === 'completed' && this.record.config.requireHumanApproval,
    }
    const written = await mutateTask(this.record.taskId, disk =>
      disk && TERMINAL_STATUSES.has(disk.status) ? null : candidate,
    )
    if (written === null) {
      // Another code path (e.g. cancelTask) already wrote a terminal state.
      // Sync our in-memory record but do not overwrite the disk state.
      const disk = await readTask(this.record.taskId)
      if (disk) this.record.status = disk.status
      await releaseWriteChain(this.record.taskId)
      return
    }
    Object.assign(this.record, candidate)
    await releaseWriteChain(this.record.taskId)

    // Publish event
    if (status === 'completed') {
      CampaignEventBus.emit('subagent:completed', {
        taskId:          this.record.taskId,
        parentSessionId: this.record.parentSessionId,
        result,
      })
    } else {
      CampaignEventBus.emit('subagent:failed', {
        taskId:          this.record.taskId,
        parentSessionId: this.record.parentSessionId,
        error:           result.error ?? status,
      })
    }
  }

  /**
   * Save a checkpoint — called internally after each turn when
   * checkpointEveryNTurns > 0 and the turn boundary is detected.
   */
  private async _saveCheckpoint(text: string, turnNumber: number): Promise<void> {
    this.record.latestCheckpoint   = truncate(text.trim(), SUMMARY_MAX_CHARS)
    this.record.latestCheckpointAt = Date.now()
    await writeTask(this.record)

    CampaignEventBus.emit('subagent:checkpoint', {
      taskId:          this.record.taskId,
      parentSessionId: this.record.parentSessionId,
      checkpoint:      this.record.latestCheckpoint,
      turnNumber,
    })
  }
}
