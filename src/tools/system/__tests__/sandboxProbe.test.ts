/**
 * sandbox_probe — the self-inspection tool.
 *
 * What these lock down is mostly what the probe must NOT do. Its whole purpose
 * is to be safe to run while something is already going wrong, so a version
 * that printed a token value, or that threw when the config was malformed,
 * would be worse than not having it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSandboxProbeTool } from '../sandbox_probe/index.js'
import type { ToolCallContext } from '../../../core/types.js'

let projectDir: string
let fakeHome: string
let realHome: string | undefined

function writeProjectConfig(sandbox: Record<string, unknown>): void {
  const dir = join(projectDir, '.meta-agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ sandbox }, null, 2))
}

function ctx(): ToolCallContext {
  return {
    sessionId: 's',
    agentId: 'a',
    abortSignal: new AbortController().signal,
    workspaceRoot: projectDir,
  } as unknown as ToolCallContext
}

async function run(mode: string, input: Record<string, unknown> = {}): Promise<string> {
  const tool = await createSandboxProbeTool(mode)
  const res = await tool.call(input, ctx())
  expect(res.isError).toBe(false)
  return res.content as string
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'probe-'))
  fakeHome = mkdtempSync(join(tmpdir(), 'probe-home-'))
  realHome = process.env['HOME']
  process.env['HOME'] = fakeHome
})

afterEach(() => {
  if (realHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = realHome
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('sandbox_probe', () => {
  it('reports mode, backend and config layers', async () => {
    writeProjectConfig({})
    const out = await run('robotics')
    expect(out).toContain('mode: robotics')
    expect(out).toContain('config layers')
    expect(out).toContain('✓ loaded')
    expect(out).toContain('diagnostics: nothing dropped.')
  })

  it('shows a config file that was never loaded', async () => {
    // No config written at all — the "wrong filename / wrong directory" case
    // that cost an afternoon before this tool existed.
    const out = await run('agentic')
    expect(out).toContain('✗ not present')
  })

  it('lists granted roots with their write bit', async () => {
    const ghDir = join(fakeHome, '.config', 'gh')
    mkdirSync(ghDir, { recursive: true })
    writeProjectConfig({ toolAccess: ['gh'] })
    const out = await run('robotics')
    expect(out).toContain('toolAccess: gh')
    expect(out).toContain(`rw ${ghDir}`)
  })

  it('reports env vars as set/unset and NEVER prints a value', async () => {
    const ghDir = join(fakeHome, '.config', 'gh')
    mkdirSync(ghDir, { recursive: true })
    writeProjectConfig({ toolAccess: ['gh'] })

    const before = process.env['GH_TOKEN']
    process.env['GH_TOKEN'] = 'ghp_supersecretvalue'
    try {
      const out = await run('robotics')
      expect(out).toContain('GH_TOKEN')
      expect(out).toContain('✓ set')
      expect(out).not.toContain('ghp_supersecretvalue')
    } finally {
      if (before === undefined) delete process.env['GH_TOKEN']
      else process.env['GH_TOKEN'] = before
    }
  })

  it('renders diagnostics for a dropped path', async () => {
    writeProjectConfig({ writeAllowPaths: ['/definitely/not/here/98765'] })
    const out = await run('agentic')
    expect(out).toContain('DROPPED PATH')
    expect(out).toContain('/definitely/not/here/98765')
  })

  it('explains an autonomous-restricted preset instead of staying silent', async () => {
    mkdirSync(join(fakeHome, '.aws'), { recursive: true })
    writeProjectConfig({ toolAccess: ['aws'] })
    const out = await run('auto')
    expect(out).toContain('DROPPED PRESET')
    expect(out).toContain('sandbox.modes')
  })

  it('does not throw on a malformed config', async () => {
    writeProjectConfig({ toolAccess: 'gh', modes: 42 })
    await expect(run('auto')).resolves.toBeTruthy()
  })

  it('prints preset rationale only when verbose', async () => {
    mkdirSync(join(fakeHome, '.config', 'gh'), { recursive: true })
    writeProjectConfig({ toolAccess: ['gh'] })
    expect(await run('robotics')).not.toContain('why:')
    expect(await run('robotics', { verbose: true })).toContain('why:')
  })
})
