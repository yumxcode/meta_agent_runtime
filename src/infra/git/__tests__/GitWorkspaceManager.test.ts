import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GitWorkspaceManager } from '../GitWorkspaceManager.js'

const cleanup: string[] = []

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('GitWorkspaceManager.enabled', () => {
  it('recognises a project subdirectory inside a git worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'ma-git-workspace-'))
    cleanup.push(root)
    execFileSync('git', ['init', root], { stdio: 'ignore' })
    const subdir = join(root, 'packages', 'robot')
    mkdirSync(subdir, { recursive: true })

    expect(new GitWorkspaceManager(subdir).enabled).toBe(true)
  })
})
