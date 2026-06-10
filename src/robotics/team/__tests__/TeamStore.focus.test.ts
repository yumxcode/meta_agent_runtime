/**
 * Focus model: a unit may own multiple tasks; `unit.currentTask` is its FOCUS
 * pointer. No-arg done/drop resolve via focus → single-owned → explicit error,
 * never guessing among multiple owned tasks.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamStore } from '../TeamStore.js'
import { renderBoard } from '../render.js'

const GITHUB = 'https://github.com/acme/demo'

const tempDirs: string[] = []
async function makeStore(unit = 'unit-a'): Promise<TeamStore> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-team-focus-'))
  tempDirs.push(dir)
  const store = new TeamStore(dir, unit)
  await store.init(GITHUB)
  await store.addTask({ id: 'TASK-001', title: '步态算法', kind: 'algo' })
  await store.addTask({ id: 'TASK-002', title: '实机标定', kind: 'exp' })
  return store
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('multi-task ownership + focus', () => {
  it('owning two tasks keeps both locks; focus follows the latest take', async () => {
    const store = await makeStore()
    await store.take('TASK-001')
    await store.take('TASK-002')

    const { owned, focusId } = await store.ownedActiveTasks()
    expect(owned.map(t => t.id).sort()).toEqual(['TASK-001', 'TASK-002'])
    expect(focusId).toBe('TASK-002')

    const state = await store.status()
    expect(state?.tasks.find(t => t.id === 'TASK-001')?.ownerUnit).toBe('unit-a')
    expect(state?.tasks.find(t => t.id === 'TASK-002')?.ownerUnit).toBe('unit-a')
  })

  it('focus() switches among owned tasks and rejects unowned ones', async () => {
    const store = await makeStore()
    await store.take('TASK-001')
    await store.take('TASK-002')
    await store.focus('TASK-001')
    expect((await store.ownedActiveTasks()).focusId).toBe('TASK-001')

    await expect(store.focus('TASK-999')).rejects.toThrow(/Unknown team task/)
    await store.drop('TASK-001')
    await expect(store.focus('TASK-001')).rejects.toThrow(/不是你持有的任务/)
  })

  it('no-arg drop acts on focus; with one task left it resolves the single own', async () => {
    const store = await makeStore()
    await store.take('TASK-001')
    await store.take('TASK-002')   // focus = TASK-002

    const dropped = await store.drop()   // → focus task
    expect(dropped.task.id).toBe('TASK-002')

    // Focus cleared, but only one owned task remains → resolves unambiguously.
    const dropped2 = await store.drop()
    expect(dropped2.task.id).toBe('TASK-001')
  })

  it('refuses no-arg resolution when owning multiple tasks without focus', async () => {
    const store = await makeStore()
    await store.addTask({ id: 'TASK-003', title: '场景部署', kind: 'deploy' })
    await store.take('TASK-001')
    await store.take('TASK-002')
    await store.take('TASK-003')   // focus = TASK-003
    await store.drop('TASK-003')   // drops focus → focus cleared, still own 2

    await expect(store.requireOwnTaskId()).rejects.toThrow(/focus 不明确/)
    // Explicit id always works.
    expect(await store.requireOwnTaskId('TASK-001')).toBe('TASK-001')
  })

  it('marking the focus task done clears focus and releases the lock', async () => {
    const store = await makeStore()
    await store.take('TASK-001')
    await store.updateTaskStatus('TASK-001', 'done')
    const { owned, focusId } = await store.ownedActiveTasks()
    expect(owned).toEqual([])
    expect(focusId).toBeUndefined()
  })

  it('board Units line shows owns count and focus', async () => {
    const store = await makeStore()
    await store.take('TASK-001')
    const { state } = await store.take('TASK-002')
    const board = renderBoard(state)
    expect(board).toContain('owns=2')
    expect(board).toContain('focus=TASK-002')
  })
})
