import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { runLoopCli } from '../cli.js'
import { walkResearchCharter } from './testCharter.js'
import { instancePaths } from '../types.js'

async function workspaceWithCharterFile() {
  const dir = await mkdtemp(join(tmpdir(), 'loop-cli-'))
  await writeFile(join(dir, 'charter.json'), JSON.stringify(walkResearchCharter()), 'utf-8')
  return dir
}

describe('loop CLI handlers', () => {
  it('create → list → inspect → inbox round-trip (pure code, no backend)', async () => {
    const dir = await workspaceWithCharterFile()

    const created = await runLoopCli(['create', 'charter.json'], { projectDir: dir })
    expect(created).toContain('walk-research@v1 saved')
    expect(created).toContain('walk-research-v1 created')

    const listed = await runLoopCli(['list'], { projectDir: dir })
    expect(listed).toContain('walk-research-v1  idle')

    const inspected = await runLoopCli(['inspect', 'walk-research-v1'], { projectDir: dir })
    expect(inspected).toContain('iteration=0')
    expect(inspected).toContain('timer@')

    const inboxed = await runLoopCli(['inbox', 'walk-research-v1', '别再调', 'sigma'], { projectDir: dir })
    expect(inboxed).toContain('next round')
    const paths = instancePaths(dir, 'walk-research-v1')
    const files = await readdir(paths.inboxDir)
    const messages = await Promise.all(
      files.filter(f => f.endsWith('.json')).map(async f =>
        JSON.parse(await readFile(join(paths.inboxDir, f), 'utf-8')) as { message: string }),
    )
    expect(messages.some(m => m.message === '别再调 sigma')).toBe(true)
  })

  it('create is idempotent per version; a new save bumps the version', async () => {
    const dir = await workspaceWithCharterFile()
    await runLoopCli(['create', 'charter.json'], { projectDir: dir })
    const second = await runLoopCli(['create', 'charter.json'], { projectDir: dir })
    expect(second).toContain('walk-research@v2 saved')     // library versioned
    expect(second).toContain('walk-research-v2 created')   // distinct instance
    const listed = await runLoopCli(['list'], { projectDir: dir })
    expect(listed).toContain('walk-research-v1')
    expect(listed).toContain('walk-research-v2')
  })

  it('rejects an invalid charter with the validation errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-cli-bad-'))
    await writeFile(join(dir, 'bad.json'),
      JSON.stringify(walkResearchCharter({ tripwires: [] })), 'utf-8')
    await expect(runLoopCli(['create', 'bad.json'], { projectDir: dir }))
      .rejects.toThrow(/at least one tripwire/)
  })

  it('tick without a dispatcher explains the wiring requirement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-cli-tick-'))
    await mkdir(dir, { recursive: true })
    await expect(runLoopCli(['tick'], { projectDir: dir }))
      .rejects.toThrow(/backend dispatcher/)
  })

  it('unknown command prints usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-cli-usage-'))
    expect(await runLoopCli(['wat'], { projectDir: dir })).toContain('Usage: meta-agent loop')
  })
})
