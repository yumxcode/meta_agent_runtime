import { describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createInstance } from '../instance/InstanceStore.js'
import { makeVcsPublishTool } from '../kernel/VcsPublishTool.js'
import { walkResearchCharter } from './testCharter.js'

const execFileAsync = promisify(execFile)

describe('Loop capability closure', () => {
  it('fails create when a required skill is unavailable', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'loop-cap-skill-'))
    const charter = walkResearchCharter()
    charter.seats.worker.skills = ['definitely-missing-skill']
    await expect(createInstance({ projectDir, charter })).rejects.toThrow(/unavailable skill/)
  })

  it('preflights operator-granted host paths and creates an instance scratch directory', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'loop-cap-host-'))
    const hostStore = await mkdtemp(join(tmpdir(), 'loop-host-store-'))
    const charter = walkResearchCharter()
    charter.seats.worker.hostRequirements = { writePaths: [hostStore] }

    await expect(createInstance({ projectDir, charter })).rejects.toThrow(/not granted/)
    await mkdir(join(projectDir, '.meta-agent'), { recursive: true })
    await writeFile(
      join(projectDir, '.meta-agent', 'config.json'),
      JSON.stringify({ sandbox: { writeAllowPaths: [hostStore] } }),
      'utf-8',
    )
    const instance = await createInstance({ projectDir, charter })
    await expect(access(instance.paths.scratchDir)).resolves.toBeUndefined()
  })

  it('publishes only writeScope changes through the host-owned VCS lane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-vcs-tool-'))
    const remote = join(root, 'remote.git')
    const projectDir = join(root, 'work')
    await git(root, ['init', '--bare', remote])
    await mkdir(projectDir)
    await git(projectDir, ['init'])
    await git(projectDir, ['config', 'user.email', 'loop@example.test'])
    await git(projectDir, ['config', 'user.name', 'Loop Test'])
    await mkdir(join(projectDir, 'src'))
    await writeFile(join(projectDir, 'src', 'model.txt'), 'v1\n')
    await writeFile(join(projectDir, 'outside.txt'), 'keep\n')
    await git(projectDir, ['add', '.'])
    await git(projectDir, ['commit', '-m', 'initial'])
    await git(projectDir, ['branch', '-M', 'main'])
    await git(projectDir, ['remote', 'add', 'origin', remote])
    await git(projectDir, ['push', '-u', 'origin', 'main'])

    await writeFile(join(projectDir, 'src', 'model.txt'), 'v2\n')
    await writeFile(join(projectDir, 'outside.txt'), 'must-not-publish\n')
    const tool = makeVcsPublishTool({ projectDir, writeScope: ['src/**'], remote: 'origin' })
    const result = await tool.call({
      message: 'train: update model', paths: ['src/model.txt'],
    }, {} as never)
    expect(result.isError).toBe(false)

    const remoteFile = (await git(root, ['--git-dir', remote, 'show', 'main:src/model.txt'])).trim()
    expect(remoteFile).toBe('v2')
    const localOutside = await readFile(join(projectDir, 'outside.txt'), 'utf-8')
    expect(localOutside).toBe('must-not-publish\n')
    const remoteOutside = (await git(root, ['--git-dir', remote, 'show', 'main:outside.txt'])).trim()
    expect(remoteOutside).toBe('keep')
  })

  it('preflights explicit workspace evidence without importing it into the ledger', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'loop-cap-history-'))
    const charter = walkResearchCharter()
    charter.seats.pivoter!.inputs = ['workspace:docs/research-history.md']
    await expect(createInstance({ projectDir, charter })).rejects.toThrow(/workspace evidence/)

    await mkdir(join(projectDir, 'docs'), { recursive: true })
    await writeFile(join(projectDir, 'docs', 'research-history.md'), '# Dead Ends\n- repeated-direction\n')
    const instance = await createInstance({ projectDir, charter })
    expect(await instance.ledger.readJsonl(instance.paths.findingsJsonl)).toEqual([])
    expect((await instance.ledger.readProgress()).bestMetric).toBeNull()
  })
})

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 })
  return result.stdout
}
