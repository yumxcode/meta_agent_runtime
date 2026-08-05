/**
 * atomicWrite behaviour under failure.
 *
 * A review found two rough edges in the write helpers that every store in the
 * codebase funnels through, neither of which had a test:
 *   - a failed rename stranded the temp file forever (they accumulated in
 *     .loop/ and .meta-agent/, where nothing swept them);
 *   - the corrupt-file quarantine used a fixed `.corrupt` suffix, so a second
 *     corruption silently overwrote the forensic copy of the first.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteJson, atomicWriteFile, readJsonFile } from '../index.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-write-'))
  dirs.push(dir)
  return dir
}

const tmpFiles = (names: string[]): string[] => names.filter(n => n.endsWith('.tmp'))

describe('atomicWriteJson', () => {
  it('writes the file and leaves no temp behind on success', async () => {
    const dir = await scratch()
    const target = join(dir, 'state.json')
    await atomicWriteJson(target, { a: 1 })
    expect(await readJsonFile(target)).toEqual({ a: 1 })
    expect(tmpFiles(await readdir(dir))).toEqual([])
  })

  // A real rename failure rather than a mock: renaming a file onto a NON-EMPTY
  // directory fails at the OS level (EISDIR / ENOTEMPTY). ESM export spies are
  // not available in this runtime, and a genuine syscall failure exercises the
  // same path the production bug did (cross-device, ENOSPC, permissions).
  it('cleans up the temp file when the rename fails, and still reports the error', async () => {
    const dir = await scratch()
    const target = join(dir, 'state.json')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'occupant'), 'x', 'utf-8')

    await expect(atomicWriteJson(target, { a: 1 })).rejects.toThrow()
    // The failure must not leave an orphan behind.
    expect(tmpFiles(await readdir(dir))).toEqual([])
  })

  it('atomicWriteFile cleans up its temp on rename failure too', async () => {
    const dir = await scratch()
    const target = join(dir, 'view.md')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'occupant'), 'x', 'utf-8')

    await expect(atomicWriteFile(target, '# hi')).rejects.toThrow()
    expect(tmpFiles(await readdir(dir))).toEqual([])
  })

  it('concurrent writers to the same path do not collide on a shared temp name', async () => {
    const dir = await scratch()
    const target = join(dir, 'state.json')
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => atomicWriteJson(target, { i })),
    )
    // Exactly one live file, no stragglers, and it parses.
    expect(tmpFiles(await readdir(dir))).toEqual([])
    expect(await readJsonFile(target)).toHaveProperty('i')
  })
})

describe('readJsonFile corrupt quarantine', () => {
  it('quarantines a corrupt file and returns null', async () => {
    const dir = await scratch()
    const target = join(dir, 'state.json')
    await writeFile(target, '{ not json', 'utf-8')

    expect(await readJsonFile(target)).toBeNull()

    const quarantined = (await readdir(dir)).filter(n => n.endsWith('.corrupt'))
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]).toMatch(/^state\.json\.\d+\.corrupt$/)
  })

  it('a SECOND corruption does not overwrite the first forensic copy', async () => {
    const dir = await scratch()
    const target = join(dir, 'state.json')

    await writeFile(target, '{ first corruption', 'utf-8')
    expect(await readJsonFile(target)).toBeNull()

    // Ensure a distinct Date.now() bucket, then corrupt again.
    await new Promise(r => setTimeout(r, 5))
    await writeFile(target, '{ second corruption', 'utf-8')
    expect(await readJsonFile(target)).toBeNull()

    const quarantined = (await readdir(dir)).filter(n => n.endsWith('.corrupt'))
    expect(quarantined).toHaveLength(2)
  })

  it('a missing file is not an error and is not quarantined', async () => {
    const dir = await scratch()
    expect(await readJsonFile(join(dir, 'nope.json'))).toBeNull()
    expect((await readdir(dir)).filter(n => n.endsWith('.corrupt'))).toEqual([])
  })

  it('creates parent directories as needed', async () => {
    const dir = await scratch()
    const nested = join(dir, 'a', 'b', 'c', 'state.json')
    await atomicWriteJson(nested, { deep: true })
    expect(await readJsonFile(nested)).toEqual({ deep: true })
  })

  it('listJsonIds ignores temp and quarantine files', async () => {
    const { listJsonIds } = await import('../index.js')
    const dir = await scratch()
    await mkdir(dir, { recursive: true })
    await atomicWriteJson(join(dir, 'real.json'), { ok: true })
    await writeFile(join(dir, 'real.json.abc123.tmp'), '{}', 'utf-8')
    await writeFile(join(dir, 'real.json.999.corrupt'), '{', 'utf-8')
    expect(await listJsonIds(dir)).toEqual(['real'])
  })
})
