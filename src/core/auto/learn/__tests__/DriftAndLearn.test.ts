import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeAutoDriftGate, parseDriftVerdict } from '../DriftAgent.js'
import { buildDriftCorrectionPrompt } from '../../../../kernel/loop/DriftGate.js'
import {
  createAutoExperienceStore,
  writeAutoExperience,
  renderRecentExperiences,
} from '../AutoExperienceStore.js'
import {
  updateAutoCheckpoint,
  readAutoCheckpoint,
} from '../../AutoCheckpointStore.js'

describe('parseDriftVerdict', () => {
  it('parses a drifted verdict with corrective steps', () => {
    const v = parseDriftVerdict('review...\n```json\n{"drifted": true, "severity": "major", "corrective": ["refocus on auth"], "note": "building unrelated UI"}\n```')
    expect(v!.drifted).toBe(true)
    expect(v!.severity).toBe('major')
    expect(v!.corrective).toEqual(['refocus on auth'])
    expect(v!.note).toContain('unrelated')
  })

  it('parses an on-track verdict', () => {
    const v = parseDriftVerdict('```json\n{"drifted": false, "corrective": []}\n```')
    expect(v!.drifted).toBe(false)
    expect(v!.corrective).toEqual([])
  })

  it('coerces an invalid severity to undefined', () => {
    const v = parseDriftVerdict('```json\n{"drifted": true, "severity": "catastrophic", "corrective": ["x"]}\n```')
    expect(v!.severity).toBeUndefined()
  })

  it('returns null when drifted is missing/non-boolean', () => {
    expect(parseDriftVerdict('```json\n{"corrective": []}\n```')).toBeNull()
    expect(parseDriftVerdict('no json here')).toBeNull()
  })
})

describe('buildDriftCorrectionPrompt', () => {
  it('marks major severity and lists corrective steps', () => {
    const p = buildDriftCorrectionPrompt({ drifted: true, severity: 'major', corrective: ['a', 'b'] })
    expect(p).toContain('严重')
    expect(p).toContain('1. a')
    expect(p).toContain('2. b')
  })
})

describe('AutoDriftGate', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ma-drift-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ } })

  it('skips the drift sub-agent when no checkpoint exists yet', async () => {
    const spawnSubAgent = vi.fn()
    const gate = makeAutoDriftGate({
      dispatcher: {
        spawnSubAgent,
        getStatus: vi.fn(),
        cancelTask: vi.fn(),
      },
      projectDir: dir,
      getGoal: () => 'build a feature',
    })

    const verdict = await gate({
      workspaceRoot: dir,
      turnCount: 0,
      reason: 'turn_interval',
      signal: new AbortController().signal,
    })

    // SKIP (no checkpoint to judge against): drifted:false distinguishes it
    // from a real drift verdict, while skipped:true + note lets KernelLoop apply
    // the configured gate-failure policy with a visible reason.
    expect(verdict).toEqual({
      drifted: false,
      corrective: [],
      skipped: true,
      note: 'checkpoint missing',
    })
    expect(spawnSubAgent).not.toHaveBeenCalled()
  })
})

describe('AutoExperienceStore', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ma-exp-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ } })

  it('returns null recall block when empty', async () => {
    const store = createAutoExperienceStore(dir)
    expect(await renderRecentExperiences(store)).toBeNull()
  })

  it('writes and recalls, surfacing failures first', async () => {
    const store = createAutoExperienceStore(dir)
    await writeAutoExperience(store, {
      title: 'used wrong API', problem: 'p1', solution: 's1',
      success: false, outcome_summary: 'broke build',
      error_source: 'npm run build exit 1', failure_reason: 'deprecated import',
      abstract_principle: 'check API version before using',
    })
    await writeAutoExperience(store, {
      title: 'cached results', problem: 'p2', solution: 's2',
      success: true, outcome_summary: 'sped up tests',
      error_source: 'observed 3x speedup',
    })
    const block = await renderRecentExperiences(store)
    expect(block).not.toBeNull()
    expect(block).toContain('过往经验')
    // failure should appear before success in the rendered block
    const failIdx = block!.indexOf('used wrong API')
    const okIdx = block!.indexOf('cached results')
    expect(failIdx).toBeGreaterThanOrEqual(0)
    expect(okIdx).toBeGreaterThan(failIdx)
    expect(block).toContain('check API version')
  })

  it('dedupes by title: re-writing the same lesson returns the existing id', async () => {
    const store = createAutoExperienceStore(dir)
    const id1 = await writeAutoExperience(store, {
      title: 'same lesson', problem: 'p', solution: 's',
      success: false, outcome_summary: 'o', error_source: 'verify reject',
    })
    const id2 = await writeAutoExperience(store, {
      title: 'same lesson', problem: 'p2', solution: 's2',
      success: false, outcome_summary: 'o2', error_source: 'verify reject again',
    })
    expect(id2).toBe(id1)
    expect(await store.listIds()).toHaveLength(1)
  })
})

describe('checkpoint completedSteps (drift input)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ma-cp-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ } })

  it('records and unions completedSteps across turns', async () => {
    await updateAutoCheckpoint(dir, 'sess-1', { goal: 'g', completedSteps: ['step A'], pendingTodos: ['B', 'C'] })
    await updateAutoCheckpoint(dir, 'sess-1', { completedSteps: ['step B'], pendingTodos: ['C'] })
    const cp = readAutoCheckpoint(dir)
    expect(cp!.goal).toBe('g')
    expect(cp!.completedSteps).toEqual(['step A', 'step B'])  // append-only union
    expect(cp!.pendingTodos).toEqual(['C'])                   // latest snapshot
  })
})
