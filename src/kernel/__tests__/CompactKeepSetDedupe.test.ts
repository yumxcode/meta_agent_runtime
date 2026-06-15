/**
 * F-2 dedupe — the summary's recent-detail anchors and the fallback summary
 * must not duplicate content the keep-set already preserves verbatim outside
 * the summary.
 */
import { describe, it, expect } from 'vitest'
import {
  enrichCompactSummaryWithContinuity,
  buildFallbackCompactSummary,
} from '../compact/CompactPrompt.js'
import type { KernelMessage } from '../types/KernelMessage.js'

function user(text: string, extra: Partial<KernelMessage> = {}): KernelMessage {
  return { uuid: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }], ...extra }
}
function assistant(text: string, extra: Partial<KernelMessage> = {}): KernelMessage {
  return { uuid: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text }], ...extra }
}
function toolResult(id: string, text: string): KernelMessage {
  return {
    uuid: crypto.randomUUID(),
    role: 'user',
    sourceToolAssistantUUID: 'a',
    content: [{ type: 'tool_result', tool_use_id: id, content: text }],
  }
}

describe('compact keep-set dedupe (F-2)', () => {
  // Window layout: middle region (will be folded into the summary) + tail
  // (preserved verbatim by the keep-set).
  const middleUser = user('中段请求：先分析 run-41 的失败原因')
  const middleAssistant = assistant('中段进展：run-41 是 PD 增益问题')
  const middleTool = toolResult('t0', '中段工具输出：gain=80 振荡')
  const tailUser = user('用 run-42 的曲线重新调阻尼参数')
  const tailAssistant = assistant('正在分析 run-42 曲线')
  const tailTool = toolResult('t1', '落地速度 vz=0.52 m/s，超标')

  const windowMessages = [middleUser, middleAssistant, middleTool, tailUser, tailAssistant, tailTool]

  // Keep-set: clone of tailUser (sourceUuid) + tail unit with original uuids.
  const keepSet: KernelMessage[] = [
    { ...tailUser, uuid: crypto.randomUUID(), isKeepSetClone: true, sourceUuid: tailUser.uuid },
    tailAssistant,
    tailTool,
  ]
  const exclude = new Set<string>()
  for (const m of keepSet) {
    exclude.add(m.uuid)
    if (m.sourceUuid) exclude.add(m.sourceUuid)
  }

  it('terse-summary recent-detail excludes keep-set content but keeps the middle region', () => {
    const out = enrichCompactSummaryWithContinuity('terse.', windowMessages, {
      excludeMessageUuids: exclude,
    })
    // Middle region (about to be lost) must be backed up
    expect(out).toContain('run-41 的失败原因')
    expect(out).toContain('PD 增益问题')
    expect(out).toContain('gain=80 振荡')
    // Tail content survives verbatim in the keep-set → recent-detail must not repeat it
    expect(out).not.toContain('正在分析 run-42 曲线')
    expect(out).not.toContain('vz=0.52')
    // The cheap one-line objective anchor (latest user request) is intentionally kept
    expect(out).toContain('Latest explicit user request')
  })

  it('without exclusion the duplication exists (regression guard for the fix)', () => {
    const out = enrichCompactSummaryWithContinuity('terse.', windowMessages, {})
    expect(out).toContain('vz=0.52')
  })

  it('fallback summary also excludes keep-set content', () => {
    const out = buildFallbackCompactSummary(windowMessages, {
      excludeMessageUuids: exclude,
    })
    expect(out).toContain('run-41 的失败原因')
    expect(out).not.toContain('正在分析 run-42 曲线')
    expect(out).not.toContain('vz=0.52')
  })
})
