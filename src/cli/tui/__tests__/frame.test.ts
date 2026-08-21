/**
 * The task frame has one job it may not fail at: a broken task is visible
 * without scrolling, and the row tells you which fact matters for ITS status.
 *
 * These assert on the rendered text rather than internals, because "the screen
 * said the wrong thing" is the only failure mode that matters here.
 */
import { describe, expect, it } from 'vitest'
import { buildFrame, displayWidth, fit, hint, visibleLength } from '../frame.js'
import type { TaskView } from '../../../core/auto/TaskRegistry.js'

const NOW = 1_700_000_000_000

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    workspace: '/home/u/X1_29_AMP',
    sessionId: 'abcdef12-800e-47fc-bde8-a6266593909c',
    status: 'parked',
    progress: { completedSteps: [], pendingTodos: [], artifacts: [] },
    health: {},
    scheduler: { alive: true, pid: 64918 },
    pendingSteerCount: 0,
    ...over,
  }
}

function render(tasks: TaskView[], over: Partial<Parameters<typeof buildFrame>[0]> = {}): string {
  return buildFrame({
    tasks,
    selected: 0,
    mode: { kind: 'browse' },
    showFinished: false,
    now: NOW,
    rows: 24,
    columns: 100,
    ...over,
  }).join('\n')
}

// Colour codes would otherwise defeat every substring assertion.
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

describe('the header answers "is anything broken" without reading a row', () => {
  it('counts orphaned tasks', () => {
    const out = plain(render([task({ status: 'orphaned' }), task({ status: 'running' })]))
    expect(out.split('\n')[0]).toContain('1 ORPHANED')
    expect(out.split('\n')[0]).toContain('1 running')
  })

  it('says so plainly when there is nothing to show', () => {
    expect(plain(render([]))).toContain('No Auto tasks found')
  })
})

describe('each status shows the time-fact that belongs to it', () => {
  it('a running task reports how long the turn has been going', () => {
    const out = plain(render([task({
      status: 'running',
      wake: {
        wakeId: 'w1', fireAt: NOW - 200_000, reason: 'gate', attempts: 1,
        claim: { owner: 'host#1', claimedAt: NOW - 180_000, expiresAt: NOW + 400_000 },
      },
    })]))
    expect(out).toContain('turn running 3m')
    // Never the previous wake's outcome — that reads as "nothing is happening".
    expect(out).not.toMatch(/(done|cancelled|expired) \d+[smhd].* ago/)
  })

  it('a parked task reports when it wakes', () => {
    const out = plain(render([task({
      status: 'parked',
      wake: { wakeId: 'w1', fireAt: NOW + 24 * 60_000, reason: 'gate ~16:05', attempts: 1 },
    })]))
    expect(out).toMatch(/→\d{2}:\d{2} \(24m\)/)
  })

  it('an overdue task reports how late it is', () => {
    const out = plain(render([task({
      status: 'overdue',
      wake: { wakeId: 'w1', fireAt: NOW - 15 * 60_000, reason: 'gate', attempts: 1 },
    })]))
    expect(out).toContain('due 15m ago')
  })

  it('an orphaned task says the queue is empty', () => {
    expect(plain(render([task({ status: 'orphaned' })]))).toContain('no wake')
  })
})

describe('the row warns when nothing will ever pick the wake up', () => {
  it('flags a parked task whose workspace has no scheduler', () => {
    const out = plain(render([task({
      status: 'parked',
      scheduler: { alive: false },
      wake: { wakeId: 'w1', fireAt: NOW + 60_000, reason: 'x', attempts: 1 },
    })]))
    expect(out).toContain('no-sched')
  })

  it('does not nag about a finished task', () => {
    const out = plain(render([task({ status: 'finished', scheduler: { alive: false } })], {
      showFinished: true,
    }))
    expect(out).not.toContain('no-sched')
  })
})

describe('the unhealthy hint routes to the recovery command without inlining it', () => {
  it('points at tasks show rather than a command that cannot fit', () => {
    const advice = hint(task({ status: 'orphaned' }))
    expect(advice).toContain('never resume')
    expect(advice).toContain('tasks show abcdef12')
    // A truncated command looks copy-pasteable and is not — worse than none.
    expect(advice).not.toContain('--resume abcdef12-800e')
  })

  it('keeps an orphaned row inside the terminal width', () => {
    // Caught by rendering a real workspace: the hint carried an absolute path
    // plus a full UUID and blew past the right edge, which corrupts a
    // full-screen frame rather than merely looking untidy.
    const lines = buildFrame({
      tasks: [task({
        status: 'orphaned',
        workspace: '/very/long/path/to/a/workspace/that/keeps/going/X1_29_AMP',
      })],
      selected: 0, mode: { kind: 'browse' }, showFinished: false,
      now: NOW, rows: 24, columns: 96,
    })
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(96)
  })
})

describe('input modes take over the footer', () => {
  it('shows the steer prompt while typing a correction', () => {
    const out = plain(render([task()], { mode: { kind: 'steer', text: 'use the coarse mesh' } }))
    expect(out).toContain('steer ›')
    expect(out).toContain('use the coarse mesh')
  })

  it('spells out the consequence before a kill', () => {
    const out = plain(render([task()], {
      mode: { kind: 'confirm', prompt: 'Interrupt the running turn for 9bf2297f?' },
    }))
    expect(out).toContain('Interrupt the running turn')
    expect(out).toContain('[y/n]')
  })
})

describe('the footer survives every terminal size', () => {
  // The footer carries the destructive confirmation. A frame that overflows and
  // gets truncated by the caller leaves the operator in confirm mode with no
  // sign of it — and the next `y` they type deletes a session's history.
  const prompt = 'Delete abcdef12 AND its conversation history?'

  for (const rows of [3, 4, 6, 8, 10, 16, 24, 60]) {
    it(`keeps the confirm prompt visible at ${rows} rows`, () => {
      const lines = buildFrame({
        tasks: [task(), task({ sessionId: 'other' })],
        selected: 0,
        mode: { kind: 'confirm', prompt },
        showFinished: false,
        now: NOW,
        rows,
        columns: 80,
      })
      expect(lines.length).toBeLessThanOrEqual(Math.max(3, rows))
      expect(plain(lines[lines.length - 1]!)).toContain(prompt)
    })
  }

  it('keeps at least one task row rather than an empty list', () => {
    const lines = buildFrame({
      tasks: [task(), task({ sessionId: 'other' })],
      selected: 0, mode: { kind: 'browse' }, showFinished: false,
      now: NOW, rows: 6, columns: 80,
    })
    expect(plain(lines.join('\n'))).toContain('abcdef12')
  })
})

describe('layout never exceeds the terminal', () => {
  it('fits the frame within the given rows and columns', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      task({ sessionId: `s${i}`, goal: '持续推进X1 AMP训练'.repeat(20) }))
    const lines = buildFrame({
      tasks: many, selected: 0, mode: { kind: 'browse' }, showFinished: false,
      now: NOW, rows: 20, columns: 80,
    })
    expect(lines.length).toBeLessThanOrEqual(20)
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(80)
  })

  it('measures CJK as double width, or long goals would wrap and corrupt the frame', () => {
    expect(displayWidth('训练')).toBe(4)
    expect(displayWidth('ab')).toBe(2)
    expect(displayWidth(fit('持续推进X1 AMP训练', 10))).toBeLessThanOrEqual(10)
  })
})
