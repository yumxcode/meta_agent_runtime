/**
 * Compact quality gate — defenses against the GLM tool-call template leak:
 * a non-empty "summary" that is actually leaked tool-call syntax must be
 * stripped, detected as unusable, and replaced by the deterministic fallback.
 * Also covers the anchor-snowball stripping for carried-forward summaries.
 */
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
import {
  stripLeakedToolCallText,
  formatCompactSummary,
  isUsableCompactSummary,
  stripRegeneratedAnchorSections,
  buildCompactSummaryMessage,
  enrichCompactSummaryWithContinuity,
  COMPACT_FINAL_INSTRUCTION,
} from '../compact/CompactPrompt.js'

const GLM_LEAK = [
  '<tool_call>read_file',
  '<arg_key>file_path</arg_key>',
  '<arg_value>/Users/yumx/code/robot_x/X1/x1_dh_stand_env.py</arg_value>',
  '<arg_key>limit</arg_key>',
  '<arg_value>300</arg_value>',
  '</tool_call>',
  '<tool_call>web_search',
  '<arg_key>query</arg_key>',
  '<arg_value>van Marum minimal reward</arg_value>',
  '</tool_call>',
].join('\n')

function user(text: string): KernelMessage {
  return { uuid: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }] }
}

describe('tool-call leak stripping + quality gate (pure functions)', () => {
  it('stripLeakedToolCallText removes GLM template lines, keeps real prose', () => {
    const mixed = `## 1. Primary Request\n用户要求设计精简 reward。\n${GLM_LEAK}\n## 2. Key Concepts\nPPO`
    const out = stripLeakedToolCallText(mixed)
    expect(out).not.toContain('<tool_call>')
    expect(out).not.toContain('<arg_key>')
    expect(out).toContain('用户要求设计精简 reward')
    expect(out).toContain('## 2. Key Concepts')
  })

  it('formatCompactSummary on a pure-leak response leaves (near-)nothing → unusable', () => {
    const formatted = formatCompactSummary(GLM_LEAK)
    expect(formatted).not.toContain('<tool_call>')
    expect(isUsableCompactSummary(formatted, GLM_LEAK)).toBe(false)
  })

  it('a genuine summary passes the gate; a tiny remnant after a leak does not', () => {
    const genuine = '## 1. Primary Request and Intent\n' + 'x'.repeat(400)
    expect(isUsableCompactSummary(genuine, genuine)).toBe(true)
    // 300 chars of remnant after a leak < stricter 600-char minimum
    const remnant = 'y'.repeat(300)
    expect(isUsableCompactSummary(remnant, GLM_LEAK + remnant)).toBe(false)
  })

  it('stripRegeneratedAnchorSections cuts old anchors, keeps narrative', () => {
    const old = 'Summary:\n## 1. Primary Request\n narrative…\n## Robotics State Anchors (deterministic)\n- task_id: x\n## Deterministic Continuity Anchors\n- …'
    const out = stripRegeneratedAnchorSections(old)
    expect(out).toContain('narrative…')
    expect(out).not.toContain('Robotics State Anchors')
    expect(out).not.toContain('Continuity Anchors')
  })

  it('buildCompactSummaryMessage no longer forbids ALL questions (F-4)', () => {
    const text = buildCompactSummaryMessage('S')
    expect(text).toContain('仍然允许提出')
  })

  it('carried-forward summaries in continuity anchors are anchor-stripped (P2)', () => {
    const oldSummary: KernelMessage = {
      uuid: 'old-sum',
      role: 'user',
      isCompactSummary: true,
      content: [{
        type: 'text',
        text: 'Summary: V12 实验叙事。\n## Robotics State Anchors (deterministic)\n### Hardware Safety Constraints\n重复的硬件档案',
      }],
    }
    const out = enrichCompactSummaryWithContinuity('terse', [oldSummary, user('latest')], {})
    expect(out).toContain('V12 实验叙事')
    expect(out).not.toContain('重复的硬件档案')
  })
})

describe('compactConversation end-to-end gate (mocked SDK)', () => {
  beforeEach(() => createMock.mockReset())

  const opts = {
    model: 'glm-5.1',
    apiKey: 'test-key',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
  }

  it('tool-call-garbage summary → deterministic local fallback, no leak in output', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: GLM_LEAK }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })

    const result = await compactConversation(
      [user('设计精简 reward 实现步态涌现'), user('继续优化')],
      new FileStateCache(),
      opts,
    )

    const serialized = JSON.stringify(result.postCompactMessages)
    expect(serialized).toContain('Local fallback summary')
    expect(serialized).not.toContain('<tool_call>')
    // Fallback still carries the durable user requests
    expect(serialized).toContain('设计精简 reward')
  })

  it('appends the final summarize-now instruction as the LAST request message', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '<summary>' + 'A real summary. '.repeat(30) + '</summary>' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })

    await compactConversation([user('task')], new FileStateCache(), opts)

    const request = createMock.mock.calls[0]?.[0] as { messages: Array<{ content: unknown }> }
    const last = JSON.stringify(request.messages[request.messages.length - 1])
    expect(last).toContain('待总结对话结束')
    expect(COMPACT_FINAL_INSTRUCTION).toContain('不要调用工具')
  })
})
