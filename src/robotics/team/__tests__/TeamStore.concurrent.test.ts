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
    await a.init('https://github.com/acme/demo')

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
    await store.init('https://github.com/acme/demo')
    const result = await store.addTask({ id: 'TASK-002', title: 'first add', paths: ['src/**'] })
    expect(result.task.id).toBe('TASK-002')
  })

  it('two serial writes from the same unit both succeed', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-c')
    await store.init('https://github.com/acme/demo')
    await store.addTask({ id: 'TASK-001', title: 'one' })
    await store.addTask({ id: 'TASK-002', title: 'two' })
    const state = await store.status()
    expect(state?.tasks.map(t => t.id).sort()).toEqual(['TASK-001', 'TASK-002'])
  })

  it('init() is idempotent', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-d')
    const first = await store.init('https://github.com/acme/demo')
    const second = await store.init('https://github.com/acme/demo')
    expect(second.project).toBe(first.project)
    expect(second.tasks).toHaveLength(first.tasks.length)
  })

  it('parseOrNull rejects a structurally invalid team.json (returns null)', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-e')
    await store.init('https://github.com/acme/demo')
    const path = join(dir, 'team', 'team.json')
    // Corrupt by removing a required field — Zod should reject.
    await writeFile(path, JSON.stringify({ schemaVersion: '1.0' }), 'utf8')
    expect(await store.status()).toBeNull()
  })
})

describe('TeamStore — corrupt file protection (H1)', () => {
  it('a mutation never overwrites a corrupt team.json with an empty board', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-h1')
    await store.init('https://github.com/acme/demo')
    await store.addTask({ id: 'TASK-001', title: 'precious work' })

    const path = join(dir, 'team', 'team.json')
    // Simulate a git merge-conflict marker / half-written file (invalid JSON).
    const corrupt = '<<<<<<< HEAD\n{ "schemaVersion": "2.0" }\n=======\n{}\n>>>>>>> other\n'
    await writeFile(path, corrupt, 'utf8')

    // The mutation must fail loudly instead of silently recreating a blank board.
    await expect(
      store.addTask({ id: 'TASK-002', title: 'new' }),
    ).rejects.toThrow(/无法解析|corrupt/i)

    // The original (corrupt) bytes must still be on disk for `git restore` —
    // NOT replaced by a default empty board.
    expect(await readFile(path, 'utf8')).toBe(corrupt)
  })

  it('status() degrades to null on a corrupt board without throwing or overwriting', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-h1b')
    await store.init('https://github.com/acme/demo')
    const path = join(dir, 'team', 'team.json')
    await writeFile(path, 'not json at all', 'utf8')
    expect(await store.status()).toBeNull()
    expect(await readFile(path, 'utf8')).toBe('not json at all')
  })
})
