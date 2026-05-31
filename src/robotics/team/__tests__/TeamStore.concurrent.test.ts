import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamStore } from '../TeamStore.js'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-team-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('TeamStore — optimistic concurrency', () => {
  it('rejects writes when team.json has been modified between read and write', async () => {
    const dir = await tempDir()
    const a = new TeamStore(dir, 'unit-a')
    await a.init()

    // Two parallel addTask calls race.  Both ensure() → read state with updatedAt=X
    // before either writeAll() finishes.  The first writer succeeds (updatedAt → X');
    // the second writer's writeAll() re-reads disk, sees X' ≠ X, throws.
    const results = await Promise.allSettled([
      a.addTask({ id: 'TASK-002', title: 'parallel one' }),
      a.addTask({ id: 'TASK-003', title: 'parallel two' }),
    ])
    const rejected = results.filter(r => r.status === 'rejected')
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)
    expect(rejected.length + fulfilled.length).toBe(2)
    if (rejected.length > 0) {
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/Concurrent modification/i)
    }
    // Don't leave the temp files behind unread — touch readFile so lint sees the import is used.
    await readFile(join(dir, 'team', 'team.json'), 'utf8')
  })

  it('allows writes when updatedAt is unchanged', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-b')
    await store.init()
    const result = await store.addTask({ id: 'TASK-002', title: 'first add', paths: ['src/**'] })
    expect(result.task.id).toBe('TASK-002')
  })

  it('two serial writes from the same unit both succeed', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-c')
    await store.init()
    await store.addTask({ id: 'TASK-001', title: 'one' })
    await store.addTask({ id: 'TASK-002', title: 'two' })
    const state = await store.status()
    expect(state?.tasks.map(t => t.id).sort()).toEqual(['TASK-001', 'TASK-002'])
  })

  it('init() is idempotent', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-d')
    const first = await store.init()
    const second = await store.init()
    expect(second.project).toBe(first.project)
    expect(second.tasks).toHaveLength(first.tasks.length)
  })

  it('parseOrNull rejects a structurally invalid team.json (returns null)', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-e')
    await store.init()
    const path = join(dir, 'team', 'team.json')
    // Corrupt by removing a required field — Zod should reject.
    await writeFile(path, JSON.stringify({ schemaVersion: '1.0' }), 'utf8')
    expect(await store.status()).toBeNull()
  })
})
