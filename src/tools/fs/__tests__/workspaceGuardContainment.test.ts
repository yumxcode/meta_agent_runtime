/**
 * M4: the two public guard entry points must use the same segment-wise
 * containment test as pathIsUnder, not a string prefix.
 *
 * The prefix form was correct on POSIX once a separator was appended, so these
 * cases are about keeping the three implementations from drifting again — this
 * module's own docstring records two call sites that grew private copies and
 * one of them ("/home/u/proj-backup" treated as inside "/home/u/proj") shipped.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  isInsideWorkspace,
  pathIsUnder,
  resolveInsideWorkspace,
} from '../workspaceGuard.js'

const root = mkdtempSync(join(tmpdir(), 'workspace-guard-'))
const workspace = join(root, 'proj')
const sibling = join(root, 'proj-backup')
mkdirSync(workspace, { recursive: true })
mkdirSync(sibling, { recursive: true })

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('workspace containment', () => {
  it('accepts the workspace root and paths beneath it', () => {
    expect(isInsideWorkspace(workspace, workspace)).toBe(true)
    expect(isInsideWorkspace(join(workspace, 'src', 'index.ts'), workspace)).toBe(true)
    expect(resolveInsideWorkspace('src/index.ts', workspace)).toEqual({
      ok: true,
      path: join(workspace, 'src', 'index.ts'),
    })
  })

  it('rejects a sibling directory that shares the root as a string prefix', () => {
    expect(isInsideWorkspace(sibling, workspace)).toBe(false)
    expect(isInsideWorkspace(join(sibling, 'secret'), workspace)).toBe(false)
    expect(resolveInsideWorkspace(join(sibling, 'secret'), workspace).ok).toBe(false)
  })

  it('rejects a parent escape', () => {
    expect(isInsideWorkspace(join(workspace, '..', 'elsewhere'), workspace)).toBe(false)
    expect(resolveInsideWorkspace('../elsewhere', workspace).ok).toBe(false)
  })

  it('agrees with pathIsUnder — one containment semantic, not two', () => {
    for (const candidate of [
      workspace,
      join(workspace, 'a', 'b'),
      sibling,
      join(sibling, 'secret'),
      root,
    ]) {
      expect(isInsideWorkspace(candidate, workspace)).toBe(pathIsUnder(candidate, workspace))
    }
  })
})
