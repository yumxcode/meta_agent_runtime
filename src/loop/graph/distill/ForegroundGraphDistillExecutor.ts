import type { MetaAgentEvent } from '../../../core/types.js'
import type { LoopGraphSpec } from '../spec/GraphTypes.js'

export type GraphDistillPhase = 'architect' | 'compiler' | 'semantic_review'

export interface GraphDistillModelRequest {
  phase: GraphDistillPhase
  /** Reuse one directly-owned conversation across compiler revisions. Omit for
   * independent one-shot calls such as semantic review. */
  sessionKey?: string
  taskDescription: string
  systemPrompt: string
  allowedTools: readonly string[]
  maxTurns: number
  maxBudgetUsd: number
  /** Distill is a bounded compiler, so reasoning is explicit per phase instead
   * of inheriting the foreground Agent's unbounded/adaptive default. Zero
   * disables provider-visible extended thinking. */
  thinkingBudgetTokens?: number
  /** Hard per-call output ceiling selected by the Distill phase policy. */
  maxOutputTokens?: number
  /** Hard wall-clock ceiling for one foreground phase call. */
  maxWallTimeMs?: number
  signal: AbortSignal
}

export interface GraphDistillModelResult {
  status: 'completed' | 'failed' | 'cancelled'
  output?: unknown
  summary?: string
  error?: string
  /** Last complete graph accepted by graph_validate during this call. This is
   * executable evidence, not model prose, and may anchor a retry. */
  validatedGraph?: LoopGraphSpec
}

/** Model boundary used by Distill. It is intentionally independent from the
 * graph_agent and SubAgent dispatcher boundaries: Distill is a foreground
 * compiler phase, not a durable Graph Activation. */
export interface GraphDistillExecutor {
  execute(request: GraphDistillModelRequest): Promise<GraphDistillModelResult>
  dispose?(): Promise<void>
}

export interface ForegroundDistillSession {
  submit(prompt: string): AsyncGenerator<MetaAgentEvent>
  interrupt(): void
  steer(text: string): boolean
  getEstimatedCost(): number
  dispose(): Promise<void>
}

export interface ForegroundGraphDistillExecutorOptions {
  createSession(request: GraphDistillModelRequest): ForegroundDistillSession | Promise<ForegroundDistillSession>
  /** Optional host UI driver. CLI uses the existing agentic stream renderer so
   * Distill has exactly the same visible model/tool interaction as agentic mode. */
  runSession?: (session: ForegroundDistillSession, request: GraphDistillModelRequest) => Promise<GraphDistillModelResult>
  onEvent?: (phase: GraphDistillPhase, event: MetaAgentEvent) => void
}

/** Runs each compiler/reviewer call in a directly-owned foreground session.
 * No task record, child seat, polling loop, or sub-agent sandbox is involved. */
export class ForegroundGraphDistillExecutor implements GraphDistillExecutor {
  private readonly sessions = new Map<string, ForegroundDistillSession>()

  constructor(private readonly options: ForegroundGraphDistillExecutorOptions) {}

  async execute(request: GraphDistillModelRequest): Promise<GraphDistillModelResult> {
    const scoped = scopeRequestSignal(request)
    try {
      const result = await this.executeScoped(scoped.request)
      // A phase-local wall deadline is a retryable compiler failure, not a
      // user cancellation. Keeping it as `cancelled` made GraphDistiller abort
      // all remaining attempts after the first slow response. The interrupted
      // conversation is no longer a safe repair anchor, so replace it on retry.
      const normalized = scoped.timedOut() && result.status === 'cancelled'
        ? { ...result, status: 'failed' as const, error: abortReason(scoped.request.signal) }
        : result
      if (request.sessionKey && normalized.status !== 'completed') {
        await this.discardSession(request.sessionKey)
      }
      return normalized
    } finally {
      scoped.dispose()
    }
  }

