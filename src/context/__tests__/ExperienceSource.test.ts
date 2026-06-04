import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { ExperienceStore } from '../../robotics/ExperienceStore.js'
import { ExperienceSource } from '../sources/ExperienceSource.js'
import type { RoboticsDomain } from '../../robotics/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Temp-dir lifecycle
// ─────────────────────────────────────────────────────────────────────────────

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-expsrc-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function writeEntry(
  store: ExperienceStore,
  domain: RoboticsDomain,
  title: string,
  success: boolean,
  abstractPrinciple?: string,
) {
  return store.write({
    domain,
    title,
    tags: [],
    difficulty: 'medium',
    problem: `Problem for ${title}`,
    solution: `Solution for ${title}`,
    outcome: {
      success,
      summary: `Outcome for ${title}`,
      failureReason: success ? undefined : `Root cause for ${title}`,
    },
    abstractPrinciple,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// listExperiences — domain filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('ExperienceSource — listExperiences domain filtering', () => {
  it('returns all entries when no domain filter is provided', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    await writeEntry(store, 'perception',     'Camera OOM',       false)
    await writeEntry(store, 'motion_planning', 'RRT timeout',     false)
    await writeEntry(store, 'navigation',      'Costmap error',   false)
    const source = new ExperienceSource(store)
    const results = await source.listExperiences()
    expect(results).toHaveLength(3)
  })

  it('filters to matching domain when one domain is given', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    await writeEntry(store, 'perception',     'Camera OOM',       false)
    await writeEntry(store, 'motion_planning', 'RRT timeout',     false)
    const source = new ExperienceSource(store)
    const results = await source.listExperiences({ domains: ['perception'] })
    expect(results).toHaveLength(1)
    expect(results[0].domain).toBe('perception')
    expect(results[0].title).toBe('Camera OOM')
  })

  it('filters to multiple domains when multiple are given', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    await writeEntry(store, 'perception',     'Lidar OOM',        false)
    await writeEntry(store, 'motion_planning', 'Path failure',    false)
    await writeEntry(store, 'calibration',    'Extrinsic drift',  false)
    const source = new ExperienceSource(store)
    const results = await source.listExperiences({ domains: ['perception', 'calibration'] })
    expect(results).toHaveLength(2)
    const domains = results.map(r => r.domain)
    expect(domains).toContain('perception')
    expect(domains).toContain('calibration')
    expect(domains).not.toContain('motion_planning')
  })

  it('returns empty array when domain filter matches nothing', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    await writeEntry(store, 'perception', 'Camera OOM', false)
    const source = new ExperienceSource(store)
    const results = await source.listExperiences({ domains: ['locomotion'] })
    expect(results).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// listExperiences — both successes and failures
// ─────────────────────────────────────────────────────────────────────────────

describe('ExperienceSource — includes both successes and failures', () => {
  it('returns successful experiences alongside failures', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    await writeEntry(store, 'perception', 'OOM failure',      false)
    await writeEntry(store, 'perception', 'Optimised success', true)
    const source = new ExperienceSource(store)
    const results = await source.listExperiences()
    const outcomes = results.map(r => r.outcome)
    expect(outcomes).toContain('success')
    expect(outcomes).toContain('failure')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// listExperiences — keyword candidate expansion
// ─────────────────────────────────────────────────────────────────────────────

describe('ExperienceSource — keyword candidate expansion', () => {
  it('can retrieve keyword-relevant entries within a broad domain candidate pool', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    for (let i = 0; i < 20; i++) {
      await writeEntry(store, 'perception', `Generic camera lesson ${i}`, true)
    }
    await store.write({
      domain: 'perception',
      title: 'Voxel grid OOM in dense lidar mapping',
      tags: ['voxel', 'lidar'],
      difficulty: 'high',
      problem: 'Dense point cloud voxelisation exhausted memory.',
      solution: 'Estimate voxel count from map extent before allocation.',
      outcome: { success: false, summary: 'Voxel memory exceeded budget.' },
      abstractPrinciple: 'Voxel resolution and map extent determine peak memory.',
      confidenceTier: 'observed',
    })

    const source = new ExperienceSource(store)
    const results = await source.listExperiences({
      domains: ['perception'],
      keywords: ['voxel', 'lidar'],
      limit: 5,
    })

    expect(results.map(r => r.title)).toContain('Voxel grid OOM in dense lidar mapping')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// abstractPrinciple fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('ExperienceSource — abstractPrinciple fallback', () => {
  it('uses abstractPrinciple when stored', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    await writeEntry(store, 'perception', 'Camera OOM', false, 'Allocate memory budgets up front.')
    const source = new ExperienceSource(store)
    const [result] = await source.listExperiences()
    expect(result.abstractPrinciple).toBe('Allocate memory budgets up front.')
  })

  it('falls back to outcome.summary when abstractPrinciple is absent (older entries)', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    // Write without abstractPrinciple
    await writeEntry(store, 'perception', 'Old entry without principle', false, undefined)
    const source = new ExperienceSource(store)
    const [result] = await source.listExperiences()
    // Should fall back to the outcome summary, not undefined
    expect(result.abstractPrinciple).toBeTruthy()
    expect(typeof result.abstractPrinciple).toBe('string')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// confidence metadata
// ─────────────────────────────────────────────────────────────────────────────

describe('ExperienceSource — confidence metadata', () => {
  it('exposes confidence metadata for prompt weighting', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    await store.write({
      domain: 'perception',
      title: 'Repeated camera timestamp skew',
      tags: [],
      difficulty: 'high',
      problem: 'Stereo frames drifted under CPU contention.',
      solution: 'Pin capture threads and verify timestamp monotonicity.',
      outcome: { success: false, summary: 'Timestamp skew reproduced twice.' },
      confidenceTier: 'reproduced',
      observationCount: 2,
      contradictionCount: 0,
      evidenceRefs: ['logs/stereo-skew-001.txt'],
    })

    const source = new ExperienceSource(store)
    const [result] = await source.listExperiences()

    expect(result.confidenceTier).toBe('reproduced')
    expect(result.observationCount).toBe(2)
    expect(result.contradictionCount).toBe(0)
    expect(result.evidenceRefs).toEqual(['logs/stereo-skew-001.txt'])
  })

  it('prefers stronger confidence before recency', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    await store.write({
      domain: 'navigation',
      title: 'Older reproduced lesson',
      tags: [],
      difficulty: 'medium',
      problem: 'Problem',
      solution: 'Solution',
      outcome: { success: true, summary: 'Repeatedly verified.' },
      confidenceTier: 'reproduced',
      observationCount: 3,
    })
    await new Promise(r => setTimeout(r, 10))
    await store.write({
      domain: 'navigation',
      title: 'Newer hypothesis',
      tags: [],
      difficulty: 'medium',
      problem: 'Problem',
      solution: 'Solution',
      outcome: { success: true, summary: 'Plausible but untested.' },
      confidenceTier: 'hypothesis',
    })

    const source = new ExperienceSource(store)
    const results = await source.listExperiences({ limit: 2 })

    expect(results[0].title).toBe('Older reproduced lesson')
  })

  it('prioritizes same robot and same algorithm when ranking candidates', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    await store.write({
      domain: 'locomotion',
      title: 'Generic newer controller lesson',
      tags: [],
      difficulty: 'medium',
      problem: 'Problem',
      solution: 'Solution',
      outcome: { success: true, summary: 'Generic controller tuning worked.' },
      confidenceTier: 'observed',
    })
    await new Promise(r => setTimeout(r, 10))
    await store.write({
      domain: 'locomotion',
      title: 'Go2 MPC torque saturation lesson',
      tags: ['mpc'],
      robot: 'go2',
      algorithm: 'MPC',
      difficulty: 'high',
      problem: 'MPC torque commands saturated on Go2.',
      solution: 'Clamp commands against measured actuator limits.',
      outcome: { success: true, summary: 'MPC remained stable after clamping.' },
      confidenceTier: 'observed',
    })

    const source = new ExperienceSource(store)
    const results = await source.listExperiences({
      domains: ['locomotion'],
      robot: 'go2',
      currentQuery: 'Tune the MPC controller on Go2',
      limit: 2,
    })

    expect(results[0].title).toBe('Go2 MPC torque saturation lesson')
    expect(results[0].algorithm).toBe('MPC')
    expect(results[0].robot).toBe('go2')
  })

  it('prioritizes evidence-backed low-contradiction lessons over contradicted ones', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    await store.write({
      domain: 'perception',
      title: 'Contradicted lidar lesson',
      tags: ['lidar'],
      difficulty: 'medium',
      problem: 'Problem',
      solution: 'Solution',
      outcome: { success: true, summary: 'Initially appeared to work.' },
      confidenceTier: 'observed',
      contradictionCount: 4,
    })
    await new Promise(r => setTimeout(r, 10))
    await store.write({
      domain: 'perception',
      title: 'Evidence-backed lidar lesson',
      tags: ['lidar'],
      difficulty: 'medium',
      problem: 'Lidar timestamps drifted under load.',
      solution: 'Pin capture threads and verify monotonic timestamps.',
      outcome: { success: true, summary: 'Timestamp check prevented drift.' },
      confidenceTier: 'observed',
      evidenceRefs: ['logs/lidar-timestamps.txt'],
      contradictionCount: 0,
    })

    const source = new ExperienceSource(store)
    const results = await source.listExperiences({
      domains: ['perception'],
      keywords: ['lidar'],
      limit: 2,
    })

    expect(results[0].title).toBe('Evidence-backed lidar lesson')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// listExperiences — limit
// ─────────────────────────────────────────────────────────────────────────────

describe('ExperienceSource — limit enforcement', () => {
  it('respects the limit parameter', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    for (let i = 0; i < 8; i++) {
      await writeEntry(store, 'navigation', `Entry ${i}`, true)
    }
    const source = new ExperienceSource(store)
    const results = await source.listExperiences({ limit: 3 })
    expect(results).toHaveLength(3)
  })

  it('returns most recent entries first', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    await writeEntry(store, 'navigation', 'Older entry', false)
    await new Promise(r => setTimeout(r, 10))
    await writeEntry(store, 'navigation', 'Newer entry', true)
    const source = new ExperienceSource(store)
    const results = await source.listExperiences({ limit: 2 })
    expect(results[0].title).toBe('Newer entry')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// getManifestLine
// ─────────────────────────────────────────────────────────────────────────────

describe('ExperienceSource — getManifestLine()', () => {
  it('returns placeholder when store is empty', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    const source = new ExperienceSource(store)
    const line = await source.getManifestLine()
    expect(line).toMatch(/none yet/)
  })

  it('includes total count and failure count', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    await writeEntry(store, 'perception', 'Success entry',  true)
    await writeEntry(store, 'perception', 'Failure entry', false)
    const source = new ExperienceSource(store)
    const line = await source.getManifestLine()
    expect(line).toMatch(/2 total/)
    expect(line).toMatch(/failures: 1/)
  })

  it('counts more than the search result cap', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    for (let i = 0; i < 25; i++) {
      await writeEntry(store, 'general', `Entry ${i}`, i % 2 === 0)
    }
    const source = new ExperienceSource(store)
    const line = await source.getManifestLine()

    expect(line).toMatch(/25 total/)
  })
})
