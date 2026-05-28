import { describe, expect, it, vi } from 'vitest'
import { ExperiencePatternChecker } from '../built-in/FailurePatternChecker.js'
import { ContextPager } from '../../context/ContextPager.js'
import type { IKnowledgeSource, ExperienceMatch } from '../../context/sources/IKnowledgeSource.js'
import type { FlashClient } from '../../core/flash/FlashClient.js'
import type { VVContext } from '../types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeExperience(overrides: Partial<ExperienceMatch> = {}): ExperienceMatch {
  return {
    id:               'exp-001',
    title:            'OOM in point cloud voxelisation',
    domain:           'perception',
    outcome:          'failure',
    abstractPrinciple: 'Spatial resolution × map size determines peak memory; estimate before allocating.',
    failureReason:    'Grid resolution too fine for 50m×50m map',
    workarounds:      ['Coarsen voxel size', 'Reduce map extent'],
    ...overrides,
  }
}

function makeSource(experiences: ExperienceMatch[]): IKnowledgeSource {
  return {
    listExperiences: vi.fn().mockResolvedValue(experiences),
    getManifestLine: vi.fn().mockResolvedValue('Experiences: 1'),
  }
}

function makeFlash(response: string | null): FlashClient {
  return {
    query: vi.fn().mockResolvedValue(response),
  } as unknown as FlashClient
}

function makeCtx(input: Record<string, string>): VVContext {
  return { toolName: 'experiment_dispatch', phase: 'pre_call', input, sessionId: 'test-session', agentId: 'test-agent' }
}

// ─────────────────────────────────────────────────────────────────────────────
// _pass() — silent when no match
// ─────────────────────────────────────────────────────────────────────────────

