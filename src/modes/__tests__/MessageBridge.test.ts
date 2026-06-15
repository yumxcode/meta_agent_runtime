/**
 * F-1 — resume-path conversion must preserve kernel metadata flags so compact
 * summaries / boundaries / keep-set clones are not mistaken for real user
 * messages after a resume.
 */
import { describe, it, expect } from 'vitest'
import { toKernelMessages } from '../messageBridge.js'
import type { ConversationMessage } from '../../core/types.js'

describe('toKernelMessages (F-1 flag passthrough)', () => {
  it('preserves kernel metadata flags and uuid', () => {
    const messages: ConversationMessage[] = [
      {
        role: 'user',
        uuid: 'u-boundary',
        content: [],
        isCompactBoundary: true,
      },
      {
        role: 'user',
        uuid: 'u-summary',
        content: [{ type: 'text', text: 'Summary: …' }],
        isCompactSummary: true,
      },
      {
        role: 'user',
        uuid: 'u-clone',
        content: [{ type: 'text', text: '重跑 run-42' }],
        isKeepSetClone: true,
        sourceUuid: 'u-original',
      },
      {
        role: 'user',
        uuid: 'u-steer',
        content: [{ type: 'text', text: '只调 lr' }],
        isSteering: true,
      },
      { role: 'user', content: '真实用户请求' },
      { role: 'assistant', uuid: 'a-1', content: [{ type: 'text', text: 'ok' }] },
    ]

    const kernel = toKernelMessages(messages)

    expect(kernel[0]).toMatchObject({ uuid: 'u-boundary', isCompactBoundary: true })
    expect(kernel[1]).toMatchObject({ uuid: 'u-summary', isCompactSummary: true })
    expect(kernel[2]).toMatchObject({
      uuid: 'u-clone',
      isKeepSetClone: true,
      sourceUuid: 'u-original',
    })
    expect(kernel[3]).toMatchObject({ uuid: 'u-steer', isSteering: true })
    // String content converted; fresh uuid generated when absent
    expect(kernel[4]!.content).toEqual([{ type: 'text', text: '真实用户请求' }])
    expect(typeof kernel[4]!.uuid).toBe('string')
    // No spurious flags invented
    expect(kernel[4]!.isCompactSummary).toBeUndefined()
    expect(kernel[5]).toMatchObject({ uuid: 'a-1', role: 'assistant' })
  })

  it('round-trip via JSON (history.jsonl shape) keeps flags', () => {
    const persisted = JSON.parse(JSON.stringify([
      { role: 'user', uuid: 'u1', content: [{ type: 'text', text: 's' }], isCompactSummary: true },
    ])) as ConversationMessage[]
    const kernel = toKernelMessages(persisted)
    expect(kernel[0]!.isCompactSummary).toBe(true)
  })
})
