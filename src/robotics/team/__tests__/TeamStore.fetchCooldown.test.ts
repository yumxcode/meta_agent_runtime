import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamStore } from '../TeamStore.js'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-team-fetch-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('TeamStore — git fetch cooldown', () => {
  it('msSinceLastFetch starts at +Infinity', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-fetch-1')
    expect(store.msSinceLastFetch()).toBe(Number.POSITIVE_INFINITY)
  })

  it('sync({fetch:false}) never runs git and never updates _lastFetchAt', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-fetch-2')
    await store.init('https://github.com/acme/demo')
    const summary = await store.sync({ fetch: false, updatePresence: false, writeActivity: false })
    expect(summary.gitFetched).toBe(false)
    expect(store.msSinceLastFetch()).toBe(Number.POSITIVE_INFINITY)
  })

  // We deliberately avoid testing the actual `git fetch` call here — that
  // requires a real git repo with a remote.  The behaviour is covered by the
  // logical guard in TeamStore.sync(): `if (fetch && !cooldownActive)`.
})
