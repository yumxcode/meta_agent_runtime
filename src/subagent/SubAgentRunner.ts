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
import { writeTask, readTask, releaseWriteChain } from './SubAgentTaskStore.js'
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

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SUMMARY_MAX_CHARS = 2_000
const ERROR_MAX_CHARS   = 500

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...'
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
  private readonly abortSignal:     AbortSignal
  private readonly _abortController: AbortController
  private readonly _forwardAbort:    () => void
  private readonly _interruptSessionOnAbort: () => void
  private session?: MetaAgentSession

  constructor(
    record: SubAgentRecord,
    /** All tools available in the runtime — runner filters by config.allowedTools */
    toolRegistry: Map<string, MetaAgentTool>,
    abortSignal: AbortSignal,
  ) {
    this.record          = { ...record }   // local copy — mutated as status progresses
    this.toolRegistry    = toolRegistry
    this.abortSignal     = abortSignal
    this._abortController = new AbortController()
    // Forward parent abort signal into our internal controller
    this._forwardAbort = () => this._abortController.abort()
    this._interruptSessionOnAbort = () => this.session?.interrupt()
    abortSignal.addEventListener('abort', this._forwardAbort, { once: true })
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
    const startMs = Date.now()
    return this._run().catch(async (err) => {
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
  }

  /**
   * Abort the sub-agent's internal session.
   * Called by SubAgentBridge.destroy() to cancel in-flight sub-agents when
   * the parent session ends.
   */
  abort(): void {
    this._abortController.abort()
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

    // Build the isolated session config.
    // Forward provider credentials from the parent session when explicit —
    // otherwise MetaAgentSession.resolveConfig() picks them up from env vars.
    //
    // systemPrompt: when the caller omits it, default to DEFAULT_SUB_AGENT_SYSTEM_PROMPT
    // (the lean execution-focused identity) rather than falling through to the full
    // S1-S10 static prompt.  Sub-agents have no need for campaign/DOE domain knowledge,
    // V&V protocols, or provenance tooling guidance — those belong to the main agent.
    const tools = await this._resolveToolsWithSandbox(sandboxHandle)

    const sessionConfig: MetaAgentConfig = {
      systemPrompt: cfg.systemPrompt ?? DEFAULT_SUB_AGENT_SYSTEM_PROMPT,
      maxTurns:     cfg.maxTurns,
      maxBudgetUsd: cfg.maxBudgetUsd,
      tools,
      verbose: false,
      includeStreamEvents: false,
      // Optional credential forwarding — omit when undefined so env-var detection still works
      ...(cfg.apiKey   !== undefined && { apiKey:   cfg.apiKey }),
      ...(cfg.baseURL  !== undefined && { baseURL:  cfg.baseURL }),
      ...(cfg.model    !== undefined && { model:    cfg.model }),
      ...(cfg.fallbackModel !== undefined && { fallbackModel: cfg.fallbackModel }),
    }

    this.session = new MetaAgentSession(sessionConfig)

    try { // ← outer try: ensures sandboxHandle.destroy() always runs
    try {
      // Abort signal forwarding
      if (this.abortSignal.aborted) {
        await this._writeTerminal('cancelled', {
          success:      false,
          summary:      'Cancelled before start',
          error:        'cancelled',
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

          // Abort may have fired mid-stream — honour it as cancelled
          if (this.abortSignal.aborted) {
            await this._writeTerminal('cancelled', {
              success:      false,
              summary:      truncate(lastText, SUMMARY_MAX_CHARS),
              error:        'cancelled',
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
            summary:      truncate((lastText.trim() || event.result).trim(), SUMMARY_MAX_CHARS),
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

      // Generator exhausted without a 'result' event — should not happen
      await this._writeTerminal('failed', {
        success:      false,
        summary:      truncate(lastText, SUMMARY_MAX_CHARS),
        error:        'Session ended without a result event',
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
        summary:      truncate(lastText, SUMMARY_MAX_CHARS),
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
      this.abortSignal.removeEventListener('abort', this._forwardAbort)
      this.abortSignal.removeEventListener('abort', this._interruptSessionOnAbort)
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
    // Guard against double-terminal writes.
    // IMPORTANT: also guard if the in-memory record is 'running' but the on-disk
    // record has already been set to 'cancelled' by SubAgentBridge.cancelTask().
    // Re-read the disk state to pick up any external cancellation.
    if (TERMINAL_STATUSES.has(this.record.status) && this.record.status !== 'running') return
    const diskRecord = await readTask(this.record.taskId)
    if (diskRecord && TERMINAL_STATUSES.has(diskRecord.status)) {
      // Another code path (e.g. cancelTask) already wrote a terminal state.
      // Update our in-memory record but do not overwrite the disk state.
      this.record.status = diskRecord.status
      await releaseWriteChain(this.record.taskId)
      return
    }

    this.record.status      = status
    this.record.completedAt = Date.now()
    this.record.result      = result
    this.record.pendingHumanApproval =
      status === 'completed' && this.record.config.requireHumanApproval

    await writeTask(this.record)
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
