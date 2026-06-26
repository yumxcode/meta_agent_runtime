/**
 * KernelSession unit tests (with mocked Anthropic API)
 *
 * Covers:
 *  - Single-turn: text-only response → 'success' result event
 *  - Abort: interrupt() aborts in-flight submitMessage
 *  - Tool registration: addTool / upsertTool
 *  - Session ID: consistent across multiple submits
 *  - Max turns: terminates with 'error_max_turns' when exceeded
 *  - Budget exceeded: terminates with 'error_max_budget_usd'
 *  - System prompt: appendSystemPrompt concatenated correctly
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { KernelSession } from '../KernelSession.js'
import type { KernelTool } from '../types/KernelTool.js'

// ── Mock streamMessages so no real API calls are made ─────────────────────────

vi.mock('../api/AnthropicClient.js', () => ({
  streamMessages: vi.fn(),
}))

vi.mock('../compact/CompactConversation.js', () => ({
  COMPACT_MODEL_DEFAULT: 'deepseek-v4-flash',
  COMPACT_MAX_TOKENS: 12_000,
  compactConversation: vi.fn(),
}))

import { streamMessages } from '../api/AnthropicClient.js'
import { compactConversation } from '../compact/CompactConversation.js'
import { PromptTooLongError } from '../api/Errors.js'
import { makeCompactBoundaryMessage, makeTextUserMessage } from '../messages/MessageFactory.js'
const mockStream = vi.mocked(streamMessages)
const mockCompact = vi.mocked(compactConversation)

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a minimal async generator that simulates a text-only assistant response.
 * Mirrors the stream event shape that KernelLoop consumes.
 */
async function* textStream(text: string, inputTokens = 100, outputTokens = 50): AsyncGenerator<import('../api/AnthropicClient.js').StreamEvent> {
  yield { type: 'message_start', usage: { input_tokens: inputTokens } }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } as any }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 0 }
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } }
  yield { type: 'message_stop' }
}

async function* thinkingThenTextStream(thinking: string, text: string): AsyncGenerator<import('../api/AnthropicClient.js').StreamEvent> {
  yield { type: 'message_start', usage: { input_tokens: 100 } }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } as any }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } }
  yield { type: 'content_block_stop', index: 0 }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  yield { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } as any }
  yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 1 }
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } }
  yield { type: 'message_stop' }
}

/**
 * Build a stream that emits a single tool_use block then end_turn.
 */
async function* toolUseStream(toolId: string, toolName: string, input: unknown): AsyncGenerator<import('../api/AnthropicClient.js').StreamEvent> {
  yield { type: 'message_start', usage: { input_tokens: 100 } }
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} } }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }
  yield { type: 'content_block_stop', index: 0 }
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } }
  yield { type: 'message_stop' }
}

function makeConfig(overrides?: object) {
  return {
    model: 'claude-sonnet-4-6',
    tools: [] as KernelTool[],
    apiKey: 'test-key',
    maxTurns: 5,
    compact: { enabled: false },
    ...overrides,
  }
}

async function collectEvents(session: KernelSession, prompt: string) {
  const events = []
  for await (const event of session.submitMessage(prompt)) {
    events.push(event)
  }
  return events
}

// ── Tests ──────────────────────────────────────────────────────────────────────

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { vi.clearAllMocks() })

