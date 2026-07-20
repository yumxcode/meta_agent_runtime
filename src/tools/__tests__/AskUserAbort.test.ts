import { describe, expect, it } from 'vitest'
import { createAskUserTool } from '../ui/ask_user/index.js'
import type { ToolCallContext } from '../../core/types.js'

function context(overrides: Partial<ToolCallContext>): ToolCallContext {
  return {
    sessionId: 'test',
    workspaceRoot: process.cwd(),
    toolNames: new Set<string>(),
    abortSignal: new AbortController().signal,
    ...overrides,
  } as ToolCallContext
}

describe('ask_user abort propagation', () => {
  it('forwards the tool abort signal to the host prompt so a timeout can cancel it', async () => {
    const tool = await createAskUserTool()
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const result = await tool.call({ question: 'Pick one', options: ['a', 'b'] }, context({
      abortSignal: controller.signal,
      askUser: async (_question, _options, signal) => {
        received = signal
        return 'a'
      },
    }))
    expect(received).toBe(controller.signal)
    expect(result.isError).toBe(false)
    expect(result.content).toBe('a')
  })

  it('settles with an error result when the prompt is cancelled instead of leaving a zombie question', async () => {
    const tool = await createAskUserTool()
    const controller = new AbortController()
    const pending = tool.call({ question: 'Never answered' }, context({
      abortSignal: controller.signal,
      askUser: (_question, _options, signal) => new Promise<string>((_resolve, reject) => {
        if (signal?.aborted) { reject(new Error('interactive input timed out or was cancelled')); return }
        signal?.addEventListener('abort', () => reject(new Error('interactive input timed out or was cancelled')), { once: true })
      }),
    }))
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toContain('timed out or was cancelled')
  })

  it('declares cooperative abort support so the kernel timeout actually cancels it', async () => {
    const tool = await createAskUserTool()
    expect(tool.abortSupport).toBe('cooperative')
  })
})
