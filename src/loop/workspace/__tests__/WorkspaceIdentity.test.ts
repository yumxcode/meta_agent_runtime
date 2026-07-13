import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  ensureWorkspaceIdentity,
  forkWorkspaceIdentity,
  workspaceIdentityPath,
} from '../WorkspaceIdentity.js'

describe('WorkspaceIdentity', () => {
  it('is stable for one workspace and unique across workspaces', async () => {
    const a = await mkdtemp(join(tmpdir(), 'loop-workspace-a-'))
    const b = await mkdtemp(join(tmpdir(), 'loop-workspace-b-'))
    const a1 = await ensureWorkspaceIdentity(a)
    const a2 = await ensureWorkspaceIdentity(a)
    const b1 = await ensureWorkspaceIdentity(b)
    expect(a2).toEqual(a1)
    expect(b1.workspaceId).not.toBe(a1.workspaceId)
    expect(JSON.parse(await readFile(workspaceIdentityPath(a), 'utf-8'))).toEqual(a1)
  })

  it('forks a copied workspace and transactionally rebinds instance records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-workspace-fork-'))
    const before = await ensureWorkspaceIdentity(dir)
    const instanceDir = join(dir, '.loop', 'example-v1')
    await mkdir(instanceDir, { recursive: true })
    await writeFile(join(instanceDir, 'instance.json'), JSON.stringify({
      schemaVersion: '1.0', instanceId: 'example-v1', workspaceId: before.workspaceId,
      updatedAt: 1,
    }), 'utf-8')
    const after = await forkWorkspaceIdentity(dir)
    expect(after.workspaceId).not.toBe(before.workspaceId)
    expect(after.forkedFrom).toBe(before.workspaceId)
    const record = JSON.parse(await readFile(join(instanceDir, 'instance.json'), 'utf-8'))
    expect(record.workspaceId).toBe(after.workspaceId)
  })
})
