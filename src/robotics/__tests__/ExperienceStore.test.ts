import { mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { ExperienceStore, isExperienceId } from '../ExperienceStore.js'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-expstore-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('ExperienceStore id validation', () => {
  it('accepts generated experience IDs', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    const id = await store.write({
      domain: 'general',
      title: 'Valid id',
      tags: [],
      difficulty: 'medium',
      problem: 'Problem',
      solution: 'Solution',
      outcome: { success: true, summary: 'Succeeded' },
    })

    expect(isExperienceId(id)).toBe(true)
    await expect(store.load(id)).resolves.toMatchObject({ id, title: 'Valid id' })
  })

  it('rejects path traversal IDs before reading from disk', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)

    expect(isExperienceId('../../outside')).toBe(false)
    await expect(store.load('../../outside')).resolves.toBeNull()
  })

  it('updates manifest/index incrementally without re-reading existing full records', async () => {
    const dir = await tempDir()
    const store = new ExperienceStore(dir)
    const first = await store.write({
      domain: 'general',
      title: 'First',
      tags: [],
      difficulty: 'medium',
      problem: 'P1',
      solution: 'S1',
      outcome: { success: true, summary: 'ok' },
    })
    await writeFile(join(dir, `${first}.json`), '{corrupt on purpose', 'utf-8')

    await store.write({
      domain: 'general',
      title: 'Second',
      tags: [],
      difficulty: 'medium',
      problem: 'P2',
      solution: 'S2',
      outcome: { success: true, summary: 'ok' },
    })

    const results = await store.search({ domain: 'general', limit: 10 })
    expect(results.map(item => item.title)).toEqual(expect.arrayContaining(['First', 'Second']))
    // The incremental path must not have READ the corrupted record — if it had,
    // readJsonFile would have quarantined it. Match on the suffix rather than an
    // exact filename: the quarantine name now carries a timestamp
    // (`<file>.<ts>.corrupt`, so a second corruption can't overwrite the first
    // forensic copy), and asserting the old exact name would pass vacuously
    // whether or not a quarantine happened.
    const quarantined = (await readdir(dir)).filter(
      name => name.startsWith(`${first}.json.`) && name.endsWith('.corrupt'),
    )
    expect(quarantined).toEqual([])
  })
})
