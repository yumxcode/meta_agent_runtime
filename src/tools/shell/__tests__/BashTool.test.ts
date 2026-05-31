import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBashTool } from '../bash/index.js'
import type { ToolCallContext } from '../../../core/types.js'

function makeCtx(workspaceRoot: string): ToolCallContext {
  return {
    sessionId: 'test',
    agentId: 'test',
    abortSignal: new AbortController().signal,
    workspaceRoot,
  } as unknown as ToolCallContext
}

describe('bash tool — regression fixes (H4 / H5)', () => {
  it('H4: rejects/clamps NaN / Infinity / negative timeout_ms without hanging', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bash-test-'))
    const tool = await createBashTool()
    // Use a fast-completing command so the test never depends on a real timeout.
    const start = Date.now()
    const result = await tool.call(
      { command: 'echo hi', cwd: dir, timeout_ms: NaN },
      makeCtx(dir),
    )
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(result.isError).toBe(false)
    expect(String(result.content)).toContain('hi')
  })

  it('H5: filtered env policy strips API_KEY / TOKEN variables', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bash-test-'))
    const prevAnthropic = process.env['ANTHROPIC_API_KEY']
    const prevGh = process.env['GH_TOKEN']
    process.env['ANTHROPIC_API_KEY'] = 'sk-anthropic-secret'
    process.env['GH_TOKEN'] = 'gh-secret'
    process.env['MY_CUSTOM_TOKEN'] = 'custom-secret'
    try {
      const tool = await createBashTool({ envPolicy: 'filtered' })
      const result = await tool.call(
        { command: 'echo "AK=${ANTHROPIC_API_KEY:-empty} GH=${GH_TOKEN:-empty} CUST=${MY_CUSTOM_TOKEN:-empty}"', cwd: dir },
        makeCtx(dir),
      )
      expect(result.isError).toBe(false)
      const output = String(result.content)
      expect(output).toContain('AK=empty')
      expect(output).toContain('GH=empty')
      expect(output).toContain('CUST=empty')
      expect(output).not.toContain('sk-anthropic-secret')
      expect(output).not.toContain('gh-secret')
      expect(output).not.toContain('custom-secret')
    } finally {
      if (prevAnthropic === undefined) delete process.env['ANTHROPIC_API_KEY']
      else process.env['ANTHROPIC_API_KEY'] = prevAnthropic
      if (prevGh === undefined) delete process.env['GH_TOKEN']
      else process.env['GH_TOKEN'] = prevGh
      delete process.env['MY_CUSTOM_TOKEN']
    }
  })

  it('H5: inherit env policy keeps API_KEY visible to the child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bash-test-'))
    const prev = process.env['ANTHROPIC_API_KEY']
    process.env['ANTHROPIC_API_KEY'] = 'sk-anthropic-secret'
    try {
      const tool = await createBashTool({ envPolicy: 'inherit' })
      const result = await tool.call(
        { command: 'echo "AK=$ANTHROPIC_API_KEY"', cwd: dir },
        makeCtx(dir),
      )
      expect(result.isError).toBe(false)
      expect(String(result.content)).toContain('sk-anthropic-secret')
    } finally {
      if (prev === undefined) delete process.env['ANTHROPIC_API_KEY']
      else process.env['ANTHROPIC_API_KEY'] = prev
    }
  })
})
