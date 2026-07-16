import type { MetaAgentEvent } from '../../../core/types.js'

export type GraphDistillPhase = 'compiler' | 'semantic_review'

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
  signal: AbortSignal
}

export interface GraphDistillModelResult {
  status: 'completed' | 'failed' | 'cancelled'
  output?: unknown
  summary?: string
  error?: string
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
    if (request.signal.aborted) return { status: 'cancelled', error: abortReason(request.signal) }
    const session = request.sessionKey
      ? await this.persistentSession(request.sessionKey, request)
      : await this.options.createSession(request)
    const onAbort = (): void => session.interrupt()
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (this.options.runSession) {
      try {
        return await this.options.runSession(session, request)
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
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'cancelled')
}
