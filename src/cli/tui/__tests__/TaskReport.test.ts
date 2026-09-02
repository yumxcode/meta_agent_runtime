/**
 * A finished task's completion report has to be reachable.
 *
 * Before this, the report existed in the worker log and the board threw it
 * away three separate ways:
 *
 *   1. `resultSummary()` rendered the `result` event as turns/duration/cost and
 *      never read `resultText` — which IS the agent's closing message
 *      (KernelLoop sets `resultText = assistantText` on the ordinary
 *      completion path). The one event that carries the report was drawn as a
 *      stats line.
 *   2. The prose survived only as `text` deltas folded in with whatever tool
 *      calls followed, split wherever a tool interrupted, tail-clipped at
 *      MAX_AGENT_CHARS. It read as "the last thing that scrolled by".
 *   3. `TaskManager.latestByTask` is in-memory, so reopening the board lost the
 *      completed run entirely and the panel claimed "this turn was not launched
 *      by this tasks manager" — false for a task it had run ten minutes earlier.
 */
import { describe, expect, it } from 'vitest'
import { buildFrame, reportBodyLines } from '../frame.js'
import { parseTaskActivityLog } from '../TaskActivityLog.js'
import { resolveFinishedTaskActivity } from '../TaskManager.js'
import type { TaskView } from '../../../core/auto/TaskRegistry.js'

const NOW = 1_700_000_000_000
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    workspace: '/home/u/X1_29_AMP',
    sessionId: 'abcdef12-800e-47fc-bde8-a6266593909c',
    status: 'finished',
    progress: { completedSteps: [], pendingTodos: [], artifacts: [] },
    health: {},
    scheduler: { alive: false },
    pendingSteerCount: 0,
    ...over,
  }
}

const ndjson = (...events: unknown[]): string =>
  events.map(e => JSON.stringify(e)).join('\n') + '\n'

const REPORT = '训练完成。\n\n结论：AMP 在 X1 上收敛，loss 0.031。\n\n下一步：跑 29 号的对照组。'

describe('the report is lifted out of the stream', () => {
  it('keeps resultText instead of reducing the result event to statistics', () => {
    const feed = parseTaskActivityLog(ndjson({
      type: 'result',
      subtype: 'success',
      resultText: REPORT,
      numTurns: 12,
      durationMs: 270_000,
      totalCostUsd: 0.8312,
    }))

    expect(feed.report?.text).toContain('loss 0.031')
    expect(feed.report?.subtype).toBe('success')
    expect(feed.report?.numTurns).toBe(12)
    expect(feed.report?.totalCostUsd).toBeCloseTo(0.8312)
    // The stats line is still there — it answers a question the prose does not.
    expect(feed.entries.some(e => e.kind === 'status' && e.text.includes('12 turns'))).toBe(true)
    // …and the report is now its own entry, so the inline panel shows it too.
    expect(feed.entries.some(e => e.kind === 'report')).toBe(true)
  })

  it('preserves the report paragraphs rather than collapsing them to one line', () => {
    const feed = parseTaskActivityLog(ndjson({
      type: 'result', subtype: 'success', resultText: REPORT,
    }))
    expect(feed.report?.text).toContain('\n\n')
  })

  it('still strips control sequences from the report — it came from a model', () => {
    const feed = parseTaskActivityLog(ndjson({
      type: 'result', subtype: 'success', resultText: 'safe\x1b[31mred\x1b[0m done',
    }))
    expect(feed.report?.text).toBe('safered done')
  })

  it('carries the termination diagnosis, which is the real report on a bad ending', () => {
    // On an abnormal ending resultText is a canned line; the explanation is the
    // separate termination_analysis event.
    const feed = parseTaskActivityLog(ndjson(
      {
        type: 'result',
        subtype: 'error_during_execution',
        stopReason: 'no_progress',
        resultText: 'Stopped: no progress.',
        isError: true,
      },
      { type: 'termination_analysis', analysis: '同一个编译错误重试了 6 次，缺少 CUDA toolkit。' },
    ))

    expect(feed.report?.text).toBe('Stopped: no progress.')
    expect(feed.report?.diagnosis).toContain('CUDA toolkit')
    expect(feed.report?.stopReason).toBe('no_progress')
    expect(feed.report?.isError).toBe(true)
  })

  it('takes the LAST result when a log holds several turns', () => {
    const feed = parseTaskActivityLog(ndjson(
      { type: 'result', subtype: 'parked', resultText: 'first turn' },
      { type: 'result', subtype: 'success', resultText: 'second turn' },
    ))
    expect(feed.report?.text).toBe('second turn')
    expect(feed.report?.subtype).toBe('success')
  })

  it('reports no report rather than an empty one', () => {
    const feed = parseTaskActivityLog(ndjson({ type: 'text', text: 'still working' }))
    expect(feed.report).toBeUndefined()
  })

  it('head-clips an enormous report — a report leads with its conclusion', () => {
    const feed = parseTaskActivityLog(ndjson({
      type: 'result', subtype: 'success', resultText: `START${'x'.repeat(40_000)}END`,
    }))
    expect(feed.report?.clipped).toBe(true)
    expect(feed.report?.text?.startsWith('START')).toBe(true)
    expect(feed.report?.text?.length).toBeLessThan(21_000)
  })
})

