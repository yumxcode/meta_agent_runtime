import { describe, it, expect } from 'vitest'
import { extractLastJsonBlock, buildSummaryFromText } from '../SubAgentRunner.js'
import { makeReturnResultTool, type ReturnedResult } from '../tools/return_result.js'
import { toKernelTool } from '../../modes/toolAdapter.js'

describe('extractLastJsonBlock', () => {
  it('returns null when no fenced json block exists', () => {
    expect(extractLastJsonBlock('just some narration')).toBeNull()
  })

  it('returns the last fenced json block, fences included', () => {
    const text = 'pre ```json\n{"a":1}\n``` mid ```json\n{"b":2}\n``` post'
    expect(extractLastJsonBlock(text)).toBe('```json\n{"b":2}\n```')
  })
})

describe('buildSummaryFromText (JSON-priority truncation)', () => {
  it('returns text unchanged when within budget', () => {
    expect(buildSummaryFromText('short', 100)).toBe('short')
  })

  it('preserves the trailing JSON block instead of cutting it off', () => {
    const narration = 'x'.repeat(500)
    const json = '```json\n' + JSON.stringify({ papers: ['p1', 'p2'], synthesis: 'ok' }) + '\n```'
    const text = `${narration}\n\n${json}`
    const out = buildSummaryFromText(text, 200)
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out).toContain('"synthesis":"ok"')
    expect(out.endsWith('```')).toBe(true)
  })

  it('falls back to head truncation when the JSON block itself overflows', () => {
    const json = '```json\n' + 'y'.repeat(500) + '\n```'
    const out = buildSummaryFromText(json, 100)
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out.endsWith('...')).toBe(true)
  })
})

describe('makeReturnResultTool', () => {
  it('captures summary + data via the sink', async () => {
    let captured: ReturnedResult | undefined
    const tool = makeReturnResultTool(r => { captured = r })
    const res = await tool.call({ summary: 'done', data: { papers: [] } }, {} as never)
    expect(res.isError).toBe(false)
    expect(captured?.summary).toBe('done')
    expect(captured?.data).toEqual({ papers: [] })
  })

  it('rejects an empty summary', async () => {
    let captured: ReturnedResult | undefined
    const tool = makeReturnResultTool(r => { captured = r })
    const res = await tool.call({ summary: '   ' }, {} as never)
    expect(res.isError).toBe(true)
    expect(captured).toBeUndefined()
  })

  it('binds return_result.data to a caller-supplied Graph output schema', () => {
    const tool = toKernelTool(makeReturnResultTool(() => undefined, {
      type: 'object',
      required: ['count', 'trend'],
      properties: {
        count: { type: 'integer', minimum: 0 },
        trend: { type: 'string', enum: ['improved', 'unchanged'] },
      },
      additionalProperties: false,
    }))

    expect(tool.inputSchema.safeParse({ summary: 'done' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ summary: 'done', data: { count: 1 } }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ summary: 'done', data: { count: 1, trend: 'improved' } }).success).toBe(true)
  })

  it('revalidates resultSchema inside call when an executor bypasses toolAdapter', async () => {
    let captured: ReturnedResult | undefined
    const tool = makeReturnResultTool(r => { captured = r }, {
      type: 'object', required: ['trend'],
      properties: { trend: { type: 'string', enum: ['improved'] } },
      additionalProperties: false,
    })

    const invalid = await tool.call({ summary: 'done', data: {} }, {} as never)
    expect(invalid).toMatchObject({ isError: true })
    expect(invalid.content).toContain('return_result.data.trend is required')
    expect(captured).toBeUndefined()

    const valid = await tool.call({ summary: 'done', data: { trend: 'improved' } }, {} as never)
    expect(valid.isError).toBe(false)
    expect(captured?.data).toEqual({ trend: 'improved' })
  })
})
