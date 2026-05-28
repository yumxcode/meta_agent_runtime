import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { isPhysicalAnchorId, PhysicalAnchorStore } from '../PhysicalAnchorStore.js'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-anchors-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('PhysicalAnchorStore', () => {
  it('writes, loads, and validates physical anchor ids', async () => {
    const dir = await tempDir()
    const store = new PhysicalAnchorStore(dir)

    const id = await store.write({
      domain: 'hardware_interface',
      title: 'Motor driver browns out under peak torque',
      fact: 'The 24V rail dips below the driver undervoltage threshold during simultaneous high-torque startup.',
      mechanism: 'Startup current exceeds supply transient response.',
      implication: 'Stagger motor enable or raise bulk capacitance before testing aggressive launch commands.',
      tags: ['power', 'motor'],
      confidenceTier: 'observed',
      evidenceRefs: ['scope_capture_2026-05-28.png'],
    })

    expect(isPhysicalAnchorId(id)).toBe(true)
    await expect(store.load(id)).resolves.toMatchObject({
      id,
      confidenceTier: 'observed',
      domain: 'hardware_interface',
    })
    await expect(store.load('../../outside')).resolves.toBeNull()
  })

  it('searches by domain, tags, and keyword with confidence-aware ranking', async () => {
    const dir = await tempDir()
    const store = new PhysicalAnchorStore(dir)

    await store.write({
      domain: 'perception',
      title: 'Reported camera rolling shutter',
      fact: 'A forum report suggests fast yaw creates rolling-shutter distortion.',
      implication: 'Treat as unverified until measured on the project camera.',
      tags: ['camera'],
      confidenceTier: 'reported',
      evidenceRefs: ['forum thread'],
    })
    await store.write({
      domain: 'perception',
      title: 'Measured lidar thermal drift',
      fact: 'The lidar range bias grows after warmup in the current enclosure.',
      implication: 'Warm up before calibration and compare cold vs warm point clouds.',
      tags: ['lidar', 'thermal'],
      confidenceTier: 'observed',
      evidenceRefs: ['calibration/run-12.csv'],
    })

    const results = await store.search({ domain: 'perception', keyword: 'thermal', limit: 5 })

    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Measured lidar thermal drift')
    expect(await store.search({ tags: ['camera'] })).toHaveLength(1)
  })

  it('formats anchors for prompt injection', async () => {
    const dir = await tempDir()
    const store = new PhysicalAnchorStore(dir)
    await store.write({
      domain: 'deployment',
      title: 'WiFi packet loss near metal cage',
      fact: 'Packet loss spikes when the robot moves behind the metal test cage.',
      implication: 'Prefer wired logging or local buffering during deployment tests.',
      tags: ['network'],
      confidenceTier: 'observed',
      evidenceRefs: [],
    })

    const formatted = await store.formatForPrompt()

    expect(formatted).toContain('## Physical Anchors')
    expect(formatted).toContain('WiFi packet loss')
    expect(formatted).toContain('Implication:')
  })
})
