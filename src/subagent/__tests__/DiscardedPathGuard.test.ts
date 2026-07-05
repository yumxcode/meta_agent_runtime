/**
 * wrapWithDiscardedPathGuard — isolated-worktree writers must get an immediate,
 * instructive tool error when they try to write under `.meta-agent/` (those
 * writes are excluded from finalize/merge and would be silently discarded).
 * The guard is the CHEAPEST self-correction loop: the sub-agent sees the error
 * in its own transcript and fixes the path within its turn budget.
 */
import { describe, expect, it } from 'vitest'
import { wrapWithDiscardedPathGuard, DISCARDED_PATH_GUARD_MESSAGE } from '../SubAgentRunner.js'
import type { MetaAgentTool, ToolCallContext } from '../../core/types.js'

const ROOT = '/wt/subtask-1'
const ctx = {} as ToolCallContext

function writeTool(calls: string[]): MetaAgentTool {
  return {
    name: 'edit_file',
    description: 'edit',
    inputSchema: {},
    permission: { category: 'write', pathFields: ['file_path'] },
    async call(input) {
      calls.push(String(input['file_path']))
      return { content: 'ok', isError: false }
    },
  }
}

describe('wrapWithDiscardedPathGuard', () => {
  it('blocks absolute and relative writes under .meta-agent/ with the remediation message', async () => {
    const calls: string[] = []
    const guarded = wrapWithDiscardedPathGuard(writeTool(calls), ROOT)

    for (const p of [
      `${ROOT}/.meta-agent/research/task-001/state/progress.json`,
      '.meta-agent/research/task-001/state/progress.json',
      `${ROOT}/state/../.meta-agent/x.json`, // traversal cannot dodge the guard
    ]) {
      const r = await guarded.call({ file_path: p, old_string: 'a', new_string: 'b' }, ctx)
      expect(r.isError).toBe(true)
      expect(r.content).toContain(DISCARDED_PATH_GUARD_MESSAGE)
    }
    expect(calls).toHaveLength(0) // the underlying tool never ran
  })

  it('passes through legitimate workspace writes', async () => {
    const calls: string[] = []
    const guarded = wrapWithDiscardedPathGuard(writeTool(calls), ROOT)
    const r = await guarded.call({ file_path: `${ROOT}/state/progress.json` }, ctx)
    expect(r.isError).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('does not block files that merely CONTAIN the substring outside the dir', async () => {
    const calls: string[] = []
    const guarded = wrapWithDiscardedPathGuard(writeTool(calls), ROOT)
    const r = await guarded.call({ file_path: `${ROOT}/docs/.meta-agent-notes.md` }, ctx)
    expect(r.isError).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('leaves read tools and tools without pathFields untouched', async () => {
    const readTool: MetaAgentTool = {
      name: 'read_file',
      description: 'read',
      inputSchema: {},
      permission: { category: 'read', pathFields: ['file_path'] },
      async call() { return { content: 'data', isError: false } },
    }
    expect(wrapWithDiscardedPathGuard(readTool, ROOT)).toBe(readTool)
  })
})
