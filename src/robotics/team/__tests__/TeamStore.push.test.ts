/**
 * Tests for the publish loop: TeamStore.push() / publishState(), plus the
 * task `kind` lane tag (persisted, rendered, schema-surviving).
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamStore } from '../TeamStore.js'
import { renderBoard } from '../render.js'
import { migrateTeamState } from '../../../core/persist/schemas.js'

const execFileAsync = promisify(execFile)

const tempDirs: string[] = []
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

/** Create a bare "origin" plus a working clone with one initial commit. */
async function makeRepoWithRemote(): Promise<{ work: string; bare: string }> {
  const bare = await tempDir('meta-agent-team-bare-')
  const work = await tempDir('meta-agent-team-work-')
  await git(bare, 'init', '--bare', '--initial-branch=main')
  await git(work, 'init', '--initial-branch=main')
  await git(work, 'config', 'user.email', 'test@example.com')
  await git(work, 'config', 'user.name', 'Test Unit')
  await git(work, 'remote', 'add', 'origin', bare)
  await execFileAsync('bash', ['-c', 'echo hello > README.md'], { cwd: work })
  await git(work, 'add', 'README.md')
  await git(work, 'commit', '-m', 'init')
  await git(work, 'push', '-u', 'origin', 'main')
  return { work, bare }
}

describe('TeamStore.publishState / push', () => {
  it('reports not-a-git-repo gracefully', async () => {
    const dir = await tempDir('meta-agent-team-nogit-')
    const store = new TeamStore(dir, 'unit-a')
    await store.init('https://github.com/acme/demo')
    const state = await store.publishState()
    expect(state.isGitRepo).toBe(false)
    const result = await store.push()
    expect(result.pushed).toBe(false)
    expect(result.message).toContain('git')
  })

  it('detects dirty team/ files, commits ONLY team/, and pushes', async () => {
    const { work, bare } = await makeRepoWithRemote()
    const store = new TeamStore(work, 'unit-a')
    await store.init('https://github.com/acme/demo')
    await store.addTask({ id: 'TASK-001', title: '标定相机外参', kind: 'exp' })

    // Unrelated dirty file must NOT be swallowed into the team commit.
    await execFileAsync('bash', ['-c', 'echo wip > scratch.txt'], { cwd: work })

    const before = await store.publishState()
    expect(before.isGitRepo).toBe(true)
    expect(before.dirty.length).toBeGreaterThan(0)

    const result = await store.push()
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(true)

    // team/ is clean, scratch.txt still dirty
    const after = await store.publishState()
    expect(after.dirty).toEqual([])
    expect(after.unpushedCommits).toBe(0)
    const porcelain = await git(work, 'status', '--porcelain')
    expect(porcelain).toContain('scratch.txt')

    // Remote actually received the team commit
    const remoteLog = await git(bare, 'log', '--oneline', 'main')
    expect(remoteLog).toContain('team(unit-a): board update')
  })

  it('reports nothing-to-publish when team/ is clean and pushed', async () => {
    const { work } = await makeRepoWithRemote()
    const store = new TeamStore(work, 'unit-a')
    await store.init('https://github.com/acme/demo')
    await store.push()
    const second = await store.push()
    expect(second.committed).toBe(false)
    expect(second.pushed).toBe(false)
    expect(second.message).toContain('没有需要发布的变更')
  })
})

describe('TeamTask.kind lane tag', () => {
  it('persists kind through write → read and validates values', async () => {
    const dir = await tempDir('meta-agent-team-kind-')
    const store = new TeamStore(dir, 'unit-a')
    await store.init('https://github.com/acme/demo')
    await store.addTask({ id: 'TASK-001', title: 'ResNet 蒸馏', kind: 'algo' })
    await store.addTask({ id: 'TASK-002', title: '无标签任务' })
    await expect(
      store.addTask({ id: 'TASK-003', title: 'bad', kind: 'invalid' as never }),
    ).rejects.toThrow(/Invalid task kind/)

    const state = await store.status()
    expect(state?.tasks.find(t => t.id === 'TASK-001')?.kind).toBe('algo')
    expect(state?.tasks.find(t => t.id === 'TASK-002')?.kind).toBeUndefined()
  })

  it('kind survives the v2.0 zod schema (not stripped on read)', async () => {
    const dir = await tempDir('meta-agent-team-schema-')
    const store = new TeamStore(dir, 'unit-a')
    await store.init('https://github.com/acme/demo')
    await store.addTask({ id: 'TASK-001', title: '实机回归', kind: 'deploy' })
    const raw = JSON.parse(await readFile(join(dir, 'team', 'team.json'), 'utf8')) as unknown
    const migrated = migrateTeamState(raw)
    expect(migrated?.tasks[0]?.kind).toBe('deploy')
  })

  it('renderBoard shows the lane label', async () => {
    const dir = await tempDir('meta-agent-team-render-')
    const store = new TeamStore(dir, 'unit-a')
    await store.init('https://github.com/acme/demo')
    const { state } = await store.addTask({ id: 'TASK-001', title: '夹爪力控调参', kind: 'exp' })
    expect(renderBoard(state)).toContain('[试验] 夹爪力控调参')
  })
})