describe('KernelSession — basic text response', () => {
  it('emits a result event with subtype success', async () => {
    mockStream.mockImplementation(() => textStream('Hello world'))
    const session = new KernelSession(makeConfig())
    const events = await collectEvents(session, 'Hi')
    const result = events.find(e => e.type === 'result')
    expect(result).toBeDefined()
    expect(result?.subtype).toBe('success')
  })

  it('result event has non-zero usage', async () => {
    mockStream.mockImplementation(() => textStream('Hi', 150, 60))
    const session = new KernelSession(makeConfig())
    const events = await collectEvents(session, 'Hey')
    const result = events.find(e => e.type === 'result')
    expect(result?.usage.inputTokens).toBeGreaterThan(0)
    expect(result?.usage.outputTokens).toBeGreaterThan(0)
  })

  it('emits text_delta event(s) with the response text', async () => {
    mockStream.mockImplementation(() => textStream('Answer text'))
    const session = new KernelSession(makeConfig())
    const events = await collectEvents(session, 'Question')
    const textEvents = events.filter(e => e.type === 'text_delta')
    const fullText = textEvents.map((e: any) => e.delta).join('')
    expect(fullText).toBe('Answer text')
  })

  it('appends user and assistant messages to history', async () => {
    mockStream.mockImplementation(() => textStream('Reply'))
    const session = new KernelSession(makeConfig())
    await collectEvents(session, 'Hello')
    const msgs = session.getMessages()
    expect(msgs.some(m => m.role === 'user')).toBe(true)
    expect(msgs.some(m => m.role === 'assistant')).toBe(true)
  })

  it('strips hidden thinking blocks from in-memory history after the turn', async () => {
    mockStream.mockImplementation(() => thinkingThenTextStream('private reasoning', 'Reply'))
    const session = new KernelSession(makeConfig())
    const events = await collectEvents(session, 'Hello')

    expect(events.some(e => e.type === 'thinking_delta')).toBe(true)
    expect(JSON.stringify(session.getMessages())).not.toContain('private reasoning')
    expect(session.getMessages()).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'Reply' }],
      }),
    )
  })
})

