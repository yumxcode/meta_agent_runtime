/**
 * KernelSession.compactNow() — manual /compact: forced compaction through the
 * standard pipeline (summary + keep-set + anchors + quality gate).
 *
 * NOTE: the Anthropic mock deliberately routes through a PLAIN function holder
 * instead of a vi.fn — vitest 4's spy attaches an internal settled-result
 * tracking chain to any promise/thenable returned from (or error thrown by) a
 * mock, which fails the test with the raw rejection even when the production
 * code awaited and handled it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

type CreateFn = (...args: unknown[]) => Promise<unknown>
const holder = vi.hoisted(() => ({
  calls: 0,
  impl: (async () => ({})) as CreateFn,
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: function AnthropicMock() {
    return {
      messages: {
        create: (...args: unknown[]) => {
          holder.calls++
          return holder.impl(...args)
        },
      },
    }
  },
}))

import { KernelSession } from '../KernelSession.js'

const REAL_SUMMARY =
  '<summary>## 1. Primary Request and Intent\n' +
  '用户在调试 X1 落地抖动，已完成 V13 reward 设计与训练任务创建。'.repeat(8) +
  '</summary>'

function makeSession(): KernelSession {
  return new KernelSession({
    apiKey: 'test-key',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5.1',
    cwd: process.cwd(),
    tools: [],
    compact: { enabled: true, model: 'glm-5.1' },
    initialMessages: [
      { uuid: 'u1', role: 'user', content: [{ type: 'text', text: '帮我看看 X1 落地抖动的问题' }] },
      { uuid: 'a1', role: 'assistant', content: [{ type: 'text', text: '已分析曲线，建议 V13 方案。' }] },
      { uuid: 'u2', role: 'user', content: [{ type: 'text', text: '实现吧' }] },
      { uuid: 'a2', role: 'assistant', content: [{ type: 'text', text: 'V13 已推送并创建训练任务。' }] },
    ],
  })
}

describe('KernelSession.compactNow', () => {
  beforeEach(() => {
    holder.calls = 0
    holder.impl = async () => ({})
  })

  it('compacts on demand: history replaced by boundary+summary, goal anchor preserved', async () => {
    holder.impl = async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: REAL_SUMMARY }],
      usage: { input_tokens: 500, output_tokens: 100 },
    })

    const session = makeSession()
    const result = await session.compactNow()

    expect(result.compacted).toBe(true)
    expect(result.previousTokens).toBeGreaterThan(0)

    const messages = session.getMessages()
    expect(messages.some(m => m.isCompactBoundary)).toBe(true)
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain('Primary Request and Intent')
    // Original-goal anchor injected (captured from initialMessages)
    expect(serialized).toContain('帮我看看 X1 落地抖动的问题')
  })

  it('refuses when the context is too short to compact', async () => {
    const session = new KernelSession({
      apiKey: 'test-key',
      model: 'glm-5.1',
      cwd: process.cwd(),
      tools: [],
      initialMessages: [],
    })
    const result = await session.compactNow()
    expect(result.compacted).toBe(false)
    expect(result.reason).toContain('过短')
    expect(holder.calls).toBe(0)
  })

  it('reports failure without destroying history when the side-call errors', async () => {
    holder.impl = async () => { throw new Error('gateway exploded') }
    const session = makeSession()
    const before = session.getMessages().length

    const result = await session.compactNow()
    expect(result.compacted).toBe(false)
    expect(result.reason).toContain('gateway exploded')
    expect(session.getMessages().length).toBe(before)
    expect(holder.calls).toBe(1)
  })
})
