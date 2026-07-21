import { describe, expect, it, vi } from 'vitest'
import {
  ForegroundGraphDistillExecutor,
  type ForegroundDistillSession,
  type GraphDistillModelRequest,
  type LoopGraphSpec,
} from '../index.js'
import type { MetaAgentEvent } from '../../../core/types.js'

function request(signal = new AbortController().signal): GraphDistillModelRequest {
  return {
    phase: 'compiler',
    taskDescription: 'compile this loop',
    systemPrompt: 'return JSON',
    allowedTools: ['read_file'],
    maxTurns: 30,
    maxBudgetUsd: 10,
    signal,
  }
}

function session(events: MetaAgentEvent[]): ForegroundDistillSession & { dispose: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn(async () => undefined)
  return {
    async *submit() { for (const event of events) yield event },
    interrupt() {},
    steer() { return false },
    getEstimatedCost() { return 0 },
    dispose,
  }
}

describe('ForegroundGraphDistillExecutor', () => {
  it('runs a directly-owned session, streams activity, and returns its structured text', async () => {
    const events: MetaAgentEvent[] = [
      { type: 'text', text: '{"graph":', sessionId: 'foreground' },
      { type: 'text', text: '{},"taskSpec":"ok"}', sessionId: 'foreground' },
      {
        type: 'result', subtype: 'success', sessionId: 'foreground', result: 'done', isError: false,
        durationMs: 1, numTurns: 1, stopReason: 'end_turn', totalCostUsd: 0.01,
        usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      },
    ]
    const direct = session(events)
    const seen: MetaAgentEvent[] = []
    const executor = new ForegroundGraphDistillExecutor({
      createSession: () => direct,
      onEvent: (_phase, event) => seen.push(event),
    })

    await expect(executor.execute(request())).resolves.toMatchObject({
      status: 'completed', output: '{"graph":{},"taskSpec":"ok"}',
    })
    expect(seen).toEqual(events)
    expect(direct.dispose).toHaveBeenCalledOnce()
  })

  it('surfaces a foreground terminal failure without manufacturing a child-task result', async () => {
    const direct = session([{
      type: 'result', subtype: 'error_max_budget', sessionId: 'foreground', result: '', isError: true,
      durationMs: 1, numTurns: 2, stopReason: null, totalCostUsd: 2,
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    }])
    const executor = new ForegroundGraphDistillExecutor({ createSession: () => direct })

    await expect(executor.execute(request())).resolves.toMatchObject({
      status: 'failed', error: 'foreground Distill session ended with error_max_budget',
    })
    expect(direct.dispose).toHaveBeenCalledOnce()
  })

  it('keeps a keyed compiler conversation alive across human review revisions', async () => {
    const events: MetaAgentEvent[] = [{
      type: 'result', subtype: 'success', sessionId: 'compiler', result: '{"ok":true}', isError: false,
      durationMs: 1, numTurns: 1, stopReason: 'end_turn', totalCostUsd: 0.01,
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    }]
    const direct = session(events)
    const createSession = vi.fn(() => direct)
    const executor = new ForegroundGraphDistillExecutor({ createSession })
    const keyed = { ...request(), sessionKey: 'distill-compiler' }

    await executor.execute(keyed)
    await executor.execute({ ...keyed, taskDescription: 'apply human feedback' })

    expect(createSession).toHaveBeenCalledOnce()
    expect(direct.dispose).not.toHaveBeenCalled()
    await executor.dispose()
    expect(direct.dispose).toHaveBeenCalledOnce()
  })

  it('lets the CLI drive the session through the shared agentic renderer', async () => {
    const direct = session([])
    const runSession = vi.fn(async () => ({ status: 'completed' as const, output: '{"graph":{}}' }))
    const executor = new ForegroundGraphDistillExecutor({ createSession: () => direct, runSession })

    await expect(executor.execute(request())).resolves.toMatchObject({ status: 'completed' })
    expect(runSession).toHaveBeenCalledWith(direct, expect.objectContaining({ phase: 'compiler' }))
    expect(direct.dispose).toHaveBeenCalledOnce()
  })

  it('preserves the phase timeout reason when a UI driver reports generic cancellation', async () => {
    let release: (() => void) | undefined
    const direct: ForegroundDistillSession = {
      async *submit() {},
      interrupt() { release?.() },
      steer() { return false },
      getEstimatedCost() { return 0 },
      async dispose() {},
    }
    const frozenGraph = { schemaVersion: 'graph-2.0', id: 'frozen-before-envelope' } as LoopGraphSpec
    const runSession = vi.fn((_session: ForegroundDistillSession, request: GraphDistillModelRequest) =>
      new Promise<{ status: 'cancelled'; error: string; validatedGraph: LoopGraphSpec }>(resolve => {
        release = () => resolve({ status: 'cancelled', error: 'Distill interrupted', validatedGraph: frozenGraph })
        request.signal.addEventListener('abort', () => release?.(), { once: true })
      }))
    const executor = new ForegroundGraphDistillExecutor({ createSession: () => direct, runSession })

    await expect(executor.execute({ ...request(), maxWallTimeMs: 10 })).resolves.toMatchObject({
      status: 'failed',
      error: 'foreground Distill compiler exceeded 10ms wall-time limit',
      validatedGraph: frozenGraph,
    })
  })

  it('interrupts a phase that exceeds its wall-time limit', async () => {
    let release: (() => void) | undefined
    const interrupt = vi.fn(() => release?.())
    const dispose = vi.fn(async () => undefined)
    const stalled: ForegroundDistillSession = {
      async *submit() {
        await new Promise<void>(resolve => { release = resolve })
      },
      interrupt,
      steer() { return false },
      getEstimatedCost() { return 0 },
      dispose,
    }
    const executor = new ForegroundGraphDistillExecutor({ createSession: () => stalled })

    await expect(executor.execute({ ...request(), maxWallTimeMs: 10 })).resolves.toMatchObject({
      status: 'failed',
      error: 'foreground Distill compiler exceeded 10ms wall-time limit',
    })
    expect(interrupt).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('replaces a keyed compiler session after a retryable phase timeout', async () => {
    const sessions: Array<ForegroundDistillSession & { dispose: ReturnType<typeof vi.fn> }> = []
    const createSession = vi.fn(() => {
      let release: (() => void) | undefined
      const created = session([])
      created.submit = async function *submit() {
        await new Promise<void>(resolve => { release = resolve })
      }
      created.interrupt = () => release?.()
      sessions.push(created)
      return created
    })
    const executor = new ForegroundGraphDistillExecutor({ createSession })
    const keyed = { ...request(), sessionKey: 'distill-compiler', maxWallTimeMs: 10 }

    await expect(executor.execute(keyed)).resolves.toMatchObject({ status: 'failed' })
    await expect(executor.execute(keyed)).resolves.toMatchObject({ status: 'failed' })

    expect(createSession).toHaveBeenCalledTimes(2)
    expect(sessions[0]!.dispose).toHaveBeenCalledOnce()
    expect(sessions[1]!.dispose).toHaveBeenCalledOnce()
  })

  it('preserves an actual caller cancellation', async () => {
    let release: (() => void) | undefined
    const stalled: ForegroundDistillSession = {
      async *submit() { await new Promise<void>(resolve => { release = resolve }) },
      interrupt() { release?.() }, steer() { return false }, getEstimatedCost() { return 0 }, async dispose() {},
    }
    const controller = new AbortController()
    const executor = new ForegroundGraphDistillExecutor({ createSession: () => stalled })
    const pending = executor.execute(request(controller.signal))
    controller.abort(new Error('operator stopped Distill'))

    await expect(pending).resolves.toMatchObject({ status: 'cancelled', error: 'operator stopped Distill' })
  })
})
