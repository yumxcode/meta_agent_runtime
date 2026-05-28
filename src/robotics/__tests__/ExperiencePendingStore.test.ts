import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { ExperiencePendingStore, validateExperienceInput } from '../ExperiencePendingStore.js'

const tempDirs: string[] = []

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-pending-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('ExperiencePendingStore persistence', () => {
  it('serializes add/remove persistence so removed entries do not reappear after reload', async () => {
    const project = await tempProject()
    const root = await tempProject()
    const store = new ExperiencePendingStore(project, root)

    const pendingId = store.add({ title: 'temporary' })
    expect(store.remove(pendingId)).toBe(true)
    await store.flush()

    const reloaded = new ExperiencePendingStore(project, root)
    await reloaded.load()
    expect(reloaded.count).toBe(0)
  })

  it('persists the latest pending queue after rapid additions', async () => {
    const project = await tempProject()
    const root = await tempProject()
    const store = new ExperiencePendingStore(project, root)

    store.add({ title: 'one' })
    store.add({ title: 'two' })
    await store.flush()

    const reloaded = new ExperiencePendingStore(project, root)
    await reloaded.load()
    expect(reloaded.count).toBe(2)
    reloaded.clear()
    await reloaded.flush()
  })
})

describe('ExperiencePendingStore validation', () => {
  const baseInput = {
    domain: 'general',
    title: 'Lesson',
    problem: 'Problem',
    solution: 'Solution',
    outcome_summary: 'Outcome',
  }

  it('parses string "false" as false instead of truthy', () => {
    const normalized = validateExperienceInput({ ...baseInput, success: 'false' })

    expect(normalized.ok).toBe(true)
    if (normalized.ok) expect(normalized.value.success).toBe(false)
  })

  it('rejects non-boolean success values that are not explicit true/false strings', () => {
    const normalized = validateExperienceInput({ ...baseInput, success: 'no' })

    expect(normalized.ok).toBe(false)
  })
})
