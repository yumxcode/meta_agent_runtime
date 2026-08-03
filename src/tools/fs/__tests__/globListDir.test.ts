import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGlobTool } from '../glob/index.js'
import { createListDirTool } from '../list_dir/index.js'

const roots: string[] = []
afterAll(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

/**
 * The shape that broke `glob`: a dependency tree that sorts BEFORE the source
 * directory the caller wants.
 *
 * The old implementation collected up to 5000 files and only then matched them,
 * so a large vendored tree consumed the entire budget and a rooted pattern came
 * back as "No files found" — absence reported for what was really an early
 * exit. A compiler stage downstream recorded a source directory full of code as
 * a missing precondition.
 *
 * Deliberately generic: this tool serves every domain, and a fixture named
 * after one project invites a skip list named after that project too (which is
 * exactly what happened — `pylibs`, one repository's vendoring choice, ended up
 * hardcoded as a default for everyone).
 *
 * Built once and shared. What these tests exercise is name-based pruning and
 * prefix rooting, neither of which needs the tree to be huge; writing tens of
 * thousands of files per test only starved the rest of the suite of file
 * descriptors.
 */
const VENDORED_FILES = 1_500
const SOURCE_FILES = ['parser.py', 'loader.py', 'runner.py']
let fixtureRoot = ''

async function writeInChunks(paths: string[]): Promise<void> {
  const CHUNK = 100
  for (let index = 0; index < paths.length; index += CHUNK) {
    await Promise.all(paths.slice(index, index + CHUNK).map(path => writeFile(path, 'x', 'utf8')))
  }
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'glob-vendored-'))
  roots.push(fixtureRoot)
  // "aaa_deps" sorts before "pipeline", mirroring the readdir order that made
  // the original bug deterministic rather than occasional. `site-packages` is a
  // real ecosystem convention, so it is legitimately in the skip list.
  await mkdir(join(fixtureRoot, 'aaa_deps', 'site-packages', 'deep'), { recursive: true })
  await writeInChunks(Array.from({ length: VENDORED_FILES }, (_, index) =>
    join(fixtureRoot, 'aaa_deps', 'site-packages', 'deep', `dep_${index}.py`)))
  await mkdir(join(fixtureRoot, 'pipeline', 'stage', 'core'), { recursive: true })
  await writeInChunks(SOURCE_FILES.map(name => join(fixtureRoot, 'pipeline', 'stage', 'core', name)))
  await mkdir(join(fixtureRoot, 'empty_dir'), { recursive: true })
}, 60_000)

const context = (root: string): never => ({ workspaceRoot: root, sessionId: 's', toolNames: new Set<string>() } as never)

describe('glob against a large dependency tree', () => {
  it('finds source files a dependency tree used to hide', async () => {
    const glob = await createGlobTool()
    const found = await glob.call({ pattern: 'pipeline/**/*.py' }, context(fixtureRoot))
    expect(String(found.content).split('\n')).toHaveLength(SOURCE_FILES.length)
    expect(String(found.content)).toContain('parser.py')
    expect(String(found.content)).not.toContain('No files found')
  })

  it('prunes conventional dependency directories out of an unrooted pattern', async () => {
    const glob = await createGlobTool()
    const found = String((await glob.call({ pattern: '**/*.py' }, context(fixtureRoot))).content)
    expect(found).toContain('parser.py')
    expect(found).not.toContain('dep_0.py')
  })

  it('still searches a skipped directory when the pattern names it', async () => {
    // Skipping is a default, not a prohibition — otherwise the fix would
    // reintroduce the same silent blindness in a different place.
    const glob = await createGlobTool()
    const found = String((await glob.call({ pattern: 'aaa_deps/site-packages/deep/*.py' }, context(fixtureRoot))).content)
    expect(found).toContain('dep_0.py')
  })

  it('never reports a truncated scan as absence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glob-truncated-'))
    roots.push(root)
    // 120 matches with a ceiling of 100: the scan stops early WITH results.
    await mkdir(join(root, 'many'), { recursive: true })
    await writeInChunks(Array.from({ length: 120 }, (_, index) => join(root, 'many', `file_${index}.txt`)))
    const glob = await createGlobTool()
    const content = String((await glob.call({ pattern: '**/*.txt' }, context(root))).content)
    expect(content).toContain('TRUNCATED')
    expect(content).not.toContain('No files found')
  })

  it('still says plainly that nothing matched when the scan completed', async () => {
    const glob = await createGlobTool()
    const content = String((await glob.call({ pattern: '**/*.rs' }, context(fixtureRoot))).content)
    expect(content).toContain('No files found')
    expect(content).not.toContain('TRUNCATED')
  })
})

describe('list_dir', () => {
  it('separates absent, empty and populated — a distinction glob cannot express', async () => {
    const listDir = await createListDirTool()

    const absent = String((await listDir.call({ path: 'nope' }, context(fixtureRoot))).content)
    expect(absent).toContain('Directory does not exist')

    const empty = String((await listDir.call({ path: 'empty_dir' }, context(fixtureRoot))).content)
    expect(empty).toContain('EMPTY')

    const populated = String((await listDir.call({ path: 'pipeline/stage/core' }, context(fixtureRoot))).content)
    expect(populated).toContain('parser.py')
    expect(populated).toContain(`${SOURCE_FILES.length} entries`)
  })

  it('reports directories first, with their child counts', async () => {
    const listDir = await createListDirTool()
    const content = String((await listDir.call({ path: 'pipeline' }, context(fixtureRoot))).content)
    expect(content).toContain('stage/')
    expect(content).toMatch(/stage\/\s+\(\d+ entries\)/)
  })

  it('answers without walking the dependency tree', async () => {
    const listDir = await createListDirTool()
    const started = Date.now()
    const content = String((await listDir.call({ path: 'pipeline' }, context(fixtureRoot))).content)
    expect(content).toContain('stage/')
    // A directory question must cost a directory read, not a full-tree walk.
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('names a file as a file rather than pretending it is missing', async () => {
    const listDir = await createListDirTool()
    const content = String((await listDir.call({ path: 'pipeline/stage/core/loader.py' }, context(fixtureRoot))).content)
    expect(content).toContain('Not a directory')
  })

  it('refuses a path outside the workspace', async () => {
    const listDir = await createListDirTool()
    const outside = await listDir.call({ path: join(tmpdir(), 'definitely-elsewhere') }, context(fixtureRoot))
    expect(outside.isError).toBe(true)
  })
})