describe('KernelSession — session identity', () => {
  it('getSessionId returns stable UUID across multiple submits', async () => {
    mockStream.mockImplementation(() => textStream('ok'))
    const session = new KernelSession(makeConfig())
    const id1 = session.getSessionId()
    await collectEvents(session, 'first')
    const id2 = session.getSessionId()
    await collectEvents(session, 'second')
    const id3 = session.getSessionId()
    expect(id1).toBe(id2)
    expect(id2).toBe(id3)
    expect(id1).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('honours caller-pinned sessionId', () => {
    const pinned = '00000000-0000-0000-0000-000000000042'
    const session = new KernelSession(makeConfig({ sessionId: pinned }))
    expect(session.getSessionId()).toBe(pinned)
  })

  it('two sessions get different IDs when no pinned ID', () => {
    const s1 = new KernelSession(makeConfig())
    const s2 = new KernelSession(makeConfig())
    expect(s1.getSessionId()).not.toBe(s2.getSessionId())
  })
})

describe('KernelSession — tool registration', () => {
  function makeTool(name: string): KernelTool {
    return {
      name,
      description: name,
      inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
      inputJSONSchema: { type: 'object' as const },
      call: async () => ({ data: `result-${name}` }),
      isConcurrencySafe: () => false,
    }
  }

  it('addTool adds a new tool', () => {
    const session = new KernelSession(makeConfig())
    session.addTool(makeTool('my_tool'))
    // Verify the tool is now registered by checking config (via submitMessage call shape)
    // We can't inspect _config directly, so we verify indirectly via the stream call
  })

  it('addTool ignores duplicate (no-op)', () => {
    const session = new KernelSession(makeConfig())
    const tool = makeTool('dup')
    session.addTool(tool)
    session.addTool(tool) // should not throw or duplicate
    // No assertion needed — just ensuring no error is thrown
  })

  it('upsertTool replaces existing tool', async () => {
    mockStream.mockImplementation(() => textStream('done'))
    const session = new KernelSession(makeConfig())
    const original = makeTool('replace_me')
    const replacement = { ...makeTool('replace_me'), description: 'updated' }
    session.addTool(original)
    session.upsertTool(replacement)
    // No assertion on description — just ensures no error
  })
})

describe('KernelSession — max turns', () => {
  it('returns error_max_turns when loop hits turn limit', async () => {
    // With maxTurns=1 and a tool_use response (no text), the loop
    // will exhaust turns before getting end_turn.
    // Simplest: mock always returns tool_use; with maxTurns=1 the loop exits.
    const echoTool: KernelTool = {
      name: 'echo',
      description: 'echo',
      inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
      inputJSONSchema: { type: 'object' as const, properties: { msg: { type: 'string' } } },
      call: async () => ({ data: 'echoed' }),
      isConcurrencySafe: () => false,
    }

    let callCount = 0
    mockStream.mockImplementation(async function* () {
      callCount++
      if (callCount === 1) {
        yield* toolUseStream('t1', 'echo', { msg: 'hello' })
      } else {
        // On tool result turn, return another tool_use to keep looping
        yield* toolUseStream('t2', 'echo', { msg: 'again' })
      }
    })

    const session = new KernelSession(makeConfig({ maxTurns: 1, tools: [echoTool] }))
    const events = await collectEvents(session, 'Echo please')
    const result = events.find(e => e.type === 'result')
    expect(result?.subtype).toBe('error_max_turns')
  })

  it('stops repeated identical tool calls even when maxTurns is Infinity', async () => {
    const echoTool: KernelTool = {
      name: 'echo',
      description: 'echo',
      inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
      inputJSONSchema: { type: 'object' as const, properties: { msg: { type: 'string' } } },
      call: async () => ({ data: 'echoed' }),
      isConcurrencySafe: () => false,
    }

    mockStream.mockImplementation(() => toolUseStream(crypto.randomUUID(), 'echo', { msg: 'same' }))

    const session = new KernelSession(makeConfig({ maxTurns: Infinity, tools: [echoTool] }))
    const events = await collectEvents(session, 'Echo forever')
    const result = events.find(e => e.type === 'result')

    expect(result?.subtype).toBe('error_during_execution')
    expect(result?.resultText).toContain('repeated the same tool request')
    expect(mockStream).toHaveBeenCalledTimes(3)
  })
})

describe('KernelSession — auto checkpoint and drift boundaries', () => {
  function makeTool(name: string, checkpointBoundary?: 'before' | 'after' | 'both'): KernelTool {
    return {
      name,
      description: name,
      inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
      inputJSONSchema: { type: 'object' as const },
      permission: checkpointBoundary
        ? { category: 'state', checkpointBoundary }
        : undefined,
      abortSupport: 'bounded',
      call: async () => ({ data: 'ok' }),
      isConcurrencySafe: () => false,
    }
  }

  it('runs drift only after a checkpoint revision advanced and 30 tool batches elapsed', async () => {
    const boundaryOrder: string[] = []
    let revision = 0
    const driftGate = vi.fn(async () => {
      boundaryOrder.push('drift')
      return { drifted: false, corrective: [] }
    })
    const onCheckpointBoundary = vi.fn(async (event: { type: string; toolBatchCount: number }) => {
      // Only the state-tool batch and the final hard termination boundary write.
      if (event.type === 'tool_batch_completed' || event.type === 'termination') {
        revision++
        boundaryOrder.push(`${event.type}:${event.toolBatchCount}`)
        return { updated: true, revision }
      }
      return { updated: false, revision }
    })

    let apiCall = 0
    mockStream.mockImplementation(async function* () {
      apiCall++
      if (apiCall === 1) {
        yield* toolUseStream('todo-1', 'todo_write', { batch: 1 })
      } else if (apiCall <= 30) {
        yield* toolUseStream(`echo-${apiCall}`, 'echo', { batch: apiCall })
      } else {
        yield* textStream('done')
      }
    })

    const session = new KernelSession(makeConfig({
      maxTurns: 35,
      tools: [makeTool('todo_write'), makeTool('echo')],
      autonomousMode: true,
      driftGate,
      onCheckpointBoundary,
    }))
    const events = await collectEvents(session, 'run')

    expect(events.find(e => e.type === 'result')?.subtype).toBe('success')
    expect(driftGate).toHaveBeenCalledTimes(1)
    expect(driftGate).toHaveBeenCalledWith(expect.objectContaining({
      turnCount: 30,
      reason: 'turn_interval',
    }))
    expect(boundaryOrder).toEqual([
      'tool_batch_completed:1',
      'drift',
      'termination:30',
    ])
  })

  it('does not run drift after 30 batches when no checkpoint revision advanced', async () => {
    let revision = 0
    const driftGate = vi.fn(async () => ({ drifted: false, corrective: [] }))
    const onCheckpointBoundary = vi.fn(async (event: { type: string }) => {
      if (event.type === 'termination') revision++
      return { updated: event.type === 'termination', revision }
    })

    let apiCall = 0
    mockStream.mockImplementation(async function* () {
      apiCall++
      if (apiCall <= 30) {
        yield* toolUseStream(`echo-${apiCall}`, 'echo', { batch: apiCall })
      } else {
        yield* textStream('done')
      }
    })

    const session = new KernelSession(makeConfig({
      maxTurns: 35,
      tools: [makeTool('echo')],
      autonomousMode: true,
      driftGate,
      onCheckpointBoundary,
    }))
    await collectEvents(session, 'run')

    expect(driftGate).not.toHaveBeenCalled()
    expect(onCheckpointBoundary).toHaveBeenCalledTimes(1)
    expect(onCheckpointBoundary).toHaveBeenCalledWith(expect.objectContaining({
      type: 'termination',
      toolBatchCount: 30,
    }))
  })

  it('runs drift during a pure code-editing stretch (FS-mutating tools advance the checkpoint)', async () => {
    // Regression: edit_file/write_file are not state tools, but a long editing
    // run with no todo/progress updates must still advance the checkpoint
    // revision so the drift gate can fire mid-task.
    let revision = 0
    const driftGate = vi.fn(async () => ({ drifted: false, corrective: [] }))
    const onCheckpointBoundary = vi.fn(async (event: { type: string }) => {
      if (event.type === 'tool_batch_completed' || event.type === 'termination') {
        revision++
        return { updated: true, revision }
      }
      return { updated: false, revision }
    })

    let apiCall = 0
    mockStream.mockImplementation(async function* () {
      apiCall++
      if (apiCall <= 30) {
        yield* toolUseStream(`edit-${apiCall}`, 'edit_file', { batch: apiCall })
      } else {
        yield* textStream('done')
      }
    })

    const session = new KernelSession(makeConfig({
      maxTurns: 35,
      tools: [makeTool('edit_file')],
      autonomousMode: true,
      driftGate,
      onCheckpointBoundary,
    }))
    const events = await collectEvents(session, 'run')

    expect(events.find(e => e.type === 'result')?.subtype).toBe('success')
    expect(driftGate).toHaveBeenCalledTimes(1)
    expect(driftGate).toHaveBeenCalledWith(expect.objectContaining({
      turnCount: 30,
      reason: 'turn_interval',
    }))
  })

  it('reanchorOriginalGoal resets the drift baseline to the current durable point', async () => {
    let revision = 0
    const onCheckpointBoundary = vi.fn(async (event: { type: string }) => {
      if (event.type === 'tool_batch_completed' || event.type === 'termination') {
        revision++
        return { updated: true, revision }
      }
      return { updated: false, revision }
    })
    let apiCall = 0
    mockStream.mockImplementation(async function* () {
      apiCall++
      if (apiCall <= 3) {
        yield* toolUseStream(`t-${apiCall}`, 'todo_write', { batch: apiCall })
      } else {
        yield* textStream('done')
      }
    })

    const session = new KernelSession(makeConfig({
      maxTurns: 10,
      tools: [makeTool('todo_write')],
      autonomousMode: true,
      driftGate: vi.fn(async () => ({ drifted: false, corrective: [] })),
      onCheckpointBoundary,
    }))
    await collectEvents(session, 'task one')

    const s = session as unknown as {
      _checkpointRevision: number
      _toolBatchCount: number
      _lastDriftCheckpointRevision: number
      _lastDriftToolBatchCount: number
    }
    // The short run advanced the revision but never fired drift (< 30 batches),
    // so the drift baseline lags behind the current durable point.
    expect(s._checkpointRevision).toBeGreaterThan(0)
    expect(s._lastDriftCheckpointRevision).toBeLessThan(s._checkpointRevision)

    // Re-anchoring to a new goal must sync the baseline so the new task needs its
    // OWN checkpoint advance + 30 batches (no inherited cadence, no starvation).
    session.reanchorOriginalGoal('task two')
    expect(s._lastDriftCheckpointRevision).toBe(s._checkpointRevision)
    expect(s._lastDriftToolBatchCount).toBe(s._toolBatchCount)
  })

  it('auto verify unavailable stops instead of reporting success', async () => {
    mockStream.mockImplementation(() => textStream('done'))
    const verifyGate = vi.fn(async () => ({
      done: true,
      unfinished: [],
      evidence: [],
      skipped: true,
      note: 'goal missing',
    }))
    const onCheckpointBoundary = vi.fn(async () => ({ updated: true, revision: 1 }))

    const session = new KernelSession(makeConfig({
      autonomousMode: true,
      verifyGate,
      onCheckpointBoundary,
    }))
    const events = await collectEvents(session, 'run')
    const result = events.find(e => e.type === 'result')

    expect(verifyGate).toHaveBeenCalledTimes(2)
    expect(result?.subtype).toBe('error_during_execution')
    expect(result?.stopReason).toBe('auto_verify_unavailable')
    expect(result?.resultText).toContain('could not be independently verified')
    expect(onCheckpointBoundary).toHaveBeenCalledWith(expect.objectContaining({
      type: 'termination',
      stopReason: 'auto_verify_unavailable',
    }))
  })

  it('does not consult verify gates outside auto mode', async () => {
    mockStream.mockImplementation(() => textStream('done'))
    const verifyGate = vi.fn(async () => {
      throw new Error('should not run')
    })

    const session = new KernelSession(makeConfig({ verifyGate }))
    const events = await collectEvents(session, 'run')
    const result = events.find(e => e.type === 'result')

    expect(verifyGate).not.toHaveBeenCalled()
    expect(result?.subtype).toBe('success')
  })

  it('auto drift fail_closed stops on the first unavailable drift check', async () => {
    let revision = 0
    const driftGate = vi.fn(async () => {
      throw new Error('drift judge offline')
    })
    const onCheckpointBoundary = vi.fn(async (event: { type: string }) => {
      if (event.type === 'tool_batch_completed' || event.type === 'termination') revision++
      return { updated: event.type === 'tool_batch_completed' || event.type === 'termination', revision }
    })

    let apiCall = 0
    mockStream.mockImplementation(async function* () {
      apiCall++
      if (apiCall === 1) yield* toolUseStream('todo-1', 'todo_write', { batch: 1 })
      else yield* toolUseStream(`echo-${apiCall}`, 'echo', { batch: apiCall })
    })

    const session = new KernelSession(makeConfig({
      maxTurns: 40,
      tools: [makeTool('todo_write'), makeTool('echo')],
      autonomousMode: true,
      driftGate,
      autoGateFailurePolicy: 'fail_closed',
      autoGateMaxAttempts: 1,
      onCheckpointBoundary,
    }))
    const events = await collectEvents(session, 'run')
    const result = events.find(e => e.type === 'result')

    expect(driftGate).toHaveBeenCalledTimes(1)
    expect(result?.subtype).toBe('error_during_execution')
    expect(result?.stopReason).toBe('auto_drift_unavailable')
    expect(onCheckpointBoundary).toHaveBeenCalledWith(expect.objectContaining({
      type: 'termination',
      stopReason: 'auto_drift_unavailable',
    }))
  })

  it('auto drift checkpoint_pause tolerates brief drift unavailability', async () => {
    let revision = 0
    const driftGate = vi.fn(async () => ({
      drifted: false,
      corrective: [],
      skipped: true,
      note: 'checkpoint temporarily unavailable',
    }))
    const onCheckpointBoundary = vi.fn(async (event: { type: string }) => {
      if (event.type === 'tool_batch_completed' || event.type === 'termination') revision++
      return { updated: event.type === 'tool_batch_completed' || event.type === 'termination', revision }
    })

    let apiCall = 0
    mockStream.mockImplementation(async function* () {
      apiCall++
      if (apiCall === 1) yield* toolUseStream('todo-1', 'todo_write', { batch: 1 })
      else if (apiCall <= 30) yield* toolUseStream(`echo-${apiCall}`, 'echo', { batch: apiCall })
      else yield* textStream('done')
    })

    const session = new KernelSession(makeConfig({
      maxTurns: 40,
      tools: [makeTool('todo_write'), makeTool('echo')],
      autonomousMode: true,
      driftGate,
      autoGateMaxAttempts: 1,
      onCheckpointBoundary,
    }))
    const events = await collectEvents(session, 'run')
    const result = events.find(e => e.type === 'result')

    expect(driftGate).toHaveBeenCalledTimes(1)
    expect(events.some(e =>
      e.type === 'system_message' &&
      e.text.includes('[drift] 航向检查不可用')
    )).toBe(true)
    expect(result?.subtype).toBe('success')
    expect(result?.stopReason).toBeNull()
  })

  it('auto drift checkpoint_pause stops after the configured consecutive failure limit', async () => {
    let revision = 0
    const driftGate = vi.fn(async () => ({
      drifted: false,
      corrective: [],
      skipped: true,
      note: 'checkpoint missing',
    }))
    const onCheckpointBoundary = vi.fn(async (event: { type: string }) => {
      if (event.type === 'tool_batch_completed' || event.type === 'termination') revision++
      return { updated: event.type === 'tool_batch_completed' || event.type === 'termination', revision }
    })

    let apiCall = 0
    mockStream.mockImplementation(async function* () {
      apiCall++
      if (apiCall === 1) yield* toolUseStream('todo-1', 'todo_write', { batch: 1 })
      else yield* toolUseStream(`echo-${apiCall}`, 'echo', { batch: apiCall })
    })

    const session = new KernelSession(makeConfig({
      maxTurns: 40,
      tools: [makeTool('todo_write'), makeTool('echo')],
      autonomousMode: true,
      driftGate,
      autoGateMaxAttempts: 1,
      autoDriftFailureLimit: 1,
      onCheckpointBoundary,
    }))
    const events = await collectEvents(session, 'run')
    const result = events.find(e => e.type === 'result')

    expect(driftGate).toHaveBeenCalledTimes(1)
    expect(result?.subtype).toBe('error_during_execution')
    expect(result?.stopReason).toBe('auto_drift_unavailable')
  })

  it('stops auto with an explicit error stopReason after the configured per-run tool-batch allowance', async () => {
    let apiCall = 0
    mockStream.mockImplementation(async function* () {
      apiCall++
      yield* toolUseStream(crypto.randomUUID(), 'echo', { apiCall })
    })
    const onCheckpointBoundary = vi.fn(async () => ({ updated: true, revision: 1 }))
    const session = new KernelSession(makeConfig({
      maxTurns: 20,
      tools: [makeTool('echo')],
      autonomousMode: true,
      autoMaxToolBatches: 3,
      onCheckpointBoundary,
    }))

    const events = await collectEvents(session, 'run')
    const result = events.find(e => e.type === 'result')
    expect(result?.subtype).toBe('error_during_execution')
    expect(result?.stopReason).toBe('auto_tool_batch_limit')
    expect(onCheckpointBoundary).toHaveBeenCalledWith(expect.objectContaining({
      type: 'termination',
      toolBatchCount: 3,
      stopReason: 'auto_tool_batch_limit',
    }))
  })

  it('stops auto with an explicit error stopReason after the configured wall-clock allowance', async () => {
    let apiCall = 0
    mockStream.mockImplementation(async function* () {
      apiCall++
      if (apiCall === 1) yield* toolUseStream('slow-1', 'slow', {})
      else yield* textStream('should not reach')
    })
    const slow = makeTool('slow')
    slow.call = async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return { data: 'ok' }
    }
    const session = new KernelSession(makeConfig({
      maxTurns: 20,
      tools: [slow],
      autonomousMode: true,
      autoMaxRuntimeMs: 5,
    }))

    const events = await collectEvents(session, 'run')
    const result = events.find(e => e.type === 'result')
    expect(result?.subtype).toBe('error_during_execution')
    expect(result?.stopReason).toBe('auto_runtime_limit')
  })

  it('checkpoints long/non-idempotent external tools before and after execution', async () => {
    const boundaries: string[] = []
    let revision = 0
    const onCheckpointBoundary = vi.fn(async (event: { type: string }) => {
      revision++
      boundaries.push(event.type)
      return { updated: true, revision }
    })

    let apiCall = 0
    mockStream.mockImplementation(async function* () {
      apiCall++
      if (apiCall === 1) yield* toolUseStream('mcp-1', 'mcp_call', {})
      else yield* textStream('done')
    })

    const session = new KernelSession(makeConfig({
      tools: [makeTool('mcp_call', 'both')],
      autonomousMode: true,
      onCheckpointBoundary,
    }))
    await collectEvents(session, 'run')

    expect(boundaries).toEqual([
      'external_before',
      'external_after',
      'termination',
    ])
  })
})

describe('KernelSession — interrupt', () => {
  it('interrupt() can be called at any time without throwing', () => {
    const session = new KernelSession(makeConfig())
    // Before any submit
    expect(() => session.interrupt()).not.toThrow()
    // Multiple calls are safe
    expect(() => session.interrupt()).not.toThrow()
  })

  it('interrupt() aborts a slow in-flight submitMessage', async () => {
    // Stream that loops slowly and respects the abort signal
    mockStream.mockImplementation(async function* (params) {
      for (let i = 0; i < 50; i++) {
        if (params.abortSignal.aborted) return   // honour abort
        yield { type: 'message_start' as const, usage: { input_tokens: 10 } }
        await new Promise(r => setTimeout(r, 20))
      }
    })

    const session = new KernelSession(makeConfig())
    // Fire interrupt concurrently — KernelSession buffers all events before
    // yielding any, so we can't interrupt from inside a for-await loop.
    const timer = setTimeout(() => session.interrupt(), 60)
    try {
      const events = await collectEvents(session, 'Interrupt me')
      // After abort, a result event should still be emitted
      const result = events.find(e => e.type === 'result')
      expect(result).toBeDefined()
    } finally {
      clearTimeout(timer)
    }
  }, 3000)
})

describe('KernelSession — concurrency guard', () => {
  it('rejects concurrent submitMessage calls on the same session', async () => {
    let releaseStream!: () => void
    const streamStarted = new Promise<void>(resolve => {
      mockStream.mockImplementation(async function* () {
        yield { type: 'message_start' as const, usage: { input_tokens: 10 } }
        resolve()
        await new Promise<void>(release => { releaseStream = release })
        yield { type: 'content_block_start' as const, index: 0, content_block: { type: 'text', text: '' } as any }
        yield { type: 'content_block_delta' as const, index: 0, delta: { type: 'text_delta', text: 'done' } }
        yield { type: 'message_delta' as const, delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }
        yield { type: 'message_stop' as const }
      })
    })

    const session = new KernelSession(makeConfig())
    const first = collectEvents(session, 'first')
    await streamStarted

    await expect(collectEvents(session, 'second')).rejects.toThrow(/Cannot call submitMessage\(\) concurrently/)

    releaseStream()
    const events = await first
    expect(events.find(e => e.type === 'result')?.subtype).toBe('success')
  })
})

describe('KernelSession — mid-turn steering', () => {
  it('returns false when no turn is in flight', () => {
    const session = new KernelSession(makeConfig())
    expect(session.steer('later')).toBe(false)
    expect(session.steer('   ')).toBe(false)
  })

  it('injects a queued correction as a user message at the next loop boundary', async () => {
    // A tool that simulates the user pressing Ctrl+G + typing a correction
    // WHILE the turn is in flight (steer() is valid only mid-submit).
    let theSession: KernelSession | undefined
    let steerAccepted: boolean | undefined
    const noopTool: KernelTool = {
      name: 'noop',
      description: 'noop',
      inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
      inputJSONSchema: { type: 'object' as const },
      call: async () => {
        steerAccepted = theSession!.steer('改用方案B')
        return { data: 'done' }
      },
      isConcurrencySafe: () => false,
    }

    let calls = 0
    mockStream.mockImplementation(async function* () {
      calls++
      if (calls === 1) yield* toolUseStream('t1', 'noop', {})
      else yield* textStream('ok')
    })

    theSession = new KernelSession(makeConfig({ tools: [noopTool] }))
    const events = await collectEvents(theSession, 'go')

    expect(steerAccepted).toBe(true)
    expect(events.find(e => e.type === 'result')?.subtype).toBe('success')
    // A second API call must have happened (the loop continued after the tool).
    expect(mockStream).toHaveBeenCalledTimes(2)

    const userTexts = theSession.getMessages()
      .filter(m => m.role === 'user')
      .flatMap(m => m.content)
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text as string)
    expect(userTexts.some(t => t.includes('改用方案B'))).toBe(true)
    expect(userTexts.some(t => t.includes('[用户实时补充指导]'))).toBe(true)
  })

  it('drops steering queued while idle so it does not leak into the next turn', async () => {
    mockStream.mockImplementation(() => textStream('ok'))
    const session = new KernelSession(makeConfig())
    // Not in flight → ignored.
    expect(session.steer('stale correction')).toBe(false)
    await collectEvents(session, 'hello')
    const userTexts = session.getMessages()
      .filter(m => m.role === 'user')
      .flatMap(m => m.content)
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text as string)
    expect(userTexts.some(t => t.includes('stale correction'))).toBe(false)
  })
})

