import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamStore, isStaleClaim } from '../TeamStore.js'

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-team-excl-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('TeamStore.take — exclusive ownership', () => {
  it('first take succeeds, sets ownerUnit + claimedAt', async () => {
    const dir = await tempDir()
    const alice = new TeamStore(dir, 'alice')
    await alice.init('https://github.com/acme/demo')
    await alice.addTask({ id: 'TASK-001', title: 'demo' })
    const { task } = await alice.take('TASK-001')
    expect(task.ownerUnit).toBe('alice')
    expect(task.claimedAt).toBeTruthy()
    expect(task.status).toBe('open')
  })

  it('second take by a different unit throws and names the owner', async () => {
    const dir = await tempDir()
    const alice = new TeamStore(dir, 'alice')
    await alice.init('https://github.com/acme/demo')
    await alice.addTask({ id: 'TASK-001', title: 'demo' })
    await alice.take('TASK-001')

    const bob = new TeamStore(dir, 'bob')
    await expect(bob.take('TASK-001')).rejects.toThrow(/alice/)
    await expect(bob.take('TASK-001')).rejects.toThrow(/steal/)
  })

  it('same-owner re-take is a no-op (returns same task without error)', async () => {
    const dir = await tempDir()
    const alice = new TeamStore(dir, 'alice')
    await alice.init('https://github.com/acme/demo')
    await alice.addTask({ id: 'TASK-001', title: 'demo' })
    const first = await alice.take('TASK-001')
    const second = await alice.take('TASK-001')
    expect(second.task.id).toBe(first.task.id)
    expect(second.task.ownerUnit).toBe('alice')
  })

  it('refuses to take a done task', async () => {
    const dir = await tempDir()
    const alice = new TeamStore(dir, 'alice')
    await alice.init('https://github.com/acme/demo')
    await alice.addTask({ id: 'TASK-001', title: 'demo' })
    await alice.take('TASK-001')
    await alice.updateTaskStatus('TASK-001', 'done')
    await expect(alice.take('TASK-001')).rejects.toThrow(/done/)
  })

  it('promotes paused → open on take by current owner', async () => {
    const dir = await tempDir()
    const alice = new TeamStore(dir, 'alice')
    await alice.init('https://github.com/acme/demo')
    await alice.addTask({ id: 'TASK-001', title: 'demo' })
    await alice.take('TASK-001')
    await alice.updateTaskStatus('TASK-001', 'paused')
    // After pause, ownership remains; re-take should remain open after promotion.
    const { task } = await alice.take('TASK-001')
    expect(task.status).toBe('open')
  })
})

describe('TeamStore.drop', () => {
  it('owner can drop; ownership and currentTask clear', async () => {
    const dir = await tempDir()
    const alice = new TeamStore(dir, 'alice')
    await alice.init('https://github.com/acme/demo')
    await alice.addTask({ id: 'TASK-001', title: 'demo' })
    await alice.take('TASK-001')
    const { task, state } = await alice.drop('TASK-001')
    expect(task.ownerUnit).toBeUndefined()
    expect(task.claimedAt).toBeUndefined()
    expect(state.units.find(u => u.id === 'alice')?.currentTask).toBeUndefined()
  })

  it('non-owner cannot drop', async () => {
    const dir = await tempDir()
    const alice = new TeamStore(dir, 'alice')
    await alice.init('https://github.com/acme/demo')
    await alice.addTask({ id: 'TASK-001', title: 'demo' })
    await alice.take('TASK-001')

    const bob = new TeamStore(dir, 'bob')
    await expect(bob.drop('TASK-001')).rejects.toThrow(/alice/)
  })
})

