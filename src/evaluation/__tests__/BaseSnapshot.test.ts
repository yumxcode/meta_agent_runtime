/**
 * Base snapshot capture and restore (G1-5, minimum viable).
 *
 * The failure this guards against is subtle and fatal: a case replayed from the
 * state a task *ended* in passes because the answer is already in the working
 * tree, and every metric computed over such cases is fiction. So the round-trip
 * test here is not a formality — it is the property the whole gate rests on.
 *
 * The second theme is fidelity honesty. This version does not handle submodules
 * or LFS, and the correct behaviour when it meets them is to say so, not to
 * capture what it can and call the result `restored`. Several tests exist only
 * to pin that a snapshot cannot overclaim.
 */
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureBaseSnapshot,
  restoreBaseSnapshot,
  discardRestoredSnapshot,
  verifyRestore,
  isBaseSnapshotId,
  FIDELITY_GAPS,
} from '../BaseSnapshot.js'
import { runGit } from '../../infra/exec/runGit.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-basesnap-'))
  tempDirs.push(dir)
  return dir
}

async function repo(): Promise<string> {
  const dir = await tempDir()
  await runGit(['init', '--initial-branch=main'], { cwd: dir })
  await runGit(['config', 'user.email', 'test@example.com'], { cwd: dir })
  await runGit(['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(join(dir, 'src.txt'), 'original content\n')
  await runGit(['add', '.'], { cwd: dir })
  await runGit(['commit', '-m', 'initial'], { cwd: dir })
  return dir
}

describe('captureBaseSnapshot — fidelity is a checked claim', () => {
  it('claims restored only for a clean tracked-only repository', async () => {
    const snapshot = await captureBaseSnapshot(await repo())
    expect(snapshot.fidelity).toBe('restored')
    expect(snapshot.gaps).toEqual([])
    expect(isBaseSnapshotId(snapshot.id)).toBe(true)
  })

  it('captures untracked files, which git would otherwise lose entirely', async () => {
    // Untracked fixtures exist nowhere in git history. A snapshot that ignored
    // them would restore a workspace the task never actually started from.
    const dir = await repo()
    await writeFile(join(dir, 'fixture.json'), '{"seed":42}\n')

    const snapshot = await captureBaseSnapshot(dir)
    expect(snapshot.untracked.map(f => f.path)).toEqual(['fixture.json'])
    expect(snapshot.fidelity).toBe('restored')
  })

  it('excludes ignored files from the untracked set', async () => {
    const dir = await repo()
    await writeFile(join(dir, '.gitignore'), 'build/\n')
    await runGit(['add', '.gitignore'], { cwd: dir })
    await runGit(['commit', '-m', 'ignore'], { cwd: dir })
    await mkdir(join(dir, 'build'))
    await writeFile(join(dir, 'build', 'artifact.bin'), 'derived\n')

    expect((await captureBaseSnapshot(dir)).untracked).toEqual([])
  })

  it('downgrades to approximated when tracked files were modified', async () => {
    // The commit is not the whole starting state any more, and this version
    // does not store the diff. Claiming `restored` would be a lie.
    const dir = await repo()
    await writeFile(join(dir, 'src.txt'), 'edited before the run\n')

    const snapshot = await captureBaseSnapshot(dir)
    expect(snapshot.fidelity).toBe('approximated')
    expect(snapshot.gaps).toContain(FIDELITY_GAPS.DIRTY_WORKTREE)
  })

  it('downgrades when the repository has submodules', async () => {
    const dir = await repo()
    await writeFile(join(dir, '.gitmodules'), '[submodule "vendor"]\n\tpath = vendor\n')

    const snapshot = await captureBaseSnapshot(dir)
    expect(snapshot.fidelity).toBe('approximated')
    expect(snapshot.gaps).toContain(FIDELITY_GAPS.SUBMODULES_PRESENT)
  })

  it('downgrades when LFS-managed paths are declared', async () => {
    const dir = await repo()
    await writeFile(join(dir, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')

    const snapshot = await captureBaseSnapshot(dir)
    expect(snapshot.fidelity).toBe('approximated')
    expect(snapshot.gaps).toContain(FIDELITY_GAPS.LFS_POINTERS_PRESENT)
  })

  it('reports unrestorable rather than throwing outside a git repository', async () => {
    // "This workspace cannot support a replayable case" is a finding the corpus
    // survey has to count, not an exception that aborts the survey.
    const snapshot = await captureBaseSnapshot(await tempDir())
    expect(snapshot.fidelity).toBe('unrestorable')
    expect(snapshot.gaps).toEqual([FIDELITY_GAPS.NOT_A_GIT_REPO])
  })

  it('keeps gaps empty exactly when it claims restored', async () => {
    const clean = await captureBaseSnapshot(await repo())
    expect(clean.gaps.length === 0).toBe(clean.fidelity === 'restored')

    const dirty = await repo()
    await writeFile(join(dirty, 'src.txt'), 'changed\n')
    const dirtySnapshot = await captureBaseSnapshot(dirty)
    expect(dirtySnapshot.gaps.length === 0).toBe(dirtySnapshot.fidelity === 'restored')
  })

  it('gives identical states identical content hashes', async () => {
    // The hash is the snapshot's identity, so it must not move with capture
    // time or any other incidental.
    const dir = await repo()
    const first = await captureBaseSnapshot(dir)
    const second = await captureBaseSnapshot(dir)
    expect(second.contentHash).toBe(first.contentHash)
  })

  it('moves the content hash when an untracked file changes', async () => {
    const dir = await repo()
    await writeFile(join(dir, 'fixture.json'), '{"seed":42}\n')
    const before = await captureBaseSnapshot(dir)

    await writeFile(join(dir, 'fixture.json'), '{"seed":43}\n')
    expect((await captureBaseSnapshot(dir)).contentHash).not.toBe(before.contentHash)
  })
})

describe('restoreBaseSnapshot — the round trip', () => {
  it('restores committed content and untracked fixtures to a fresh directory', async () => {
    const dir = await repo()
    await writeFile(join(dir, 'fixture.json'), '{"seed":42}\n')
    const snapshot = await captureBaseSnapshot(dir)

    const target = join(await tempDir(), 'restored')
    const result = await restoreBaseSnapshot(snapshot, target, { sourceDir: dir })

    expect(result.fidelity).toBe('restored')
    expect(await readFile(join(target, 'src.txt'), 'utf8')).toBe('original content\n')
    expect(await readFile(join(target, 'fixture.json'), 'utf8')).toBe('{"seed":42}\n')

    await discardRestoredSnapshot(target, { sourceDir: dir })
  })

  it('restores the starting state even after the source has moved on', async () => {
    // The property the gate rests on: a case must start where the task started,
    // not where it finished. Here the source repo advances past the snapshot,
    // and the restore must still produce the original content.
    const dir = await repo()
    const snapshot = await captureBaseSnapshot(dir)

    await writeFile(join(dir, 'src.txt'), 'THE ANSWER, written by the agent\n')
    await runGit(['add', '.'], { cwd: dir })
    await runGit(['commit', '-m', 'task completed'], { cwd: dir })

    const target = join(await tempDir(), 'restored')
    await restoreBaseSnapshot(snapshot, target, { sourceDir: dir })

    expect(await readFile(join(target, 'src.txt'), 'utf8')).toBe('original content\n')
    await discardRestoredSnapshot(target, { sourceDir: dir })
  })

  it('verifies a restore byte-for-byte and reports no mismatches', async () => {
    const dir = await repo()
    await writeFile(join(dir, 'fixture.json'), '{"seed":42}\n')
    const snapshot = await captureBaseSnapshot(dir)

    const target = join(await tempDir(), 'restored')
    await restoreBaseSnapshot(snapshot, target, { sourceDir: dir })

    expect(await verifyRestore(snapshot, target)).toEqual([])
    await discardRestoredSnapshot(target, { sourceDir: dir })
  })

  it('names the drifted path when restored content does not match', async () => {
    // Detecting drift is the reason verifyRestore exists: silently starting
    // from drifted content is precisely the failure this gate rules out.
    const dir = await repo()
    await writeFile(join(dir, 'fixture.json'), '{"seed":42}\n')
    const snapshot = await captureBaseSnapshot(dir)

    const target = join(await tempDir(), 'restored')
    await restoreBaseSnapshot(snapshot, target, { sourceDir: dir })
    await writeFile(join(target, 'fixture.json'), '{"seed":999}\n')

    expect(await verifyRestore(snapshot, target)).toEqual(['fixture.json'])
    await discardRestoredSnapshot(target, { sourceDir: dir })
  })

  it('refuses to restore an unrestorable snapshot', async () => {
    const snapshot = await captureBaseSnapshot(await tempDir())
    await expect(restoreBaseSnapshot(snapshot, join(await tempDir(), 'x')))
      .rejects.toThrow(/unrestorable/)
  })

  it('leaves no worktree registration behind after discard', async () => {
    // A stale administrative entry breaks the next restore to the same path,
    // which would surface as a mysterious failure several cases later.
    const dir = await repo()
    const snapshot = await captureBaseSnapshot(dir)
    const target = join(await tempDir(), 'restored')

    await restoreBaseSnapshot(snapshot, target, { sourceDir: dir })
    await discardRestoredSnapshot(target, { sourceDir: dir })

    const { stdout } = await runGit(['worktree', 'list'], { cwd: dir, raw: true })
    expect(stdout).not.toContain(target)
  })

  it('supports restoring the same snapshot twice to different directories', async () => {
    // Repeat execution is a G1 metric (repeat_pass_rate), so one snapshot has
    // to be materialisable more than once.
    const dir = await repo()
    const snapshot = await captureBaseSnapshot(dir)
    const root = await tempDir()

    const a = join(root, 'a')
    const b = join(root, 'b')
    await restoreBaseSnapshot(snapshot, a, { sourceDir: dir })
    await restoreBaseSnapshot(snapshot, b, { sourceDir: dir })

    expect(await verifyRestore(snapshot, a)).toEqual([])
    expect(await verifyRestore(snapshot, b)).toEqual([])

    await discardRestoredSnapshot(a, { sourceDir: dir })
    await discardRestoredSnapshot(b, { sourceDir: dir })
  })
})

describe('isBaseSnapshotId', () => {
  it('rejects ids that would escape the store directory', () => {
    expect(isBaseSnapshotId('basesnap_' + 'a'.repeat(24))).toBe(true)
    expect(isBaseSnapshotId('../../etc/passwd')).toBe(false)
    expect(isBaseSnapshotId('basesnap_../../x')).toBe(false)
    expect(isBaseSnapshotId('basesnap_ABC')).toBe(false)
  })
})
