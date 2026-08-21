/**
 * Manifest integrity for the two knowledge stores whose index is a shared,
 * read-modify-write file.
 *
 * Entries live in per-id JSON files (no contention), but PRINCIPLE_MANIFEST /
 * PHYSICAL_ANCHOR_MANIFEST are read → merged → rewritten on every write. Those
 * two stores were the only ones doing that WITHOUT a lock (ExperienceStore has
 * always guarded its shared summary with withFileLock), so concurrent writes —
 * routine in robotics mode, where experiment_dispatch fans out async sub-agents
 * alongside the main agent — silently dropped an entry. The file stayed on
 * disk, the manifest stayed structurally valid, and the entry became
 * permanently invisible to search().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PrincipleStore } from '../PrincipleStore.js'
import { PhysicalAnchorStore } from '../PhysicalAnchorStore.js'
import { atomicWriteJson } from '../../infra/persist/index.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'kmc-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function principle(title: string) {
  return {
    title,
    statement: `${title} statement`,
    mechanism: 'mech',
    domains: ['locomotion'],
    abstractionLevel: 'mechanism' as const,
    confidenceTier: 'observed' as const,
    firstPrinciplesSupport: [],
    preconditions: [],
    applicabilityBounds: [],
    nonApplicableWhen: [],
    derivedFromExperienceIds: [],
    anchoredByPhysicalAnchorIds: [],
    observationCount: 1,
    contradictionCount: 0,
    evidenceRefs: [],
  }
}

function anchor(title: string) {
  return {
    title,
    fact: `${title} fact`,
    implication: 'impl',
    domain: 'locomotion',
    scope: 'global' as const,
    confidenceTier: 'observed' as const,
    tags: [],
    evidenceRefs: [],
    observationCount: 1,
    contradictionCount: 0,
  }
}

describe('PrincipleStore manifest', () => {
  it('keeps every entry when writes race', async () => {
    const store = new PrincipleStore(dir)
    // Seed FIRST so a structurally valid manifest exists. Without it the very
    // first concurrent batch all miss the manifest and fall into the
    // rebuild-from-files path, which masks the lost-update window.
    const seed = await store.write(principle('seed') as never)

    const N = 12
    const ids = await Promise.all(
      Array.from({ length: N }, (_, i) => store.write(principle(`p${i}`) as never)),
    )
    expect(new Set(ids).size).toBe(N)

    const found = await store.search({ limit: 20 })
    expect(new Set(found.map(p => p.id))).toEqual(new Set([seed, ...ids]))
  })

  it('self-heals a manifest that has fallen behind the files on disk', async () => {
    const store = new PrincipleStore(dir)
    const a = await store.write(principle('kept') as never)
    const b = await store.write(principle('dropped') as never)

    // Simulate the lost update the lock now prevents: a structurally VALID
    // manifest that is simply missing one entry. Before the fix this was
    // accepted as-is and `dropped` was invisible forever.
    const manifestPath = join(dir, 'PRINCIPLE_MANIFEST.json')
    const stale = JSON.parse(await readFile(manifestPath, 'utf-8')) as { entries: { id: string }[] }
    stale.entries = stale.entries.filter(e => e.id === a)
    await atomicWriteJson(manifestPath, { ...stale, schemaVersion: '1.0', updatedAt: Date.now() })

    const found = await store.search({ limit: 20 })
    expect(new Set(found.map(p => p.id))).toEqual(new Set([a, b]))
  })
})

describe('PhysicalAnchorStore manifest', () => {
  it('keeps every entry when writes race', async () => {
    const store = new PhysicalAnchorStore(dir)
    // See the PrincipleStore case: seed first so a valid manifest exists and
    // the racing writes take the read-modify-write path, not the rebuild path.
    const seed = await store.write(anchor('seed') as never)

    const N = 12
    const ids = await Promise.all(
      Array.from({ length: N }, (_, i) => store.write(anchor(`a${i}`) as never)),
    )
    expect(new Set(ids).size).toBe(N)

    const found = await store.search({ limit: 20 })
    expect(new Set(found.map(p => p.id))).toEqual(new Set([seed, ...ids]))
  })

  it('keeps entries when write and outcome-signal updates interleave', async () => {
    const store = new PhysicalAnchorStore(dir)
    const seed = await store.write(anchor('seed') as never)
    await Promise.all([
      store.write(anchor('concurrent-1') as never),
      store.recordObservation(seed),
      store.write(anchor('concurrent-2') as never),
      store.recordContradiction(seed),
    ])
    const found = await store.search({ limit: 20 })
    expect(found).toHaveLength(3)
    const updated = found.find(a => a.id === seed)!
    // Both signals landed on the entry file itself.
    expect((updated.observationCount ?? 0) + (updated.contradictionCount ?? 0)).toBeGreaterThan(1)
  })

  it('self-heals a manifest that has fallen behind the files on disk', async () => {
    const store = new PhysicalAnchorStore(dir)
    const a = await store.write(anchor('kept') as never)
    const b = await store.write(anchor('dropped') as never)

    const manifestPath = join(dir, 'PHYSICAL_ANCHOR_MANIFEST.json')
    const stale = JSON.parse(await readFile(manifestPath, 'utf-8')) as { entries: { id: string }[] }
    stale.entries = stale.entries.filter(e => e.id === a)
    await atomicWriteJson(manifestPath, { ...stale, schemaVersion: '1.0', updatedAt: Date.now() })

    const found = await store.search({ limit: 20 })
    expect(new Set(found.map(p => p.id))).toEqual(new Set([a, b]))
  })
})
