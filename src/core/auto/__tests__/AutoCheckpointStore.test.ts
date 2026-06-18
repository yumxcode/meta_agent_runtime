import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  autoCheckpointPath,
  readAutoCheckpoint,
  writeAutoCheckpoint,
  updateAutoCheckpoint,
  buildAutoResumePreamble,
  AUTO_CHECKPOINT_SCHEMA_VERSION,
} from '../AutoCheckpointStore.js'

describe('AutoCheckpointStore', () => {
  let ws: string
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'auto-cp-')) })
  afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

  it('returns null when no checkpoint exists', () => {
    expect(readAutoCheckpoint(ws)).toBeNull()
  })

  it('writes then reads a checkpoint round-trip', async () => {
    const ok = await writeAutoCheckpoint(ws, {
      schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 's1',
      updatedAt: 123,
      goal: 'build the thing',
    })
    expect(ok).toBe(true)
    expect(existsSync(autoCheckpointPath(ws))).toBe(true)
    const cp = readAutoCheckpoint(ws)
    expect(cp?.sessionId).toBe('s1')
    expect(cp?.goal).toBe('build the thing')
  })

  it('returns null on corrupt JSON', async () => {
    await writeAutoCheckpoint(ws, { schemaVersion: '1.0', sessionId: 's', updatedAt: 1 })
    // Corrupt it
    require('fs').writeFileSync(autoCheckpointPath(ws), '{not json', 'utf-8')
    expect(readAutoCheckpoint(ws)).toBeNull()
  })

  it('update merges: unions completedSteps/artifacts, replaces todos, bumps updatedAt', async () => {
    const cp1 = await updateAutoCheckpoint(ws, 's1', { completedSteps: ['a'], pendingTodos: ['x', 'y'], artifacts: ['f1'] })
    const cp2 = await updateAutoCheckpoint(ws, 's1', {
      completedSteps: ['b'],
      pendingTodos: ['y'],
      artifacts: ['f2'],
      goal: 'g',
    })
    expect(cp2.completedSteps?.sort()).toEqual(['a', 'b'])
    expect(cp2.artifacts?.sort()).toEqual(['f1', 'f2'])
    expect(cp2.pendingTodos).toEqual(['y']) // replaced, not unioned
    expect(cp2.goal).toBe('g')
    expect(cp2.updatedAt).toBeGreaterThan(0)
    expect(cp2.revision).toBe((cp1.revision ?? 0) + 1)
  })

  it('explicit empty latest-state arrays clear stale todos and active tasks', async () => {
    await updateAutoCheckpoint(ws, 's1', {
      pendingTodos: ['old todo'],
      activeSubAgentIds: ['old-agent'],
    })
    const cp = await updateAutoCheckpoint(ws, 's1', {
      pendingTodos: [],
      activeSubAgentIds: [],
    })
    expect(cp.pendingTodos).toEqual([])
    expect(cp.activeSubAgentIds).toEqual([])
  })

  it('a new session does not inherit prior workspace checkpoint state', async () => {
    await updateAutoCheckpoint(ws, 'old-session', {
      goal: 'old goal',
      completedSteps: ['old step'],
      pendingTodos: ['old todo'],
      artifacts: ['old.txt'],
      turnCount: 30,
    })
    const cp = await updateAutoCheckpoint(ws, 'new-session', {
      goal: 'new goal',
      completedSteps: [],
      pendingTodos: [],
      artifacts: [],
      turnCount: 0,
    })
    expect(cp.sessionId).toBe('new-session')
    expect(cp.goal).toBe('new goal')
    expect(cp.completedSteps).toEqual([])
    expect(cp.pendingTodos).toEqual([])
    expect(cp.artifacts).toEqual([])
    expect(cp.turnCount).toBe(0)
    expect(cp.revision).toBe(1)
  })

  it('update preserves prior goal when not overridden', async () => {
    await updateAutoCheckpoint(ws, 's1', { goal: 'original' })
    const cp = await updateAutoCheckpoint(ws, 's1', { stopReason: 'max_turns' })
    expect(cp.goal).toBe('original')
    expect(cp.stopReason).toBe('max_turns')
  })

  it('turnCount never regresses (takes the max across updates/resume)', async () => {
    await updateAutoCheckpoint(ws, 's1', { turnCount: 42 })
    // A resumed run restarts its in-memory counter from 1.
    const cp = await updateAutoCheckpoint(ws, 's1', { turnCount: 1 })
    expect(cp.turnCount).toBe(42)
    const cp2 = await updateAutoCheckpoint(ws, 's1', { turnCount: 43 })
    expect(cp2.turnCount).toBe(43)
  })

  it('caps checkpoint lists and item lengths', async () => {
    const cp = await updateAutoCheckpoint(ws, 's1', {
      completedSteps: Array.from({ length: 250 }, (_, i) => `${i}:${'x'.repeat(600)}`),
      pendingTodos: Array.from({ length: 150 }, (_, i) => `todo-${i}`),
      artifacts: Array.from({ length: 250 }, (_, i) => `artifact-${i}`),
    })
    expect(cp.completedSteps).toHaveLength(200)
    expect(cp.pendingTodos).toHaveLength(100)
    expect(cp.artifacts).toHaveLength(200)
    expect(cp.completedSteps!.every(item => item.length <= 500)).toBe(true)
  })
})

describe('buildAutoResumePreamble', () => {
  it('returns null for null / empty checkpoint', () => {
    expect(buildAutoResumePreamble(null)).toBeNull()
    expect(buildAutoResumePreamble({ schemaVersion: '1.0', sessionId: 's', updatedAt: 1 })).toBeNull()
  })

  it('includes goal, pending todos and artifacts when present', () => {
    const text = buildAutoResumePreamble({
      schemaVersion: '1.0',
      sessionId: 's',
      updatedAt: 1,
      goal: 'ship feature X',
      completedSteps: ['wrote module'],
      pendingTodos: ['write tests', 'update docs'],
      artifacts: ['src/x.ts'],
      activeSubAgentIds: ['subtask-1'],
      stopReason: 'max_turns',
    })
    expect(text).toBeTruthy()
    expect(text).toContain('ship feature X')
    expect(text).toContain('write tests')
    expect(text).toContain('src/x.ts')
    expect(text).toContain('subtask-1')
    expect(text).toContain('max_turns')
  })
})