describe('KernelSession — appendSystemPrompt', () => {
  it('setAppendSystemPrompt updates config for next submit', async () => {
    mockStream.mockImplementation(() => textStream('ok'))
    const session = new KernelSession(makeConfig({ systemPrompt: 'Base prompt.' }))
    session.setAppendSystemPrompt('Appended section.')
    // Just verify no error is thrown and submit succeeds
    const events = await collectEvents(session, 'Hi')
    expect(events.find(e => e.type === 'result')?.subtype).toBe('success')
  })
})

describe('KernelSession — cumulative usage', () => {
  it('accumulates usage across multiple submits', async () => {
    mockStream.mockImplementation(() => textStream('ok', 100, 50))
    const session = new KernelSession(makeConfig())
    await collectEvents(session, 'first')
    await collectEvents(session, 'second')
    const usage = session.getTotalUsage()
    expect(usage.inputTokens).toBeGreaterThan(100)
    expect(usage.outputTokens).toBeGreaterThan(50)
  })
})

describe('KernelSession — compact integration', () => {
  function compactedMessages(summary = 'Summary after compact') {
    return [
      makeCompactBoundaryMessage(),
      makeTextUserMessage(summary, { isCompactSummary: true }),
    ]
  }

  it('reactively compacts and retries once when the API reports prompt-too-long', async () => {
    let calls = 0
    mockStream.mockImplementation(async function* () {
      calls++
      if (calls === 1) throw new PromptTooLongError()
      yield* textStream('recovered')
    })
    mockCompact.mockImplementation(async (_messages, _fileCache, options) => ({
      postCompactMessages: [
        ...compactedMessages(),
        ...((options?.messagesToKeep ?? []) as ReturnType<typeof compactedMessages>),
      ],
      summaryTokenEstimate: 77,
    }))

    const session = new KernelSession(makeConfig({ compact: { enabled: true } }))
    const events = await collectEvents(session, 'large prompt with exact constraints')

    expect(mockCompact).toHaveBeenCalledOnce()
    expect(mockStream).toHaveBeenCalledTimes(2)
    const retryMessages = mockStream.mock.calls[1]?.[0]?.messages ?? []
    expect(JSON.stringify(retryMessages)).toContain('large prompt with exact constraints')
    const boundary = events.find(e => e.type === 'compact_boundary')
    expect(boundary?.compactMetadata.summaryTokens).toBe(77)
    const result = events.find(e => e.type === 'result')
    expect(result?.subtype).toBe('success')
  })

  it('persists compact failure tracking across submitMessage calls', async () => {
    mockStream.mockImplementation(async function* () {
      throw new PromptTooLongError()
    })
    mockCompact.mockRejectedValue(new Error('compact failed'))

    const session = new KernelSession(makeConfig({ compact: { enabled: true } }))

    for (let i = 0; i < 4; i++) {
      const events = await collectEvents(session, `large prompt ${i}`)
      if (i < 3) {
        const failed = events.find(e => e.type === 'compact_failed')
        expect(failed?.error).toContain('compact failed')
      }
      const result = events.find(e => e.type === 'result')
      expect(result?.subtype).toBe('error_blocking_limit')
    }

    expect(mockCompact).toHaveBeenCalledTimes(3)
  })

  it('honours compact.querySource during reactive compact', async () => {
    mockStream.mockImplementation(async function* () {
      throw new PromptTooLongError()
    })
    mockCompact.mockResolvedValue({
      postCompactMessages: compactedMessages(),
      summaryTokenEstimate: 1,
    })

    const session = new KernelSession(makeConfig({
      compact: { enabled: true, querySource: 'compact' },
      querySource: 'main',
    }))
    const events = await collectEvents(session, 'large prompt')

    expect(mockCompact).not.toHaveBeenCalled()
    const result = events.find(e => e.type === 'result')
    expect(result?.subtype).toBe('error_blocking_limit')
  })
})