describe('a finished turn stays addressable across a restart', () => {
  it('resolves the last wake log without any in-memory launch record', () => {
    const activity = resolveFinishedTaskActivity(
      task({ lastWakeId: 'wake-42', lastOutcome: 'done', lastOutcomeAt: NOW - 600_000 }),
      NOW,
    )
    expect(activity?.wakeId).toBe('wake-42')
    expect(activity?.logPath).toMatch(/managed-auto[/\\]logs[/\\][0-9a-f]{24}\.log$/)
    expect(activity?.reattached).toBe(true)
    expect(activity?.endedAt).toBe(NOW - 600_000)
  })

  it('does not shadow a turn that is running right now', () => {
    expect(resolveFinishedTaskActivity(
      task({ status: 'running', lastWakeId: 'wake-42' }), NOW,
    )).toBeUndefined()
  })

  it('also covers parked and orphaned tasks — they have a last turn too', () => {
    for (const status of ['parked', 'orphaned'] as const) {
      expect(resolveFinishedTaskActivity(task({ status, lastWakeId: 'w' }), NOW)).toBeDefined()
    }
  })

  it('returns nothing when the session never armed a wake', () => {
    expect(resolveFinishedTaskActivity(task(), NOW)).toBeUndefined()
  })
})

describe('the report view', () => {
  const feed = parseTaskActivityLog(ndjson({
    type: 'result', subtype: 'success', resultText: REPORT,
    numTurns: 12, durationMs: 270_000, totalCostUsd: 0.8312,
  }))
  const activity = {
    run: {
      workspace: '/home/u/X1_29_AMP',
      sessionId: 'abcdef12-800e-47fc-bde8-a6266593909c',
      wakeId: 'w1',
      state: 'succeeded' as const,
      startedAt: NOW - 600_000,
      endedAt: NOW - 600_000,
      reattached: true,
    },
    feed,
  }
  const withReport = task({
    goal: '在 X1 上验证 AMP 训练',
    progress: {
      completedSteps: ['准备数据集', '跑通 baseline'],
      pendingTodos: ['对照组'],
      artifacts: ['/home/u/X1_29_AMP/runs/amp-29/metrics.json'],
    },
  })

  const render = (over: Partial<Parameters<typeof buildFrame>[0]> = {}): string =>
    plain(buildFrame({
      tasks: [withReport],
      selected: 0,
      mode: { kind: 'report', scroll: 0 },
      showFinished: true,
      now: NOW,
      rows: 40,
      columns: 100,
      activity,
      ...over,
    }).join('\n'))

  it('shows the report body, artifacts and the run facts', () => {
    const out = render()
    expect(out).toContain('完成报告')
    expect(out).toContain('loss 0.031')
    expect(out).toContain('metrics.json')
    expect(out).toContain('12 turns')
  })

  it('prints an artifact path verbatim so it can be copied', () => {
    expect(render()).toContain('/home/u/X1_29_AMP/runs/amp-29/metrics.json')
  })

  it('never exceeds the terminal it was given', () => {
    for (const [rows, columns] of [[8, 40], [24, 80], [40, 120], [6, 60]] as const) {
      const lines = buildFrame({
        tasks: [withReport],
        selected: 0,
        mode: { kind: 'report', scroll: 0 },
        showFinished: true,
        now: NOW, rows, columns, activity,
      })
      expect(lines.length).toBeLessThanOrEqual(rows)
    }
  })

  it('clamps a scroll past the end instead of showing a blank screen', () => {
    const body = reportBodyLines(withReport, activity, 100)
    const out = render({ mode: { kind: 'report', scroll: body.length + 500 } })
    // Something from the tail of the report is still on screen.
    expect(out.replace(/\s/g, '').length).toBeGreaterThan(40)
  })

  it('says plainly when there is no log to read, instead of blaming the manager', () => {
    const out = plain(buildFrame({
      tasks: [withReport],
      selected: 0,
      mode: { kind: 'report', scroll: 0 },
      showFinished: true,
      now: NOW, rows: 24, columns: 100,
    }).join('\n'))
    expect(out).toContain('找不到这个任务最近一轮的运行日志')
    expect(out).not.toContain('not launched by this tasks manager')
  })

  it('shows the diagnosis alongside the canned stop line on a bad ending', () => {
    const bad = parseTaskActivityLog(ndjson(
      { type: 'result', subtype: 'error_during_execution', resultText: 'Stopped: no progress.', isError: true },
      { type: 'termination_analysis', analysis: '缺少 CUDA toolkit。' },
    ))
    const out = render({ activity: { ...activity, feed: bad } })
    expect(out).toContain('Stopped: no progress.')
    expect(out).toContain('终态诊断')
    expect(out).toContain('CUDA toolkit')
  })
})

describe('the board still looks like the board', () => {
  it('does not flip the read-only view into the split activity layout', () => {
    // `activity` is now populated without a manager so the report can be read,
    // but the inline panel remains a managed-mode surface.
    const out = plain(buildFrame({
      tasks: [task()],
      selected: 0,
      mode: { kind: 'browse' },
      showFinished: true,
      now: NOW, rows: 24, columns: 100,
      activity: {
        run: {
          workspace: '/home/u/X1_29_AMP',
          sessionId: 'abcdef12-800e-47fc-bde8-a6266593909c',
          wakeId: 'w1', state: 'succeeded', startedAt: NOW, reattached: true,
        },
        feed: parseTaskActivityLog(ndjson({ type: 'text', text: 'hello' })),
      },
    }).join('\n'))
    expect(out).not.toContain('recent activity')
    expect(out).toContain('enter report')
  })
})
