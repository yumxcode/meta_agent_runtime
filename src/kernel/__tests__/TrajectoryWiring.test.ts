import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KernelSession } from '../KernelSession.js'
import type { StreamEvent } from '../api/AnthropicClient.js'
import type { KernelTool } from '../types/KernelTool.js'
import { listTrajectoryIndex } from '../../trajectory/indexStore.js'
import { trajectoryFile } from '../../trajectory/paths.js'
import { readTrajectory } from '../../trajectory/reader.js'

vi.mock('../api/AnthropicClient.js', () => ({ streamMessages: vi.fn() }))
vi.mock('../compact/CompactConversation.js', () => ({
  COMPACT_MODEL_DEFAULT: 'test-compact',
  COMPACT_MAX_TOKENS: 12_000,
  compactConversation: vi.fn(),
}))

import { streamMessages } from '../api/AnthropicClient.js'

const mockStream = vi.mocked(streamMessages)

async function* textStream(text: string): AsyncGenerator<StreamEvent> {
  yield { type: 'message_start', usage: { input_tokens: 10 } }
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } as never }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 0 }
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }
  yield { type: 'message_stop' }
}

async function* toolStream(): AsyncGenerator<StreamEvent> {
  yield { type: 'message_start', usage: { input_tokens: 10 } }
  yield {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'tool-1', name: 'bash', input: {} },
  }
  yield {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"}' },
  }
  yield { type: 'content_block_stop', index: 0 }
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }
  yield { type: 'message_stop' }
}

beforeEach(() => vi.clearAllMocks())

describe('KernelSession A3 dual-write', () => {
  it('records run, canonical messages, structured tool evidence and result without replacing history', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'kernel-trajectory-'))
    let calls = 0
    mockStream.mockImplementation(() => (++calls === 1 ? toolStream() : textStream('done')))
    const tool: KernelTool = {
      name: 'bash',
      description: 'test shell',
      inputSchema: { safeParse: input => ({ success: true, data: input }) },
      inputJSONSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      call: async () => ({
        data: 'tests passed',
        isError: false,
        execution: {
          command: 'npm test',
          cwd: '/workspace',
          exitCode: 0,
          timedOut: false,
          aborted: false,
        },
        trajectoryItems: [{
          type: 'knowledge',
          kind: 'experience',
          action: 'recalled',
          entryIds: ['exp-structured-1'],
          operation: 'recall',
        }],
      }),
      isConcurrencySafe: () => false,
    }
    const session = new KernelSession({
      apiKey: 'test-key',
      model: 'test-model',
      cwd: '/workspace',
      tools: [tool],
      compact: { enabled: false },
      trajectory: { enabled: true, mode: 'agentic', rootDir },
    })

    const events = []
    for await (const event of session.submitMessage('run the tests')) events.push(event)
    expect(events.at(-1)?.type).toBe('result')
    expect(session.getMessages().length).toBeGreaterThanOrEqual(4)

    const index = await listTrajectoryIndex({ rootDir })
    expect(index).toHaveLength(1)
    const lines = await readTrajectory(trajectoryFile(index[0]!.trajectoryId, { rootDir }))
    expect(lines.map(line => line.item.type)).toEqual(expect.arrayContaining([
      'trajectory_meta', 'run_started', 'turn_context', 'message', 'approval', 'tool_outcome', 'run_result',
      'knowledge',
    ]))
    const outcome = lines.find(line => line.item.type === 'tool_outcome')?.item
    expect(outcome).toMatchObject({
      type: 'tool_outcome',
      command: 'npm test',
      cwd: '/workspace',
      exitCode: 0,
      timedOut: false,
    })
    expect(lines.find(line => line.item.type === 'knowledge')?.item).toMatchObject({
      entryIds: ['exp-structured-1'],
      operation: 'recall',
    })
    expect(session.isTrajectoryPersistenceDegraded()).toBe(false)
    session.dispose()
  })

  it('closes a run exactly once when the event consumer abandons the generator', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'kernel-trajectory-abandoned-'))
    mockStream.mockImplementation(() => textStream('partial answer'))
    const session = new KernelSession({
      apiKey: 'test-key',
      model: 'test-model',
      cwd: '/workspace',
      tools: [],
      compact: { enabled: false },
      trajectory: { enabled: true, mode: 'agentic', rootDir },
    })
    const generator = session.submitMessage('start')
    await generator.next()
    await generator.return(undefined)

    const [entry] = await listTrajectoryIndex({ rootDir })
    const lines = await readTrajectory(trajectoryFile(entry!.trajectoryId, { rootDir }))
    const starts = lines.filter(line => line.item.type === 'run_started')
    const results = lines.filter(line => line.item.type === 'run_result')
    expect(starts).toHaveLength(1)
    expect(results).toHaveLength(1)
    expect(results[0]?.item).toMatchObject({ outcome: 'abandoned', isError: true })
    expect(results[0]?.runId).toBe(starts[0]?.runId)
    session.dispose()
  })

  it('records an auto checkpoint reference without copying checkpoint state', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'kernel-trajectory-checkpoint-'))
    mockStream.mockImplementation(() => textStream('done'))
    const session = new KernelSession({
      apiKey: 'test-key',
      model: 'test-model',
      cwd: '/workspace',
      tools: [],
      autonomousMode: true,
      compact: { enabled: false },
      trajectory: { enabled: true, mode: 'auto', rootDir },
      onCheckpointBoundary: async () => ({
        updated: true,
        revision: 7,
        checkpoint: {
          mode: 'auto',
          stateSchemaVersion: '1.1',
          contentHash: 'checkpoint-hash',
          storeRef: '/workspace/.meta-agent/auto/checkpoints/session.json',
        },
      }),
    })
    for await (const _event of session.submitMessage('finish')) { /* consume */ }
    const [entry] = await listTrajectoryIndex({ rootDir })
    const lines = await readTrajectory(trajectoryFile(entry!.trajectoryId, { rootDir }))
    expect(lines.find(line => line.item.type === 'state_checkpoint')?.item).toMatchObject({
      revision: 7,
      contentHash: 'checkpoint-hash',
      storeRef: '/workspace/.meta-agent/auto/checkpoints/session.json',
    })
    expect(JSON.stringify(lines)).not.toContain('completedSteps')
    session.dispose()
  })
})
