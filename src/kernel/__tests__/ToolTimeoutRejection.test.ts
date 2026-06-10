/**
 * Regression: a tool whose promise rejects AFTER the per-tool timeout fired
 * must never surface as an unhandledRejection — long-running hosts (the CLI)
 * treat unhandledRejection as fatal and exit the whole process.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { executeToolCall } from '../tools/ToolExecution.js'
import type { KernelTool, KernelToolContext } from '../types/KernelTool.js'
import { FileStateCache } from '../session/FileStateCache.js'

function makeContext(): KernelToolContext {
  return {
    sessionId: 'test',
    abortSignal: new AbortController().signal,
    readFileState: new FileStateCache(),
    messages: [],
    workspaceRoot: '/tmp',
    planMode: false,
  } as unknown as KernelToolContext
}

const allow = async () => ({ behavior: 'allow' as const })

describe('executeToolCall timeout race', () => {
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
})
