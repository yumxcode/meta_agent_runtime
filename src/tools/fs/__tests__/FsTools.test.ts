import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { FileStateCache } from '../../../kernel/session/FileStateCache.js'
import type { ToolCallContext } from '../../../core/types.js'
import { createGlobTool } from '../glob/index.js'
import { createGrepTool } from '../grep/index.js'

const tempDirs: string[] = []

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-fs-'))
  tempDirs.push(dir)
  return dir
}

function ctx(workspaceRoot: string): ToolCallContext {
  return {
    sessionId: 's',
    agentId: 's',
    abortSignal: new AbortController().signal,
    workspaceRoot,
    readFileState: new FileStateCache(),
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('fs tools workspace defaults', () => {
  it('glob defaults to ToolCallContext.workspaceRoot, not process.cwd()', async () => {
    const workspace = await tempProject()
    const outside = await tempProject()
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(workspace, 'src', 'target.ts'), 'export const target = true\n')
    await writeFile(join(outside, 'outside.ts'), 'export const outside = true\n')

    const previousCwd = process.cwd()
    process.chdir(outside)
    try {
      const tool = await createGlobTool()
      const result = await tool.call({ pattern: '**/*.ts' }, ctx(workspace))
      expect(result.isError).toBe(false)
      expect(result.content).toContain(join(workspace, 'src', 'target.ts'))
      expect(result.content).not.toContain(join(outside, 'outside.ts'))
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('grep defaults to ToolCallContext.workspaceRoot, not process.cwd()', async () => {
    const workspace = await tempProject()
    const outside = await tempProject()
    await writeFile(join(workspace, 'target.txt'), 'needle\n')
    await writeFile(join(outside, 'outside.txt'), 'needle\n')

    const previousCwd = process.cwd()
    process.chdir(outside)
    try {
      const tool = await createGrepTool()
      const result = await tool.call({ pattern: 'needle' }, ctx(workspace))
      expect(result.isError).toBe(false)
      expect(result.content).toContain(join(workspace, 'target.txt'))
      expect(result.content).not.toContain(join(outside, 'outside.txt'))
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('grep rejects explicit paths outside workspace', async () => {
    const workspace = await tempProject()
    const outside = await tempProject()
    const tool = await createGrepTool()
    const result = await tool.call({ pattern: 'needle', path: outside }, ctx(workspace))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('outside workspace')
  })
})
