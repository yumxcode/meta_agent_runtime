import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { KernelMessage } from '../types/KernelMessage.js'
import { FileStateCache } from '../session/FileStateCache.js'

const createMock = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(function AnthropicMock() {
    return { messages: { create: createMock } }
  }),
}))

import { compactConversation } from '../compact/CompactConversation.js'

function makeMessages(count: number): KernelMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    uuid: `msg-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `message ${i}` }],
  }))
}

describe('compactConversation', () => {
  beforeEach(() => {
    createMock.mockReset()
  })

  it('treats GLM context-window stop_reason with empty text as prompt-too-long and retries', async () => {
    createMock
      .mockResolvedValueOnce({
        stop_reason: 'model_context_window_exceeded',
        content: [{ type: 'text', text: '' }],
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '<summary>Recovered summary. 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 补充：实验对比、错误修复记录、待办事项与验证步骤也已包含在内，确保超过质量门槛。 补充：实验对比、错误修复记录、待办事项与验证步骤也已包含在内，确保超过质量门槛。 补充：实验对比、错误修复记录、待办事项与验证步骤也已包含在内，确保超过质量门槛。</summary>' }],
        usage: { input_tokens: 100, output_tokens: 10 },
      })

    const result = await compactConversation(
      makeMessages(20),
      new FileStateCache(),
      {
        model: 'glm-4.5-air',
        apiKey: 'test-key',
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
      },
    )

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(result.postCompactMessages)).toContain('Recovered summary.')
  })

  it('truncates large tool_result content before sending the compact request', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '<summary>Trimmed summary.</summary>' }],
      usage: { input_tokens: 100, output_tokens: 10 },
    })

    const hugeOutput = 'x'.repeat(20_000)
    await compactConversation(
      [
        {
          uuid: 'tool-result',
          role: 'user',
          sourceToolAssistantUUID: 'assistant-1',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: hugeOutput,
          }],
        },
      ],
      new FileStateCache(),
      {
        model: 'glm-4.5-air',
        apiKey: 'test-key',
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
      },
    )

    const request = createMock.mock.calls[0]?.[0] as { messages: unknown[] }
    const serialized = JSON.stringify(request.messages)
    expect(serialized).not.toContain(hugeOutput)
    expect(serialized).toContain('tool_result truncated for compact')
  })

  it('falls back locally after repeated compact prompt-too-long stops', async () => {
    createMock.mockResolvedValue({
      stop_reason: 'model_context_window_exceeded',
      content: [{ type: 'text', text: '' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    const result = await compactConversation(
      makeMessages(20),
      new FileStateCache(),
      {
        model: 'glm-4.5-air',
        apiKey: 'test-key',
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
      },
    )

    expect(createMock).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(result.postCompactMessages)).toContain('Local fallback summary')
  })

  it('adds deterministic continuity anchors when the model summary is terse', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '<summary>Short summary. 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 补充：实验对比、错误修复记录、待办事项与验证步骤也已包含在内，确保超过质量门槛。 补充：实验对比、错误修复记录、待办事项与验证步骤也已包含在内，确保超过质量门槛。 补充：实验对比、错误修复记录、待办事项与验证步骤也已包含在内，确保超过质量门槛。</summary>' }],
      usage: { input_tokens: 100, output_tokens: 10 },
    })

    const result = await compactConversation(
      [
        ...makeMessages(4),
        {
          uuid: 'latest-user',
          role: 'user',
          content: [{ type: 'text', text: 'latest user asks whether the failed run should be rerun' }],
        },
      ],
      new FileStateCache(),
      {
        model: 'glm-4.5-air',
        apiKey: 'test-key',
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
      },
    )

    const serialized = JSON.stringify(result.postCompactMessages)
    expect(serialized).toContain('Short summary.')
    expect(serialized).toContain('Deterministic Continuity Anchors')
    expect(serialized).toContain('latest user asks whether the failed run should be rerun')
  })

  it('appends caller deterministicAnchors to the summary (success path) and protects them', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '<summary>Model summary body. 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 补充：实验对比、错误修复记录、待办事项与验证步骤也已包含在内，确保超过质量门槛。 补充：实验对比、错误修复记录、待办事项与验证步骤也已包含在内，确保超过质量门槛。 补充：实验对比、错误修复记录、待办事项与验证步骤也已包含在内，确保超过质量门槛。</summary>' }],
      usage: { input_tokens: 100, output_tokens: 10 },
    })

    const result = await compactConversation(
      makeMessages(6),
      new FileStateCache(),
      {
        model: 'glm-4.5-air',
        apiKey: 'test-key',
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
        deterministicAnchors: () =>
          '## Robotics State Anchors (deterministic)\n- task_id: TASK_20260606_007',
      },
    )

    const serialized = JSON.stringify(result.postCompactMessages)
    expect(serialized).toContain('Model summary body.')
    expect(serialized).toContain('Robotics State Anchors (deterministic)')
    expect(serialized).toContain('TASK_20260606_007')
  })

  it('appends caller deterministicAnchors in the empty-response fallback path', async () => {
    // Empty text response → triggers buildFallbackCompactSummary.
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    const result = await compactConversation(
      makeMessages(6),
      new FileStateCache(),
      {
        model: 'glm-4.5-air',
        apiKey: 'test-key',
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
        deterministicAnchors: '- task_id: TASK_FALLBACK_42 phase: tuning',
      },
    )

    const serialized = JSON.stringify(result.postCompactMessages)
    expect(serialized).toContain('Local fallback summary')
    expect(serialized).toContain('TASK_FALLBACK_42')
  })

  it('omits bulky recent-detail anchor sections when the model summary is rich', async () => {
    const richSummary = 'Comprehensive model summary. ' + 'detail '.repeat(400) // > 2000 chars
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: `<summary>${richSummary}</summary>` }],
      usage: { input_tokens: 100, output_tokens: 10 },
    })

    const result = await compactConversation(
      [
        ...makeMessages(4),
        { uuid: 'u-last', role: 'user', content: [{ type: 'text', text: 'final user instruction here' }] },
      ],
      new FileStateCache(),
      {
        model: 'glm-4.5-air',
        apiKey: 'test-key',
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
      },
    )

    const serialized = JSON.stringify(result.postCompactMessages)
    // Durable objective anchors always kept; bulky verbatim recent sections dropped.
    expect(serialized).toContain('Durable Objective Anchors')
    expect(serialized).not.toContain('Recent Assistant Progress')
    expect(serialized).not.toContain('Recent Tool Results')
  })

  it('strips robotics volatile context prefixes from compact input and anchors', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '<summary>Short summary. 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 这里是足够长的真实摘要正文，覆盖主要请求、关键技术概念、文件改动与下一步计划。 补充：实验对比、错误修复记录、待办事项与验证步骤也已包含在内，确保超过质量门槛。 补充：实验对比、错误修复记录、待办事项与验证步骤也已包含在内，确保超过质量门槛。 补充：实验对比、错误修复记录、待办事项与验证步骤也已包含在内，确保超过质量门槛。</summary>' }],
      usage: { input_tokens: 100, output_tokens: 10 },
    })

    const volatileUser = [
      '<context>',
      '<experience_index>',
      'Experience manifest that will be regenerated next turn.',
      '</experience_index>',
      '</context>',
      '',
      '---',
      '',
      'real user request after volatile context',
    ].join('\n')

    const result = await compactConversation(
      [{
        uuid: 'volatile-user',
        role: 'user',
        content: [{ type: 'text', text: volatileUser }],
      }],
      new FileStateCache(),
      {
        model: 'glm-4.5-air',
        apiKey: 'test-key',
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
      },
    )

    const request = createMock.mock.calls[0]?.[0] as { messages: unknown[] }
    const sent = JSON.stringify(request.messages)
    expect(sent).not.toContain('<experience_index>')
    expect(sent).not.toContain('Experience manifest that will be regenerated next turn.')
    expect(sent).toContain('real user request after volatile context')

    const compacted = JSON.stringify(result.postCompactMessages)
    expect(compacted).not.toContain('<experience_index>')
    expect(compacted).toContain('real user request after volatile context')
  })
})
