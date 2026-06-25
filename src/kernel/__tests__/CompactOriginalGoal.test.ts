/**
 * Tests for the current top-level goal deterministic compact anchor —
 * the goal captured before any compaction must appear in every summary path.
 */
import { describe, it, expect } from 'vitest'
import {
  enrichCompactSummaryWithContinuity,
  buildFallbackCompactSummary,
} from '../compact/CompactPrompt.js'
import {
  KernelSession,
  collectOriginalUserGoalParts,
  formatOriginalUserGoal,
  ORIGINAL_GOAL_MESSAGE_COUNT,
} from '../KernelSession.js'
import type { KernelMessage } from '../types/KernelMessage.js'

function user(text: string, extra: Partial<KernelMessage> = {}): KernelMessage {
  return { uuid: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }], ...extra }
}
function assistant(text: string): KernelMessage {
  return { uuid: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text }] }
}

const GOAL = '训练 X1 机器人在 isaac-gym 中的平滑落地策略,最终合并到 v9-smooth-landing 分支'

describe('top-level goal anchor', () => {
  it('is emitted in the rich-summary enrichment path', () => {
    const longSummary = 'S'.repeat(3000) // ≥ rich threshold → recent detail omitted
    const out = enrichCompactSummaryWithContinuity(longSummary, [user('latest request')], {
      originalUserGoal: GOAL,
    })
    expect(out).toContain('Current top-level goal')
    expect(out).toContain(GOAL)
  })

  it('is emitted in the terse-summary enrichment path', () => {
    const out = enrichCompactSummaryWithContinuity('short.', [user('latest request')], {
      originalUserGoal: GOAL,
    })
    expect(out).toContain(GOAL)
  })

  it('is emitted twice-protected in the fallback (empty-response) path', () => {
    const out = buildFallbackCompactSummary([user('latest'), assistant('working')], {
      originalUserGoal: GOAL,
    })
    expect(out).toContain('Current top-level goal')
    expect(out).toContain(GOAL)
  })

  it('post-compact-#1 window: goal still present even though the first in-window user message is the cloned anchor', () => {
    // Simulate the window AFTER a first compaction: boundary + summary +
    // cloned last-user-message — the original goal is no longer in messages.
    const window: KernelMessage[] = [
      user('summary of earlier work…', { isCompactSummary: true }),
      user('continue creating the training task'), // cloned keep-set anchor
      assistant('ok'),
    ]
    const out = enrichCompactSummaryWithContinuity('terse', window, { originalUserGoal: GOAL })
    expect(out).toContain(GOAL)
    // The in-window anchor is labelled as window-scoped, not absolute.
    // (Single real user message in window → merged "Only explicit…" line, P4.)
    expect(out).toContain('Only explicit user request in current window')
  })

  it('omits the goal line when no goal was captured', () => {
    const out = enrichCompactSummaryWithContinuity('terse', [user('q')], {})
    expect(out).not.toContain('Current top-level goal')
  })
})

describe('multi-message original goal capture', () => {
  it('collects the first N real user messages, skipping meta/steering/compact artifacts', () => {
    const messages: KernelMessage[] = [
      user('boundary', { isCompactBoundary: true }),
      user('summary', { isCompactSummary: true }),
      user('帮我看个训练问题'),
      assistant('好的，请描述'),
      user('steer', { isSteering: true }),
      user('X1 落地抖动，曲线在 run-42'),
      user('目标是合并到 v9-smooth-landing'),
      user('第四条不应被捕获'),
    ]
    const parts = collectOriginalUserGoalParts(messages)
    expect(parts).toEqual([
      '帮我看个训练问题',
      'X1 落地抖动，曲线在 run-42',
      '目标是合并到 v9-smooth-landing',
    ])
    expect(parts).toHaveLength(ORIGINAL_GOAL_MESSAGE_COUNT)
  })

  it('formats a single part bare (back-compat) and multiple parts labelled', () => {
    expect(formatOriginalUserGoal([])).toBeNull()
    expect(formatOriginalUserGoal(['only goal'])).toBe('only goal')
    const multi = formatOriginalUserGoal(['a', 'b', 'c'])
    expect(multi).toBe('[user message 1] a\n  [user message 2] b\n  [user message 3] c')
  })

  it('skips keep-set clones — a resumed post-compact history must not adopt a mid-session request as the goal (F-3)', () => {
    // Simulated resumed history after compaction #1: summary + keep-set clone
    // + later real user messages.
    const messages: KernelMessage[] = [
      user('Summary: earlier work…', { isCompactSummary: true }),
      user('重跑一下 run-42', { isKeepSetClone: true, sourceUuid: 'orig-uuid' }),
      assistant('ok'),
      user('继续优化落地速度'),
    ]
    const parts = collectOriginalUserGoalParts(messages)
    expect(parts).toEqual(['继续优化落地速度'])
  })

  it('truncates follow-up messages to their smaller per-part budget', () => {
    const long = 'x'.repeat(5_000)
    const parts = collectOriginalUserGoalParts([user('goal'), user(long)])
    expect(parts[1]).toContain('[truncated]')
    expect(parts[1]!.length).toBeLessThanOrEqual(700)
  })

  it('multi-message goal flows through the enrichment path intact', () => {
    const goal = formatOriginalUserGoal(['先看抖动问题', '再合并 v9 分支'])!
    const out = enrichCompactSummaryWithContinuity('terse', [user('latest')], {
      originalUserGoal: goal,
    })
    expect(out).toContain('[user message 1] 先看抖动问题')
    expect(out).toContain('[user message 2] 再合并 v9 分支')
  })
})

describe('original goal re-anchor', () => {
  it('replaces captured goal parts with a sanitized current top-level goal', () => {
    const session = new KernelSession({ model: 'test-model', tools: [] })
    const prompt = '<context>\nvolatile state\n</context>\n\n---\n\n新的 auto 任务'

    session.reanchorOriginalGoal(prompt)

    const internal = session as unknown as { _originalUserGoalParts: string[] }
    expect(internal._originalUserGoalParts).toEqual(['新的 auto 任务'])
  })
})
