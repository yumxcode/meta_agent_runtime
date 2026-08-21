/**
 * readJsonFile error semantics (B1).
 *
 * The helper used to answer "the file does not exist" and "the file exists but
 * I could not read it" with the same value — `null` — because its catch block
 * had no discriminator at all. Two consequences, both silent:
 *
 *   - a load-modify-write caller sees an empty store and writes a fresh one
 *     over data that was merely unreadable for a moment;
 *   - GraphStore's recovery reads `checkpoint.json`, gets null, concludes there
 *     is no checkpoint, and replays the journal from sequence 1 — but the
 *     journal prefix behind a checkpoint is pruned, so it raises
 *     `graph journal sequence gap at 1`. Intact data reported as corrupt.
 *
 * A directory stands in for "exists but unreadable": reading one yields EISDIR
 * on every platform, with no chmod that a root-running CI would ignore.
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonFile } from '../index.js'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'read-json-'))
  dirs.push(dir)
  return dir
}

describe('readJsonFile error semantics', () => {
  it('returns null for a missing file', async () => {
    const dir = await scratch()
    await expect(readJsonFile(join(dir, 'nope.json'))).resolves.toBeNull()
  })

  it('throws — rather than reporting "no record" — when the file cannot be read', async () => {
    const dir = await scratch()
    const unreadable = join(dir, 'a-directory.json')
    await mkdir(unreadable)

    await expect(readJsonFile(unreadable)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('returns null for an unreadable file only when the caller opts in', async () => {
    const dir = await scratch()
    const unreadable = join(dir, 'a-directory.json')
    await mkdir(unreadable)
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      readJsonFile(unreadable, { tolerateUnreadable: true }),
    ).resolves.toBeNull()
    // Tolerating is not the same as hiding: enumeration callers still get a
    // trace, otherwise a directory that becomes unreadable looks like a
    // directory that became empty.
    expect(stderr).toHaveBeenCalled()
  })

  it('still returns null (not a throw) for a file that exists but is not JSON', async () => {
    // Parse failure is a separate axis from read failure and keeps its old
    // contract: warn, optionally quarantine, return null.
    const dir = await scratch()
    const bad = join(dir, 'bad.json')
    await writeFile(bad, '{ not json', 'utf-8')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(readJsonFile(bad)).resolves.toBeNull()
  })
})
