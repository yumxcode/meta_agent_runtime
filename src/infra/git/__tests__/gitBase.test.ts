/**
 * gitBase capture (G1-1).
 *
 * The field existed in the trajectory schema from A3 onward and was never once
 * assigned, so every trajectory ever written claims an unknown starting point.
 * That blocks G1 outright: an EvalCase replayed from the state a task *ended*
 * in passes because the answer is already sitting in the working tree.
 *
 * Two properties matter here, and the second is the one that keeps the data
 * honest rather than merely present:
 *
 *   1. It captures the real HEAD.
 *   2. It never claims more than it knows — a dirty or untracked working tree
 *      is reported as such, and any failure yields `undefined` rather than a
 *      partially filled base that reads as usable.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { captureGitBase, formatGitBase } from '../gitBase.js'
import { runGit } from '../../exec/runGit.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-gitbase-'))
  tempDirs.push(dir)
  return dir
}

async function repoWithCommit(): Promise<{ dir: string; commit: string }> {
  const dir = await tempDir()
  await runGit(['init', '--initial-branch=main'], { cwd: dir })
  await runGit(['config', 'user.email', 'test@example.com'], { cwd: dir })
  await runGit(['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(join(dir, 'tracked.txt'), 'original\n')
  await runGit(['add', '.'], { cwd: dir })
  await runGit(['commit', '-m', 'initial'], { cwd: dir })
  const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: dir, raw: true })
  return { dir, commit: stdout.trim() }
}

describe('captureGitBase', () => {
  it('captures HEAD and the branch on a clean repository', async () => {
    const { dir, commit } = await repoWithCommit()
    expect(await captureGitBase(dir)).toEqual({
      commit,
      branch: 'main',
      dirty: false,
      untracked: false,
    })
  })

  it('reports uncommitted modifications instead of implying a clean start', async () => {
    // The commit sha alone would claim this run started from committed state.
    // It did not, and a restore from that sha would begin somewhere else.
    const { dir } = await repoWithCommit()
    await writeFile(join(dir, 'tracked.txt'), 'edited\n')

    const base = await captureGitBase(dir)
    expect(base?.dirty).toBe(true)
    expect(base?.untracked).toBe(false)
  })

  it('reports untracked files separately from dirty tracked ones', async () => {
    // Different recovery stories: a dirty tracked file can be reconstructed
    // from the commit plus a diff; an untracked file exists nowhere in git and
    // is simply gone unless something snapshots it.
    const { dir } = await repoWithCommit()
    await writeFile(join(dir, 'scratch.txt'), 'never added\n')

    const base = await captureGitBase(dir)
    expect(base?.dirty).toBe(false)
    expect(base?.untracked).toBe(true)
  })

  it('reports both when both are present', async () => {
    const { dir } = await repoWithCommit()
    await writeFile(join(dir, 'tracked.txt'), 'edited\n')
    await writeFile(join(dir, 'scratch.txt'), 'never added\n')

    const base = await captureGitBase(dir)
    expect(base).toMatchObject({ dirty: true, untracked: true })
  })

  it('ignores files git is configured to ignore', async () => {
    // An ignored build directory is not part of the starting state, and
    // treating it as untracked would mark almost every real repo unrestorable.
    const { dir } = await repoWithCommit()
    await writeFile(join(dir, '.gitignore'), 'build/\n')
    await runGit(['add', '.gitignore'], { cwd: dir })
    await runGit(['commit', '-m', 'ignore build'], { cwd: dir })
    await mkdir(join(dir, 'build'))
    await writeFile(join(dir, 'build', 'out.o'), 'binary\n')

    expect((await captureGitBase(dir))?.untracked).toBe(false)
  })

  it('omits branch on a detached HEAD rather than recording the literal "HEAD"', async () => {
    const { dir, commit } = await repoWithCommit()
    await runGit(['checkout', '--detach', commit], { cwd: dir })

    const base = await captureGitBase(dir)
    expect(base?.commit).toBe(commit)
    expect(base?.branch).toBeUndefined()
  })

  // ── Degradation: undefined, never partial ──────────────────────────────────

  it('returns undefined outside a git repository', async () => {
    expect(await captureGitBase(await tempDir())).toBeUndefined()
  })

  it('returns undefined for a repository with no commits yet', async () => {
    // `git init` with nothing committed has no HEAD to point at. There is no
    // starting commit, so there is no base — not a base with an empty sha.
    const dir = await tempDir()
    await runGit(['init'], { cwd: dir })
    expect(await captureGitBase(dir)).toBeUndefined()
  })

  it('returns undefined for a path that does not exist', async () => {
    // Must not throw: this runs on the turn's critical path and a failed probe
    // can never be allowed to take the user's turn down with it.
    expect(await captureGitBase(join(await tempDir(), 'nope', 'missing'))).toBeUndefined()
  })
})

describe('formatGitBase', () => {
  it('renders a clean base as the bare sha', () => {
    expect(formatGitBase({ commit: 'a'.repeat(40), dirty: false, untracked: false }))
      .toBe('a'.repeat(40))
  })

  it('flags a dirty or untracked start so it cannot read as clean', () => {
    expect(formatGitBase({ commit: 'a'.repeat(40), dirty: true, untracked: false }))
      .toBe(`${'a'.repeat(40)}+dirty`)
    expect(formatGitBase({ commit: 'a'.repeat(40), dirty: true, untracked: true }))
      .toBe(`${'a'.repeat(40)}+dirty+untracked`)
  })

  it('passes undefined through', () => {
    expect(formatGitBase(undefined)).toBeUndefined()
  })
})