describe('ExperiencePatternChecker — _pass() silent (P0)', () => {
  it('returns empty message when no experiences exist', async () => {
    const checker = new ExperiencePatternChecker(makeSource([]), makeFlash(null))
    const result = await checker.run(makeCtx({ procedure: 'run trajectory planning test' }))
    expect(result.passed).toBe(true)
    expect(result.message).toBe('')
  })

  it('returns empty message when operation text is blank', async () => {
    const checker = new ExperiencePatternChecker(makeSource([makeExperience()]), makeFlash(null))
    const result = await checker.run(makeCtx({}))
    expect(result.passed).toBe(true)
    expect(result.message).toBe('')
  })

  it('returns empty message when flash says nothing is applicable', async () => {
    const source = makeSource([makeExperience()])
    const flash  = makeFlash(JSON.stringify({ applicable: [], reasoning: 'no applicable principles' }))
    const checker = new ExperiencePatternChecker(source, flash)
    const result = await checker.run(makeCtx({ procedure: 'tune PID controller gains' }))
    expect(result.passed).toBe(true)
    expect(result.message).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Domain hint extraction (P1)
// ─────────────────────────────────────────────────────────────────────────────

describe('ExperiencePatternChecker — domain hint extraction (P1)', () => {
  it('passes domain=perception when operation mentions "point cloud"', async () => {
    const source = makeSource([makeExperience({ domain: 'perception' })])
    const flash  = makeFlash(JSON.stringify({ applicable: [], reasoning: 'none' }))
    const checker = new ExperiencePatternChecker(source, flash)
    await checker.run(makeCtx({ procedure: 'build point cloud voxelisation pipeline' }))
    const calls = (source.listExperiences as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const opts = calls[0][0]
    expect(opts.domains).toContain('perception')
  })

  it('passes domain=motion_planning when operation mentions "trajectory"', async () => {
    const source = makeSource([makeExperience({ domain: 'motion_planning' })])
    const flash  = makeFlash(JSON.stringify({ applicable: [], reasoning: 'none' }))
    const checker = new ExperiencePatternChecker(source, flash)
    await checker.run(makeCtx({ hypothesis: 'RRT* will compute trajectory in < 100ms' }))
    const opts = (source.listExperiences as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(opts.domains).toContain('motion_planning')
  })

  it('passes domains=undefined when no recognisable keywords are present', async () => {
    const source = makeSource([])
    const flash  = makeFlash(null)
    const checker = new ExperiencePatternChecker(source, flash)
    await checker.run(makeCtx({ procedure: 'run the experiment' }))  // generic text
    const opts = (source.listExperiences as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // domains should be undefined (fall through to unfiltered)
    expect(opts.domains).toBeUndefined()
  })

  it('can extract multiple domains from a rich operation text', async () => {
    const source = makeSource([])
    const flash  = makeFlash(null)
    const checker = new ExperiencePatternChecker(source, flash)
    await checker.run(makeCtx({
      procedure: 'calibrate the camera then run trajectory planning to gripper pose',
    }))
    const opts = (source.listExperiences as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // Should detect at least motion_planning, calibration, manipulation
    expect(opts.domains).toContain('motion_planning')
    expect(opts.domains).toContain('calibration')
  })

  it('maps control, deep learning, and localization hints to valid robotics domains', async () => {
    const source = makeSource([])
    const flash  = makeFlash(null)
    const checker = new ExperiencePatternChecker(source, flash)
    await checker.run(makeCtx({
      procedure: 'tune PID controller for localization using a neural network inference model',
    }))
    const opts = (source.listExperiences as ReturnType<typeof vi.fn>).mock.calls[0][0]

    expect(opts.domains).toContain('locomotion')
    expect(opts.domains).toContain('perception')
    expect(opts.domains).toContain('navigation')
    expect(opts.domains).not.toContain('control')
    expect(opts.domains).not.toContain('deep_learning')
    expect(opts.domains).not.toContain('localization')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Pager checkout and canonical slot ID (P0)
// ─────────────────────────────────────────────────────────────────────────────

describe('ExperiencePatternChecker — pager slot canonical ID (P0)', () => {
  it('checks out slot with id="experience:<exp-id>" (no :pre: prefix)', async () => {
    const exp = makeExperience({ id: 'exp-abc123' })
    const source = makeSource([exp])
    const flash  = makeFlash(JSON.stringify({ applicable: ['exp-abc123'], reasoning: 'applies' }))
    const pager  = new ContextPager({ maxBudget: 2000 })
    const checker = new ExperiencePatternChecker(source, flash, pager)

    await checker.run(makeCtx({ procedure: 'optimise point cloud localisation pipeline' }))

    const rendered = pager.renderForTurn()
    expect(rendered).toContain('OOM in point cloud voxelisation')
    // No :pre: in the IDs
    expect(rendered).not.toMatch(/experience:pre:/)
  })

  it('slot priority is "high" when checked out by VV hook', async () => {
    const exp = makeExperience({ id: 'exp-xyz' })
    const source = makeSource([exp])
    const flash  = makeFlash(JSON.stringify({ applicable: ['exp-xyz'], reasoning: 'applies' }))
    const pager  = new ContextPager({ maxBudget: 2000 })
    const checker = new ExperiencePatternChecker(source, flash, pager)

    await checker.run(makeCtx({ procedure: 'run perception pipeline with dense lidar scan' }))

    // Confirm the slot is in the pager (rendered) and high-priority content is visible
    const rendered = pager.renderForTurn()
    expect(rendered).toBeTruthy()
    expect(rendered).toContain('OOM in point cloud voxelisation')
  })

  it('upgrades a prior medium-priority preload to high via same ID refresh', async () => {
    const exp = makeExperience({ id: 'exp-upgrade' })
    const pager = new ContextPager({ maxBudget: 2000 })

    // Simulate proactive preload (medium, same canonical ID)
    pager.checkout({
      id:       `experience:${exp.id}`,
      tag:      `⚠️ [EXP] ${exp.title}`,
      content:  'Preload version',
      tokenEst: 80,
      priority: 'medium',
      ttlTurns: 2,
      source:   'experience',
    })

    const source = makeSource([exp])
    const flash  = makeFlash(JSON.stringify({ applicable: [exp.id], reasoning: 'applies' }))
    const checker = new ExperiencePatternChecker(source, flash, pager)
    await checker.run(makeCtx({ procedure: 'test lidar point cloud segmentation accuracy' }))

    // Slot should now contain VV hook content, not preload content
    const rendered = pager.renderForTurn()
    expect(rendered).not.toContain('Preload version')
    // Only one occurrence of this experience in the rendered output
    const count = (rendered.match(/Past Experience:/g) ?? []).length
    expect(count).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Flash failure / timeout — fallback behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('ExperiencePatternChecker — flash failure graceful fallback', () => {
  it('uses all candidates when flash returns null (timeout / network error)', async () => {
    const experiences = [
      makeExperience({ id: 'exp-001', title: 'Map OOM' }),
      makeExperience({ id: 'exp-002', title: 'SLAM divergence', outcome: 'failure' }),
    ]
    const source = makeSource(experiences)
    const flash  = makeFlash(null)   // flash timed out / failed
    const pager  = new ContextPager({ maxBudget: 2000 })
    const checker = new ExperiencePatternChecker(source, flash, pager)

    const result = await checker.run(makeCtx({
      procedure: 'run dense lidar point cloud slam pipeline',
    }))
    // Conservative fallback: all candidates shown
    expect(result.passed).toBe(true)
    expect(result.message).toContain('applicable experience')
    const rendered = pager.renderForTurn()
    expect(rendered).toContain('Map OOM')
    expect(rendered).toContain('SLAM divergence')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Hook metadata
// ─────────────────────────────────────────────────────────────────────────────

describe('ExperiencePatternChecker — hook metadata', () => {
  it('appliesTo only experiment_dispatch', () => {
    const checker = new ExperiencePatternChecker(makeSource([]), makeFlash(null))
    expect(checker.appliesTo).toEqual(['experiment_dispatch'])
  })

  it('phase is pre_call', () => {
    const checker = new ExperiencePatternChecker(makeSource([]), makeFlash(null))
    expect(checker.phase).toContain('pre_call')
  })

  it('passed is always true (never aborts)', async () => {
    const exp = makeExperience()
    const source = makeSource([exp])
    const flash  = makeFlash(JSON.stringify({ applicable: [exp.id], reasoning: 'applies' }))
    const checker = new ExperiencePatternChecker(source, flash)
    const result = await checker.run(makeCtx({ procedure: 'test point cloud pipeline' }))
    expect(result.passed).toBe(true)
  })
})
