/**
 * wrapWithSandboxWriteGuard — the OS sandbox only wraps bash, so write-category
 * TOOLS (write_file/edit_file/notebook_edit) must mirror the same policy or the
 * loop worker's writeScope is bypassable with a single edit_file call (review
 * finding R1 on the F1 writeScope fix).
 */
import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { wrapWithSandboxWriteGuard } from '../SubAgentRunner.js'
import type { MetaAgentTool, ToolResult } from '../../core/types.js'

const ROOT = '/workspace/project'

function writeTool(calls: string[]): MetaAgentTool {
  return {
    name: 'write_file',
    description: 'test write tool',
    permission: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: false, planMode: 'ask' },
    inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } },
    async call(input): Promise<ToolResult> {
      calls.push(String(input['file_path']))
      return { content: 'ok', isError: false }
    },
  } as unknown as MetaAgentTool
}

async function invoke(tool: MetaAgentTool, filePath: string): Promise<ToolResult> {
  return tool.call({ file_path: filePath }, {} as never) as Promise<ToolResult>
}

describe('wrapWithSandboxWriteGuard', () => {
  it('readonly workspace: blocks workspace writes outside writeAllowPaths', async () => {
    const calls: string[] = []
    const tool = wrapWithSandboxWriteGuard(writeTool(calls), ROOT, {
      readonlyWorkspace: true,
      writeAllowPaths: [join(ROOT, 'drafts'), join(ROOT, 'src')],
    })
    const blocked = await invoke(tool, join(ROOT, 'README.md'))
    expect(blocked.isError).toBe(true)
    expect(String(blocked.content)).toMatch(/write scope/)

    const allowed = await invoke(tool, join(ROOT, 'src', 'a.ts'))
    expect(allowed.isError).toBe(false)
    expect(calls).toEqual([join(ROOT, 'src', 'a.ts')])
  })

  it('deny wins over allow', async () => {
    const calls: string[] = []
    const tool = wrapWithSandboxWriteGuard(writeTool(calls), ROOT, {
      readonlyWorkspace: true,
      writeAllowPaths: [ROOT],
      writeDenyPaths: [join(ROOT, 'ledger')],
    })
    const blocked = await invoke(tool, join(ROOT, 'ledger', 'progress.json'))
    expect(blocked.isError).toBe(true)
    expect(String(blocked.content)).toMatch(/writeDenyPaths/)
    expect(calls).toEqual([])
  })

  it('writable workspace: workspaceRoot is implicitly allowed, outside paths are not', async () => {
    const calls: string[] = []
    const tool = wrapWithSandboxWriteGuard(writeTool(calls), ROOT, { writeDenyPaths: [join(ROOT, '.loop')] })
    expect((await invoke(tool, join(ROOT, 'notes.md'))).isError).toBe(false)
    expect((await invoke(tool, '/etc/passwd')).isError).toBe(true)
  })

  it('resolves relative tool paths against the workspace root', async () => {
    const calls: string[] = []
    const tool = wrapWithSandboxWriteGuard(writeTool(calls), ROOT, {
      readonlyWorkspace: true,
      writeAllowPaths: [join(ROOT, 'drafts')],
    })
    expect((await invoke(tool, 'drafts/findings_draft.json')).isError).toBe(false)
    expect((await invoke(tool, '../outside.txt')).isError).toBe(true)
  })

  it('prefix tricks do not widen the allow root (drafts2 is not drafts)', async () => {
    const tool = wrapWithSandboxWriteGuard(writeTool([]), ROOT, {
      readonlyWorkspace: true,
      writeAllowPaths: [join(ROOT, 'drafts')],
    })
    expect((await invoke(tool, join(ROOT, 'drafts2', 'x.json'))).isError).toBe(true)
  })

  it('leaves non-write tools untouched', () => {
    const readTool = {
      name: 'read_file',
      permission: { category: 'read', pathFields: ['file_path'] },
      call: async () => ({ content: 'ok', isError: false }),
    } as unknown as MetaAgentTool
    expect(wrapWithSandboxWriteGuard(readTool, ROOT, { readonlyWorkspace: true })).toBe(readTool)
  })
})
