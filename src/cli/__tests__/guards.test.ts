/**
 * cli/guards — the interactive sensitive-operation confirmation.
 *
 * This is a UX gate, not a security boundary (the kernel PermissionPolicy is
 * what actually denies). It still needs tests, because it used to answer the
 * containment question with a bare `path.startsWith(workspace)` — which treats
 * `/home/u/proj-backup` as inside `/home/u/proj` and therefore SKIPPED the
 * confirmation prompt for a write outside the project. Containment is delegated
 * to tools/fs/workspaceGuard now; these tests pin that it stays delegated.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { detectSensitiveOp } from '../guards.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'cli-guards-')))
  dirs.push(dir)
  return dir
}

describe('detectSensitiveOp — workspace boundary', () => {
  it('does not prompt for an in-workspace edit', async () => {
    const ws = await scratch()
    expect(detectSensitiveOp('edit_file', { file_path: join(ws, 'src/a.ts') }, ws)).toBeNull()
  })

  it('prompts for an edit outside the workspace', async () => {
    const ws = await scratch()
    expect(detectSensitiveOp('edit_file', { file_path: '/etc/hosts' }, ws)).toMatch(/工作目录外/)
  })

  it('REGRESSION: a sibling directory sharing the workspace prefix still prompts', async () => {
    // `${ws}-backup` satisfies `startsWith(ws)` but is NOT inside the workspace.
    // The old prefix check silently skipped the prompt here.
    const ws = await scratch()
    const sibling = `${ws}-backup`
    await mkdir(sibling, { recursive: true })
    dirs.push(sibling)
    expect(detectSensitiveOp('edit_file', { file_path: join(sibling, 'secret.env') }, ws))
      .toMatch(/工作目录外/)
  })

  it('REGRESSION: a symlink pointing outside the workspace still prompts', async () => {
    const ws = await scratch()
    const outside = await scratch()
    await writeFile(join(outside, 'secret.env'), 'KEY=1', 'utf-8')
    const link = join(ws, 'escape')
    await symlink(outside, link)
    expect(detectSensitiveOp('edit_file', { file_path: join(link, 'secret.env') }, ws))
      .toMatch(/工作目录外/)
  })

  it('bash cwd outside the workspace prompts; inside does not', async () => {
    const ws = await scratch()
    expect(detectSensitiveOp('bash', { command: 'ls', cwd: ws }, ws)).toBeNull()
    expect(detectSensitiveOp('bash', { command: 'ls', cwd: '/etc' }, ws)).toMatch(/工作目录外 cwd/)
  })

  it('bash referencing an absolute path outside the workspace prompts', async () => {
    const ws = await scratch()
    expect(detectSensitiveOp('bash', { command: 'cat /etc/passwd' }, ws)).toBeTruthy()
  })

  it('temp and standard device paths are not treated as escapes', async () => {
    const ws = await scratch()
    expect(detectSensitiveOp('bash', { command: 'echo hi > /tmp/scratch.txt' }, ws)).toBeNull()
    expect(detectSensitiveOp('bash', { command: 'make 2>/dev/null' }, ws)).toBeNull()
  })

  it('flags a sensitive shell pattern regardless of path', async () => {
    const ws = await scratch()
    expect(detectSensitiveOp('bash', { command: `rm -rf ${join(ws, 'build')}` }, ws))
      .toMatch(/rm/)
  })
})

describe('detectSensitiveOp — tool categories', () => {
  it('always confirms write_file and notebook_edit', () => {
    expect(detectSensitiveOp('write_file', { file_path: '/anywhere' }, '/ws')).toBe('write_file')
    expect(detectSensitiveOp('notebook_edit', {}, '/ws')).toBe('notebook_edit')
  })

  it('confirms team board mutations but not team_note', () => {
    expect(detectSensitiveOp('team_take', {}, '/ws')).toMatch(/team_take/)
    expect(detectSensitiveOp('team_mark_done', {}, '/ws')).toMatch(/team_mark_done/)
    expect(detectSensitiveOp('team_note', {}, '/ws')).toBeNull()
  })

  it('ignores tools it does not gate', () => {
    expect(detectSensitiveOp('read_file', { file_path: '/etc/passwd' }, '/ws')).toBeNull()
    expect(detectSensitiveOp('grep', { path: '/etc' }, '/ws')).toBeNull()
  })

  it('without a workspace, only the pattern/category rules apply', () => {
    expect(detectSensitiveOp('edit_file', { file_path: '/etc/hosts' }, undefined)).toBeNull()
    expect(detectSensitiveOp('bash', { command: 'cat /etc/passwd' }, undefined)).toBeNull()
    expect(detectSensitiveOp('bash', { command: 'sudo reboot' }, undefined)).toMatch(/sudo/)
  })
})
