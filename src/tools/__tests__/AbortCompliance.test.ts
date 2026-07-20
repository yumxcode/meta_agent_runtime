import { describe, expect, it } from 'vitest'
import { createSleepTool } from '../system/sleep/index.js'
import { resolveToolAbortSupport } from '../../modes/toolAdapter.js'
import type { ToolCallContext } from '../../core/types.js'

describe('built-in abort compliance', () => {
  it('cooperative sleep settles promptly after AbortSignal', async () => {
    const tool = await createSleepTool()
    expect(resolveToolAbortSupport(tool)).toBe('cooperative')

    const controller = new AbortController()
    const startedAt = Date.now()
    const call = tool.call(
      { duration_ms: 60_000 },
      { abortSignal: controller.signal } as ToolCallContext,
    )
    controller.abort()

    await expect(call).rejects.toThrow('Sleep aborted')
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  it('unknown and non-cooperative tools are not auto-safe', () => {
    expect(resolveToolAbortSupport({ name: 'third_party_unknown' })).toBeUndefined()
    expect(resolveToolAbortSupport({ name: 'mcp_call' })).toBe('non_cooperative')
    // ask_user forwards ctx.abortSignal to the host prompt; a timeout cancels
    // the pending readline question instead of leaving a zombie prompt.
    expect(resolveToolAbortSupport({ name: 'ask_user' })).toBe('cooperative')
  })
})
