/**
 * verify / drift must actually RECEIVE the tracked changes.
 *
 * The renderer has its own tests; this file proves the two gates ask for it and
 * put it in the task the judge reads. Both gates spawn a sub-agent, so the
 * dispatcher is stubbed and the assertion is on the task text handed to it —
 * that text is the entire interface between the gate and its judge.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../subagent/types.js'
import { TurnDiffTracker } from '../../infra/fs/TurnDiffTracker.js'
import { makeAutoVerifyGate } from '../auto/verify/VerifyJudge.js'
import { makeAutoDriftGate } from '../auto/learn/DriftAgent.js'
import { writeAutoCheckpoint, AUTO_CHECKPOINT_SCHEMA_VERSION } from '../auto/AutoCheckpointStore.js'

let ws: string
let tracker: TurnDiffTracker
let capturedTask = ''

const p = (n: string): string => join(ws, n)

/** Records the task text, then reports a completed run with a fixed verdict. */
function stubDispatcher(verdictJson: string): ISubAgentDispatcher {
  const record = {
    taskId: 't1',
    status: 'completed',
    result: { summary: verdictJson },
  } as unknown as SubAgentRecord
  return {
    async spawnSubAgent(opts: { config: { taskDescription: string } }) {
      capturedTask = opts.config.taskDescription
      return record
    },
    async getStatus() { return record },
    async cancelTask() { return true },
  } as unknown as ISubAgentDispatcher
}

beforeEach(async () => {
  ws = mkdtempSync(join(tmpdir(), 'gate-diff-'))
  capturedTask = ''
  tracker = new TurnDiffTracker()
  tracker.beginTurn('run')
  // A change only the TOOL tracker can see — this workspace is not a git repo,
  // so the snapshot path bails and the judge would otherwise get no delta.
  writeFileSync(p('config.yaml'), 'rate: 1\n')
  await tracker.capture(p('config.yaml'))
  writeFileSync(p('config.yaml'), 'rate: 999\n')
})

afterEach(() => rmSync(ws, { recursive: true, force: true }))

describe('verify gate', () => {
  const VERDICT = '```json\n{"done":true,"unfinished":[],"evidence":["e"]}\n```'

  it('hands the judge the tracked changes when git can show nothing', async () => {
    const gate = makeAutoVerifyGate({
      dispatcher: stubDispatcher(VERDICT),
      projectDir: ws,
      getGoal: () => '把采样率调高',
      getTurnDiff: () => tracker,
    })
    const verdict = await gate({
      workspaceRoot: ws, turnCount: 1, round: 1, signal: new AbortController().signal,
    })

    expect(verdict.done).toBe(true)
    expect(capturedTask).toContain('config.yaml')
    expect(capturedTask).toMatch(/由写入工具记录/)
    // No git diff at all → the patch is worth paying for, since it is the only
    // delta the judge has.
    expect(capturedTask).toContain('+rate: 999')
  })

  it('works exactly as before when no tracker is supplied', async () => {
    const gate = makeAutoVerifyGate({
      dispatcher: stubDispatcher(VERDICT),
      projectDir: ws,
      getGoal: () => '目标',
    })
    const verdict = await gate({
      workspaceRoot: ws, turnCount: 1, round: 1, signal: new AbortController().signal,
    })
    expect(verdict.done).toBe(true)
    expect(capturedTask).toContain('目标')
    expect(capturedTask).not.toMatch(/由写入工具记录/)
  })

  it('does not claim "nothing changed" while the tracker says otherwise', async () => {
    // The trap this closes: `git add -A` honours .gitignore, so a round spent
    // editing an ignored path yields an empty git diff. Telling the judge
    // "没有任何文件改动——这本身即是重要证据" would point it at the opposite of
    // the truth.
    const gate = makeAutoVerifyGate({
      dispatcher: stubDispatcher(VERDICT),
      projectDir: ws,
      getGoal: () => '目标',
      getTurnDiff: () => tracker,
    })
    await gate({
      workspaceRoot: ws, turnCount: 1, round: 1, signal: new AbortController().signal,
    })
    expect(capturedTask).not.toContain('没有任何文件改动')
  })
})

describe('drift gate', () => {
  const VERDICT = '```json\n{"drifted":false,"corrective":[]}\n```'

  beforeEach(async () => {
    mkdirSync(join(ws, '.meta-agent'), { recursive: true })
    await writeAutoCheckpoint(ws, {
      schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'sess-1',
      updatedAt: Date.now(),
      turnCount: 3,
      completedSteps: ['做了一些事'],
      pendingTodos: [],
      artifacts: [],
    })
  })

  it('hands the reviewer a change list instead of telling it to run git itself', async () => {
    const gate = makeAutoDriftGate({
      dispatcher: stubDispatcher(VERDICT),
      projectDir: ws,
      getGoal: () => '目标',
      getSessionId: () => 'sess-1',
      getTurnDiff: () => tracker,
    })
    const verdict = await gate({
      workspaceRoot: ws, turnCount: 3, reason: 'turn_interval', signal: new AbortController().signal,
    })

    expect(verdict.drifted).toBe(false)
    expect(capturedTask).toContain('config.yaml')
  })

  it('sends a stat block, not a patch — drift judges direction, not content', async () => {
    // A patch on every drift invocation would multiply the cost of a gate that
    // fires every N turns without changing the judgement it makes.
    const gate = makeAutoDriftGate({
      dispatcher: stubDispatcher(VERDICT),
      projectDir: ws,
      getGoal: () => '目标',
      getSessionId: () => 'sess-1',
      getTurnDiff: () => tracker,
    })
    await gate({
      workspaceRoot: ws, turnCount: 3, reason: 'turn_interval', signal: new AbortController().signal,
    })
    expect(capturedTask).toContain('config.yaml')
    expect(capturedTask).not.toContain('+rate: 999')
  })

  it('still runs when no tracker is supplied', async () => {
    const gate = makeAutoDriftGate({
      dispatcher: stubDispatcher(VERDICT),
      projectDir: ws,
      getGoal: () => '目标',
      getSessionId: () => 'sess-1',
    })
    const verdict = await gate({
      workspaceRoot: ws, turnCount: 3, reason: 'turn_interval', signal: new AbortController().signal,
    })
    expect(verdict.drifted).toBe(false)
    expect(capturedTask).toContain('进度快照')
  })
})