  private async executeScoped(request: GraphDistillModelRequest): Promise<GraphDistillModelResult> {
    if (request.signal.aborted) return { status: 'cancelled', error: abortReason(request.signal) }
    const session = request.sessionKey
      ? await this.persistentSession(request.sessionKey, request)
      : await this.options.createSession(request)
    // The caller may abort while an async session factory is resolving. An
    // AbortSignal does not replay an already-fired event to a listener added
    // later, so re-check before entering submit/runSession.
    if (request.signal.aborted) {
      session.interrupt()
      if (!request.sessionKey) await session.dispose().catch(() => undefined)
      return { status: 'cancelled', error: abortReason(request.signal) }
    }
    const onAbort = (): void => session.interrupt()
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (this.options.runSession) {
      try {
        const result = await this.options.runSession(session, request)
        return request.signal.aborted
          // A graph_validate callback may have produced a frozen candidate
          // before the model spent too long formatting its final envelope.
          // Preserve it across the timeout normalization so GraphDistiller can
          // retry metadata only rather than rebuilding the graph.
          ? {
              status: 'cancelled',
              output: result.output,
              summary: result.summary,
              error: abortReason(request.signal),
              validatedGraph: result.validatedGraph,
            }
          : result
      } catch (error) {
        return {
          status: request.signal.aborted ? 'cancelled' : 'failed',
          error: error instanceof Error ? error.message : String(error),
        }
      } finally {
        request.signal.removeEventListener('abort', onAbort)
        if (!request.sessionKey) await session.dispose().catch(() => undefined)
      }
    }
    let text = ''
    let terminal: Extract<MetaAgentEvent, { type: 'result' }> | undefined
    try {
      for await (const event of session.submit(request.taskDescription)) {
        this.options.onEvent?.(request.phase, event)
        if (event.type === 'text') text += event.text
        if (event.type === 'result') terminal = event
      }
      if (request.signal.aborted) return { status: 'cancelled', error: abortReason(request.signal) }
      if (!terminal) return { status: 'failed', output: text || undefined, error: 'foreground Distill session ended without a terminal result' }
      const output = text.trim() || terminal.result
      if (terminal.subtype !== 'success' || terminal.isError) {
        return {
          status: 'failed',
          output: output || undefined,
          error: terminal.errors?.join('; ') || `foreground Distill session ended with ${terminal.subtype}`,
        }
      }
      return { status: 'completed', output, summary: terminal.result }
    } catch (error) {
      return {
        status: request.signal.aborted ? 'cancelled' : 'failed',
        output: text || undefined,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      request.signal.removeEventListener('abort', onAbort)
      if (!request.sessionKey) await session.dispose().catch(() => undefined)
    }
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map(session => session.dispose().catch(() => undefined)))
  }

  private async persistentSession(key: string, request: GraphDistillModelRequest): Promise<ForegroundDistillSession> {
    const existing = this.sessions.get(key)
    if (existing) return existing
    const created = await this.options.createSession(request)
    this.sessions.set(key, created)
    return created
  }

  private async discardSession(key: string): Promise<void> {
    const session = this.sessions.get(key)
    if (!session) return
    this.sessions.delete(key)
    await session.dispose().catch(() => undefined)
  }
}

function scopeRequestSignal(request: GraphDistillModelRequest): {
  request: GraphDistillModelRequest
  timedOut(): boolean
  dispose(): void
} {
  if (!request.maxWallTimeMs || request.maxWallTimeMs <= 0) {
    return { request, timedOut: () => false, dispose() {} }
  }
  const controller = new AbortController()
  let phaseTimedOut = false
  const relayAbort = (): void => controller.abort(request.signal.reason)
  request.signal.addEventListener('abort', relayAbort, { once: true })
  if (request.signal.aborted) relayAbort()
  const timer = setTimeout(() => {
    phaseTimedOut = true
    controller.abort(new Error(`foreground Distill ${request.phase} exceeded ${request.maxWallTimeMs}ms wall-time limit`))
  }, request.maxWallTimeMs)
  timer.unref?.()
  return {
    request: { ...request, signal: controller.signal },
    timedOut: () => phaseTimedOut,
    dispose() {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', relayAbort)
    },
  }
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'cancelled')
}
