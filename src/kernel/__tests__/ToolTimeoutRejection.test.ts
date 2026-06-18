/**
 * Regression: a tool whose promise rejects AFTER the per-tool timeout fired
 * must never surface as an unhandledRejection — long-running hosts (the CLI)
 * treat unhandledRejection as fatal and exit the whole process.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  clearTimedOutRunningTools,
  executeToolCall,
  getTimedOutRunningToolCount,
} from '../tools/ToolExecution.js'
import type { KernelTool, KernelToolContext } from '../types/KernelTool.js'
import { FileStateCache } from '../session/FileStateCache.js'

function makeContext(autonomousMode = false): KernelToolContext {
  return {
    sessionId: 'test',
    abortSignal: new AbortController().signal,
    readFileState: new FileStateCache(),
    messages: [],
    workspaceRoot: '/tmp',
    planMode: false,
    autonomousMode,
  } as unknown as KernelToolContext
}

const allow = async () => ({ behavior: 'allow' as const })

describe('executeToolCall timeout race', () => {
  afterEach(() => {
    clearTimedOutRunningTools('test')
    delete process.env['META_AGENT_MAX_TIMED_OUT_RUNNING_TOOLS']
  })

  it('returns a timeout error result and absorbs the late rejection', async () => {
    const lateRejections: unknown[] = []
    const onUnhandled = (reason: unknown) => { lateRejections.push(reason) }
    process.on('unhandledRejection', onUnhandled)

    try {
      const slowFailingTool: KernelTool = {
        name: 'slow_fail',
        description: 'rejects 50ms after being called',
        inputSchema: z.object({}),
        inputJSONSchema: { type: 'object' },
        isConcurrencySafe: () => true,
        timeoutMs: 10,
        call: () =>
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('late network failure')), 50),
          ),
      } as unknown as KernelTool

      const result = await executeToolCall(
        { toolUseId: 'tu1', toolName: 'slow_fail', input: {}, assistantMessageUuid: 'a1' },
        slowFailingTool,
        makeContext(),
        allow,
      )

      // The race resolves with the timeout error result…
      const block = result.resultMessage.content[0] as { content: string; is_error?: boolean }
      expect(block.is_error).toBe(true)
      expect(block.content).toContain('timed out')

      // …and the loser's later rejection must be observed (no unhandledRejection).
      await new Promise(resolve => setTimeout(resolve, 100))
      await vi.waitFor(() => expect(lateRejections).toHaveLength(0))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('opens the auto circuit when timed-out calls remain alive', async () => {
    process.env['META_AGENT_MAX_TIMED_OUT_RUNNING_TOOLS'] = '2'
    const releases: Array<() => void> = []
    const stuckTool: KernelTool = {
      name: 'stuck',
      description: 'waits until released',
      abortSupport: 'cooperative',
      inputSchema: z.object({}),
      inputJSONSchema: { type: 'object' },
      isConcurrencySafe: () => false,
      timeoutMs: 5,
      call: () => new Promise<void>(resolve => releases.push(resolve))
        .then(() => ({ data: 'done' })),
    }
    const context = makeContext(true)

    for (const id of ['one', 'two']) {
      const result = await executeToolCall(
        { toolUseId: id, toolName: 'stuck', input: {}, assistantMessageUuid: 'a1' },
        stuckTool,
        context,
        allow,
      )
      expect((result.resultMessage.content[0] as { is_error?: boolean }).is_error).toBe(true)
    }
    expect(getTimedOutRunningToolCount('test')).toBe(2)

    const blocked = await executeToolCall(
      { toolUseId: 'three', toolName: 'stuck', input: {}, assistantMessageUuid: 'a1' },
      stuckTool,
      context,
      allow,
    )
    expect((blocked.resultMessage.content[0] as { content: string }).content)
      .toContain('circuit open')

    releases.forEach(release => release())
    await vi.waitFor(() => expect(getTimedOutRunningToolCount('test')).toBe(0))
  })

  it('requires an auto-safe abort declaration', async () => {
    const undeclared: KernelTool = {
      name: 'external_tool',
      description: 'no abort contract',
      inputSchema: z.object({}),
      inputJSONSchema: { type: 'object' },
      isConcurrencySafe: () => false,
      call: async () => ({ data: 'should not run' }),
    }
    const result = await executeToolCall(
      { toolUseId: 'tu', toolName: 'external_tool', input: {}, assistantMessageUuid: 'a1' },
      undeclared,
      makeContext(true),
      allow,
    )
    expect((result.resultMessage.content[0] as { content: string }).content)
      .toContain('undeclared')
  })
})
