/**
 * The reported macOS symptom, end to end: two-finger scrolling the report pane
 * closed it and started moving the task selection.
 *
 * keysSplitSequence.test.ts covers the decoder, where the bug was. This covers
 * the WIRING — that TaskTui uses the stateful decoder rather than the
 * chunk-at-a-time one. Reverting that single import would leave every decoder
 * test green and put the bug straight back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskView } from '../../../core/auto/TaskRegistry.js'

const NOW = 1_700_000_000_000

function task(sessionId: string, goal: string): TaskView {
  return {
    workspace: '/home/u/X1_29_AMP',
    sessionId,
    status: 'finished',
    goal,
    progress: {
      completedSteps: Array.from({ length: 30 }, (_, i) => `step ${i}`),
      pendingTodos: [],
      artifacts: [],
    },
    health: {},
    scheduler: { alive: false },
    pendingSteerCount: 0,
  }
}

const TASKS = [
  task('11111111-1111-4111-8111-111111111111', 'FIRST TASK GOAL'),
  task('22222222-2222-4222-8222-222222222222', 'SECOND TASK GOAL'),
]

vi.mock('../../../core/auto/TaskRegistry.js', async () => {
  const actual = await vi.importActual<typeof import('../../../core/auto/TaskRegistry.js')>(
    '../../../core/auto/TaskRegistry.js',
  )
  return { ...actual, collectTasks: async () => TASKS }
})

let writes: string[]

beforeEach(() => {
  writes = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const screen = (): string => (writes.at(-1) ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

/** Feed stdin exactly as the tty would, in the given chunks. */
function type(...chunks: string[]): void {
  for (const chunk of chunks) process.stdin.emit('data', Buffer.from(chunk))
}

async function openTui(): Promise<{ done: Promise<void> }> {
  const { TaskTui } = await import('../TaskTui.js')
  const tui = new TaskTui({ workspaces: [], refreshMs: 60_000, showFinished: true })
  const done = tui.run()
  await new Promise(resolve => setTimeout(resolve, 20))
  return { done }
}

describe('scrolling the report with a split escape burst', () => {
  it('stays in the report instead of falling back to task selection', async () => {
    const { done } = await openTui()
    expect(screen()).toContain('enter report')      // browse mode

    type('\r')                                       // enter → open the report
    expect(screen()).toContain('esc/q back')

    // A trackpad notch, cut mid-sequence by the pipe. The old decoder read the
    // lone ESC as the Escape key and closed the pane here.
    type('\x1b', '[B\x1b[B\x1b')
    expect(screen()).toContain('esc/q back')
    type('[B')
    expect(screen()).toContain('esc/q back')

    type('q')
    expect(screen()).toContain('enter report')       // back in browse, on purpose
    type('q')
    await done
  })

  it('does not move the selection while the report is open', async () => {
    const { done } = await openTui()
    // Only the SELECTED task's goal reaches the detail panel; the list rows
    // carry status/id/timing. So the goal on screen names the selection.
    expect(screen()).toContain('FIRST TASK GOAL')

    type('\r')
    type('\x1b', '[B\x1b[B\x1b[B')                   // scroll, split
    type('\x1b', '[B\x1b[B\x1b[B')
    type('q')                                        // back to browse

    // Before the fix those arrows leaked into browse mode and walked the cursor
    // down the list — the operator came back to a different task.
    expect(screen()).toContain('FIRST TASK GOAL')
    expect(screen()).not.toContain('SECOND TASK GOAL')

    type('q')
    await done
  })

  it('and the same keys DO move the selection in browse mode', async () => {
    // Guards the assertion above from passing for the wrong reason.
    const { done } = await openTui()
    expect(screen()).toContain('FIRST TASK GOAL')
    type('\x1b', '[B')
    expect(screen()).toContain('SECOND TASK GOAL')
    type('q')
    await done
  })

  it('still treats a genuine lone Escape as Escape, after the deadline', async () => {
    const { done } = await openTui()
    type('\r')
    expect(screen()).toContain('esc/q back')

    type('\x1b')
    // Held: nothing has decided yet, so the pane must not close on the spot.
    expect(screen()).toContain('esc/q back')

    await new Promise(resolve => setTimeout(resolve, 120))
    expect(screen()).toContain('enter report')       // deadline expired → closed

    type('q')
    await done
  })
})
