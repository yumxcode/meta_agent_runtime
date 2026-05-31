import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamStore } from '../TeamStore.js'

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-team-views-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function waitForFile(path: string, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await readFile(path)
      return
    } catch {
      await new Promise(r => setTimeout(r, 10))
    }
  }
  throw new Error(`File never appeared: ${path}`)
}

describe('TeamStore — markdown view writes (v2.0)', () => {
  it('writes board.md, log.md, goals.md, README.md after init', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-view')
    await store.init()
    for (const f of ['board.md', 'log.md', 'goals.md', 'README.md']) {
      await waitForFile(join(dir, 'team', f))
    }
  })

  it('does NOT generate the deprecated modules.md / units.md / decisions.md / activity.md', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-no-legacy')
    await store.init()
    // give fire-and-forget view writes a chance
    await new Promise(r => setTimeout(r, 100))
    const entries = await readdir(join(dir, 'team'))
    expect(entries).not.toContain('modules.md')
    expect(entries).not.toContain('units.md')
    expect(entries).not.toContain('decisions.md')
    expect(entries).not.toContain('activity.md')
  })

  it('README.md describes the v2.0 commit boundary', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-readme')
    await store.init()
    await waitForFile(join(dir, 'team', 'README.md'))
    const content = await readFile(join(dir, 'team', 'README.md'), 'utf8')
    expect(content).toContain('Source of truth')
    expect(content).toContain('team.json')
    expect(content).toContain('board.md')
    expect(content).toContain('log.md')
    expect(content).toContain('v2.0')
  })

  it('leaves no .tmp files in team/ after a write completes', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-tmp')
    await store.init()
    await store.addTask({ id: 'TASK-002', title: 'view test' })
    await new Promise(r => setTimeout(r, 100))
    const entries = await readdir(join(dir, 'team'))
    expect(entries.filter(e => e.endsWith('.tmp'))).toEqual([])
  })
})
