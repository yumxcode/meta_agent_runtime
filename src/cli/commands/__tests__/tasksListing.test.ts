/**
 * `meta-agent tasks` — does a task that has ALREADY FINISHED still exist?
 *
 * The 2026-08-18 case these tests are written from: a scheduler drained its
 * queue, printed "no wakes left — exiting", and a two-day run that had produced
 * a dozen files disappeared from `meta-agent tasks`. Nothing was broken and
 * nothing was lost — the checkpoint held the goal, the cost and every artifact
 * path the whole time — but the default view filtered the row out, so the only
 * way to see the result of a finished run was to already know about `--all`.
 *
 * These assert on rendered stdout rather than internals, because "the list did
 * not mention the task" is the failure being prevented.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTasksCommand } from '../tasks.js'
import {
  writeAutoCheckpoint,
  AUTO_CHECKPOINT_SCHEMA_VERSION,
} from '../../../core/auto/AutoCheckpointStore.js'
import { AutoContinuationStore } from '../../../core/auto/AutoContinuationStore.js'
import type { CliOptions } from '../../args.js'

const dirs: string[] = []
let out: string[]

beforeEach(() => {
  out = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
})

afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('managed mode flags', () => {
  it('requires the interactive TUI instead of silently degrading to a list', async () => {
    const ws = await workspace()
    await runTasksCommand(opts(ws, ['--manage', '--max-running', '3']))
    expect(printed()).toContain('--manage is an interactive TUI mode')
    expect(process.exitCode).toBe(1)
  })

  it('rejects a global running limit when manage mode is absent', async () => {
    const ws = await workspace()
    await runTasksCommand(opts(ws, ['--max-running', '3']))
    expect(printed()).toContain('--max-running requires --manage')
    expect(process.exitCode).toBe(1)
  })

  it('rejects invalid managed concurrency values', async () => {
    const ws = await workspace()
    await runTasksCommand(opts(ws, ['--manage', '--max-running', '0']))
    expect(printed()).toContain('--max-running must be a positive integer')
    expect(process.exitCode).toBe(1)
  })
})

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-cli-'))
  dirs.push(dir)
  return dir
}

/** Colour codes are empty under vitest, but never assert on that. */
const printed = (): string => out.join('\n').replace(/\x1b\[[0-9;]*m/g, '')

function opts(workspace: string, args: string[]): CliOptions {
  return {
    workspace,
    json: false,
    loopCommand: { name: 'tasks', args: ['--no-tui', ...args] },
  } as unknown as CliOptions
}

const FINISHED = 'f1f1f1f1-800e-47fc-bde8-a6266593909c'
const PARKED = 'aaaaaaaa-800e-47fc-bde8-a6266593909c'

const ARTIFACTS = [
  'sim2real/export/x1_identified.urdf',
  'sim2real/export/xyber_x1_identified.xml',
  'sim2real/export/dr_x1_spi.json',
  'doc/sim2real_spi.md',
]

/** A run that completed: no wake left, checkpoint says it ended cleanly. */
async function finishedRun(ws: string): Promise<void> {
  await writeAutoCheckpoint(ws, {
    schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
    sessionId: FINISHED,
    updatedAt: Date.now(),
    goal: 'F1 Sim2Real SPI 改造',
    stopReason: 'completed',
    turnCount: 353,
    estimatedCostUsd: 13.3488,
    completedSteps: ['调研与设计', '远端辨识 TASK_20260818_041'],
    artifacts: ARTIFACTS,
  })
}

/** A run still waiting on a future wake. */
async function parkedRun(ws: string): Promise<void> {
  await writeAutoCheckpoint(ws, {
    schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
    sessionId: PARKED,
    updatedAt: Date.now(),
    goal: '持续推进X1 AMP训练',
    stopReason: 'parked',
  })
  await new AutoContinuationStore(ws).schedule({
    sessionId: PARKED,
    fireAt: Date.now() + 3_600_000,
    reason: 'v21b 训练完成后核验产物',
    historyMessageCount: 126,
  })
}

describe('a finished run is still visible after the scheduler exits', () => {
  it('lists it with no flags at all', async () => {
    const ws = await workspace()
    await finishedRun(ws)
    await parkedRun(ws)

    await runTasksCommand(opts(ws, ['list']))

    const text = printed()
    expect(text).toContain(FINISHED.slice(0, 8))
    expect(text).toContain('finished')
    expect(text).toContain('F1 Sim2Real SPI 改造')
    // The cost of the run is the thing an operator checks first.
    expect(text).toContain('$13.35')
    // Nothing is hidden, so nothing claims to be.
    expect(text).not.toContain('hidden')
  })

  it('bare `tasks` through a pipe behaves like `tasks list`', async () => {
    const ws = await workspace()
    await finishedRun(ws)

    await runTasksCommand(opts(ws, []))

    expect(printed()).toContain(FINISHED.slice(0, 8))
  })

  it('--active restores the live-queue-only view and says what it hid', async () => {
    const ws = await workspace()
    await finishedRun(ws)
    await parkedRun(ws)

    await runTasksCommand(opts(ws, ['list', '--active']))

    const text = printed()
    expect(text).not.toContain(FINISHED.slice(0, 8))
    expect(text).toContain(PARKED.slice(0, 8))
    expect(text).toContain('1 finished task(s) hidden by --active')
  })

  it('still honours --all, and --all wins over --active', async () => {
    const ws = await workspace()
    await finishedRun(ws)

    await runTasksCommand(opts(ws, ['list', '--all', '--active']))

    expect(printed()).toContain(FINISHED.slice(0, 8))
  })

  it('counts finished tasks in the summary line either way', async () => {
    const ws = await workspace()
    await finishedRun(ws)
    await parkedRun(ws)

    await runTasksCommand(opts(ws, ['list', '--active']))

    // The summary counts every task, so `--active` cannot make a finished run
    // look like it never existed.
    expect(printed()).toContain('1 finished')
  })
})

describe('tasks show surfaces what the run produced', () => {
  it('lists artifact paths in full, verbatim', async () => {
    const ws = await workspace()
    await finishedRun(ws)

    await runTasksCommand(opts(ws, ['show', FINISHED.slice(0, 8)]))

    const text = printed()
    expect(text).toContain('产出')
    for (const path of ARTIFACTS) expect(text).toContain(path)
    // A clipped path opens nothing; truncation here would defeat the feature.
    expect(text).not.toContain('…')
    expect(text).toContain('4 artifacts')
  })

  it('defers to --json past the display limit instead of flooding the terminal', async () => {
    const ws = await workspace()
    const many = Array.from({ length: 26 }, (_, i) => `out/artifact_${i}.json`)
    await writeAutoCheckpoint(ws, {
      schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
      sessionId: FINISHED,
      updatedAt: Date.now(),
      goal: 'g',
      stopReason: 'completed',
      artifacts: many,
    })

    await runTasksCommand(opts(ws, ['show', FINISHED.slice(0, 8)]))

    const text = printed()
    expect(text).toContain('out/artifact_0.json')
    expect(text).toContain('out/artifact_19.json')
    expect(text).not.toContain('out/artifact_20.json')
    expect(text).toContain('+6 more')
  })

  it('says nothing about artifacts when the run recorded none', async () => {
    const ws = await workspace()
    await parkedRun(ws)

    await runTasksCommand(opts(ws, ['show', PARKED.slice(0, 8)]))

    const text = printed()
    expect(text).toContain('0 artifacts')
    expect(text).not.toContain('产出')
  })

  it('exposes artifacts on the --json contract', async () => {
    const ws = await workspace()
    await finishedRun(ws)

    await runTasksCommand(opts(ws, ['show', FINISHED.slice(0, 8), '--json']))

    const parsed = JSON.parse(printed()) as { task: { progress: { artifacts: string[] } } }
    expect(parsed.task.progress.artifacts).toEqual(ARTIFACTS)
  })
})