describe('TeamStore.steal', () => {
  it('overrides owner and appends an audit attempt', async () => {
    const dir = await tempDir()
    const alice = new TeamStore(dir, 'alice')
    await alice.init('https://github.com/acme/demo')
    await alice.addTask({ id: 'TASK-001', title: 'demo' })
    await alice.take('TASK-001')

    const bob = new TeamStore(dir, 'bob')
    const { task, previousOwner } = await bob.steal('TASK-001', 'alice 离职')
    expect(previousOwner).toBe('alice')
    expect(task.ownerUnit).toBe('bob')
    const last = task.attempts[task.attempts.length - 1]!
    expect(last.unit).toBe('bob')
    expect(last.direction).toContain('stolen from alice')
    expect(last.outcome).toContain('alice 离职')
  })

  it('on un-owned task behaves like take()', async () => {
    const dir = await tempDir()
    const alice = new TeamStore(dir, 'alice')
    await alice.init('https://github.com/acme/demo')
    await alice.addTask({ id: 'TASK-001', title: 'demo' })
    const { task, previousOwner } = await alice.steal('TASK-001', 'no one')
    expect(previousOwner).toBeUndefined()
    expect(task.ownerUnit).toBe('alice')
    expect(task.attempts).toHaveLength(0)
  })
})

describe('TeamStore.note — attempts log', () => {
  it('owner appends an attempt with direction/outcome/ref', async () => {
    const dir = await tempDir()
    const alice = new TeamStore(dir, 'alice')
    await alice.init('https://github.com/acme/demo')
    await alice.addTask({ id: 'TASK-001', title: 'demo' })
    await alice.take('TASK-001')
    const { task, attempt } = await alice.note({
      taskId: 'TASK-001',
      direction: '试用 ResNet50',
      outcome: '失败，real -2%',
      ref: 'wandb.ai/run-3f2',
    })
    expect(task.attempts).toHaveLength(1)
    expect(attempt.unit).toBe('alice')
    expect(attempt.direction).toBe('试用 ResNet50')
    expect(attempt.ref).toBe('wandb.ai/run-3f2')
  })

  it('non-owner cannot note', async () => {
    const dir = await tempDir()
    const alice = new TeamStore(dir, 'alice')
    await alice.init('https://github.com/acme/demo')
    await alice.addTask({ id: 'TASK-001', title: 'demo' })
    await alice.take('TASK-001')

    const bob = new TeamStore(dir, 'bob')
    await expect(bob.note({ taskId: 'TASK-001', direction: 'x', outcome: 'y' }))
      .rejects.toThrow(/alice/)
  })

  it('refuses note on un-owned task', async () => {
    const dir = await tempDir()
    const alice = new TeamStore(dir, 'alice')
    await alice.init('https://github.com/acme/demo')
    await alice.addTask({ id: 'TASK-001', title: 'demo' })
    await expect(alice.note({ taskId: 'TASK-001', direction: 'x', outcome: 'y' }))
      .rejects.toThrow(/无人持有/)
  })

  it('requires both direction and outcome', async () => {
    const dir = await tempDir()
    const alice = new TeamStore(dir, 'alice')
    await alice.init('https://github.com/acme/demo')
    await alice.addTask({ id: 'TASK-001', title: 'demo' })
    await alice.take('TASK-001')
    await expect(alice.note({ taskId: 'TASK-001', direction: '', outcome: 'y' })).rejects.toThrow(/direction/)
    await expect(alice.note({ taskId: 'TASK-001', direction: 'x', outcome: '' })).rejects.toThrow(/outcome/)
  })

  it('marking done releases the lock and clears unit.currentTask', async () => {
    const dir = await tempDir()
    const alice = new TeamStore(dir, 'alice')
    await alice.init('https://github.com/acme/demo')
    await alice.addTask({ id: 'TASK-001', title: 'demo' })
    await alice.take('TASK-001')
    const { task, state } = await alice.updateTaskStatus('TASK-001', 'done')
    expect(task.status).toBe('done')
    expect(task.ownerUnit).toBeUndefined()
    expect(state.units.find(u => u.id === 'alice')?.currentTask).toBeUndefined()
  })
})

describe('isStaleClaim', () => {
  it('returns false for never-claimed tasks', () => {
    expect(isStaleClaim({ status: 'open' })).toBe(false)
  })
  it('returns false for done tasks', () => {
    expect(isStaleClaim({ status: 'done', claimedAt: '2020-01-01T00:00:00Z' })).toBe(false)
  })
  it('returns true for >7d open claims', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString()
    expect(isStaleClaim({ status: 'open', claimedAt: tenDaysAgo })).toBe(true)
  })
  it('returns false for recent claims', () => {
    expect(isStaleClaim({ status: 'open', claimedAt: new Date().toISOString() })).toBe(false)
  })
})
