/**
 * GitHub-SSOT enforcement: every team board must be bound to a GitHub repo.
 *   - init/join without a URL and without a GitHub origin → TeamGithubRequiredError
 *   - origin pointing at github.com → auto-detected and normalized
 *   - addTask refuses to create tasks on an unbound (legacy) board
 */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamGithubRequiredError, TeamStore, normalizeGithubUrl } from '../TeamStore.js'

const execFileAsync = promisify(execFile)

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-team-ssot-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('normalizeGithubUrl', () => {
  it('normalizes ssh / https / bare forms to canonical https', () => {
    expect(normalizeGithubUrl('git@github.com:acme/robot.git')).toBe('https://github.com/acme/robot')
    expect(normalizeGithubUrl('https://github.com/acme/robot.git')).toBe('https://github.com/acme/robot')
    expect(normalizeGithubUrl('https://github.com/acme/robot/')).toBe('https://github.com/acme/robot')
    expect(normalizeGithubUrl('github.com/acme/robot')).toBe('https://github.com/acme/robot')
  })

  it('rejects non-GitHub references', () => {
    expect(normalizeGithubUrl('https://gitlab.com/acme/robot')).toBeNull()
    expect(normalizeGithubUrl('/some/local/path.git')).toBeNull()
    expect(normalizeGithubUrl('')).toBeNull()
    expect(normalizeGithubUrl(undefined)).toBeNull()
  })
})

describe('GitHub SSOT enforcement', () => {
  it('init without URL and without a GitHub origin throws TeamGithubRequiredError', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-a')
    await expect(store.init()).rejects.toThrow(TeamGithubRequiredError)
    // join (which auto-inits) is equally blocked
    await expect(store.join()).rejects.toThrow(TeamGithubRequiredError)
  })

  it('init rejects a non-GitHub URL explicitly', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-a')
    await expect(store.init('https://gitlab.com/acme/robot')).rejects.toThrow(/不是有效的 GitHub/)
  })

  it('init normalizes and stores the explicit URL', async () => {
    const dir = await tempDir()
    const store = new TeamStore(dir, 'unit-a')
    const state = await store.init('git@github.com:acme/robot.git')
    expect(state.github).toBe('https://github.com/acme/robot')
  })

  it('auto-detects the GitHub repo from the origin remote', async () => {
    const dir = await tempDir()
    await execFileAsync('git', ['init'], { cwd: dir })
    await execFileAsync('git', ['remote', 'add', 'origin', 'git@github.com:acme/auto.git'], { cwd: dir })
    const store = new TeamStore(dir, 'unit-a')
    const state = await store.init()
    expect(state.github).toBe('https://github.com/acme/auto')
  })

  it('addTask refuses on a legacy board without github binding', async () => {
    const dir = await tempDir()
    // Hand-write a legacy v2.0 board without the github field.
    await mkdir(join(dir, 'team'), { recursive: true })
    await writeFile(join(dir, 'team', 'team.json'), JSON.stringify({
      schemaVersion: '2.0',
      project: 'legacy',
      goals: [],
      tasks: [],
      units: [],
      updatedAt: new Date().toISOString(),
    }))
    const store = new TeamStore(dir, 'unit-a')
    await expect(store.addTask({ id: 'TASK-001', title: 'x' })).rejects.toThrow(/GitHub/)
  })

  it('addTask backfills the binding from a detectable origin on legacy boards', async () => {
    const dir = await tempDir()
    await execFileAsync('git', ['init'], { cwd: dir })
    await execFileAsync('git', ['remote', 'add', 'origin', 'https://github.com/acme/backfill.git'], { cwd: dir })
    await mkdir(join(dir, 'team'), { recursive: true })
    await writeFile(join(dir, 'team', 'team.json'), JSON.stringify({
      schemaVersion: '2.0',
      project: 'legacy',
      goals: [],
      tasks: [],
      units: [],
      updatedAt: new Date().toISOString(),
    }))
    const store = new TeamStore(dir, 'unit-a')
    const { state } = await store.addTask({ id: 'TASK-001', title: 'x' })
    expect(state.github).toBe('https://github.com/acme/backfill')
    expect((await store.status())?.github).toBe('https://github.com/acme/backfill')
  })
})
