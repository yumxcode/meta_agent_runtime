import { describe, expect, it } from 'vitest'
import { FileStateCache } from '../session/FileStateCache.js'
import type { KernelTool } from '../types/KernelTool.js'
import { defaultCanUseTool } from '../permissions/CanUseTool.js'
import { runTools } from '../tools/ToolOrchestration.js'

function tool(
  name: string,
  call: KernelTool['call'],
  safe = false,
): KernelTool {
  return {
    name,
    description: name,
    abortSupport: 'bounded',
    inputSchema: { safeParse: input => ({ success: true, data: input }) },
    inputJSONSchema: { type: 'object' },
    isConcurrencySafe: () => safe,
    call,
  }
}

describe('tool park control', () => {
  it('stops later serial calls and fills skipped tool results', async () => {
    const calls: string[] = []
    const tools = [
      tool('before', async () => {
        calls.push('before')
        return { data: 'before ok' }
      }),
      tool('self_timer', async () => {
        calls.push('self_timer')
        return {
          data: 'park',
          control: { kind: 'park', afterMs: 1_000, reason: 'wait' },
        }
      }),
      tool('after', async () => {
        calls.push('after')
        return { data: 'must not run' }
      }),
    ]
    const requests = tools.map((value, index) => ({
      toolUseId: `tool-${index}`,
      toolName: value.name,
      input: {},
      assistantMessageUuid: 'assistant-1',
    }))
    const result = await runTools(
      requests,
      tools,
      {
        sessionId: 'session-1',
        abortSignal: new AbortController().signal,
        readFileState: new FileStateCache(),
        messages: [],
      },
      defaultCanUseTool,
    )

    expect(calls).toEqual(['before', 'self_timer'])
    expect(result.control).toEqual({
      kind: 'park',
      afterMs: 1_000,
      reason: 'wait',
    })
    expect(result.toolResultMessages).toHaveLength(3)
    expect(JSON.stringify(result.toolResultMessages[2])).toContain('Skipped')
    // L1: the notice names the tool that actually stopped the batch rather
    // than hard-coding self_timer for every control kind.
    expect(JSON.stringify(result.toolResultMessages[2])).toContain('self_timer')
    expect(JSON.stringify(result.toolResultMessages[2])).toContain('parked the session')
  })
})
