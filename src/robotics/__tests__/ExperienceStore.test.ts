import { mkdtemp, rm } from 'fs/promises'
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
})
