/**
 * The file tools the model actually uses on every task.
 *
 * These five sat at 9–13% line coverage while `workspaceGuard` — the boundary
 * check they all call — was near 100%. So "does the guard reject this path?"
 * was pinned, and "what does the tool DO after the guard says yes?" was not:
 * the atomic-rename write, edit_file's occurrence counting and its `$&`/`$1`
 * literal-insertion rule, the TOCTOU snapshot check, the write mutex, the size
 * caps, the ENOENT wording. All of that ran unobserved on every turn.
 *
 * Everything here runs against a real temp workspace. No mocks: these tools are
 * thin wrappers over fs, and mocking fs would test the wrapper against itself.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { rm, readFile, writeFile, mkdir, stat, symlink, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
// §8.1: fully-resolved temp roots. The fs tools canonicalise every path
// through workspaceGuard before comparing it to the workspace, so a lexical
// macOS `/var/folders/…` fixture is not the path the tool reports back.
import { makeTempDir } from '../../../__tests__/tempDir.js'
import { createReadFileTool } from '../read_file/index.js'
import { createWriteFileTool } from '../write_file/index.js'
import { createAppendFileTool } from '../append_file/index.js'
import { createEditFileTool } from '../edit_file/index.js'
import { createGlobTool } from '../glob/index.js'
import { createGrepTool } from '../grep/index.js'
import { FileStateCache } from '../../../kernel/session/FileStateCache.js'
import type { MetaAgentTool, ToolCallContext } from '../../../core/types.js'

let workspace: string
const dirs: string[] = []

beforeEach(async () => {
  workspace = await makeTempDir('fs-tools-')
  dirs.push(workspace)
})
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

function ctx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    sessionId: 'test',
    agentId: 'main',
    abortSignal: new AbortController().signal,
    workspaceRoot: workspace,
    ...overrides,
  } as ToolCallContext
}

async function call(
  tool: MetaAgentTool,
  input: Record<string, unknown>,
  c: ToolCallContext = ctx(),
): Promise<{ content: string; isError: boolean }> {
  const r = await tool.call(input, c)
  return { content: String(r.content), isError: r.isError === true }
}

// ── read_file ─────────────────────────────────────────────────────────────────

describe('read_file', () => {
  it('numbers lines with a 4-wide gutter and a tab separator', async () => {
    await writeFile(join(workspace, 'a.txt'), 'alpha\nbeta\ngamma')
    const tool = await createReadFileTool()
    const { content, isError } = await call(tool, { file_path: join(workspace, 'a.txt') })
    expect(isError).toBe(false)
    expect(content).toBe('   1\talpha\n   2\tbeta\n   3\tgamma')
  })

  it('honours offset and limit, and reports the true total in the footer', async () => {
    await writeFile(join(workspace, 'a.txt'), Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n'))
    const tool = await createReadFileTool()
    const { content } = await call(tool, { file_path: join(workspace, 'a.txt'), offset: 5, limit: 3 })
    expect(content).toContain('   5\tline5')
    expect(content).toContain('   7\tline7')
    expect(content).not.toContain('line8')
    expect(content).toContain('of 20]')
  })

  it('clamps a zero or negative offset to line 1 instead of wrapping', async () => {
    await writeFile(join(workspace, 'a.txt'), 'x\ny')
    const tool = await createReadFileTool()
    // Array.slice(-1) would return the LAST line — silently reading the wrong end.
    const { content } = await call(tool, { file_path: join(workspace, 'a.txt'), offset: 0 })
    expect(content.startsWith('   1\tx')).toBe(true)
  })

  it('reads past the end without erroring', async () => {
    await writeFile(join(workspace, 'a.txt'), 'only')
    const tool = await createReadFileTool()
    const { content, isError } = await call(tool, { file_path: join(workspace, 'a.txt'), offset: 999 })
    expect(isError).toBe(false)
    expect(content).toBe('')
  })

  it('records size + mtime so edit_file can run its TOCTOU check', async () => {
    const path = join(workspace, 'a.txt')
    await writeFile(path, 'hello')
    const cache = new FileStateCache()
    const tool = await createReadFileTool()
    await call(tool, { file_path: path }, ctx({ readFileState: cache }))
    const entry = cache.get(resolve(path))
    expect(entry?.sizeBytes).toBe(5)
    expect(entry?.mtimeMs).toBeGreaterThan(0)
  })

  it('renders a .ipynb as cell blocks rather than raw JSON', async () => {
    await writeFile(join(workspace, 'nb.ipynb'), JSON.stringify({
      cells: [
        { cell_type: 'markdown', source: ['# Title\n'] },
        { cell_type: 'code', source: 'print(1)' },
      ],
    }))
    const tool = await createReadFileTool()
    const { content } = await call(tool, { file_path: join(workspace, 'nb.ipynb') })
    expect(content).toContain('## Cell 1 [markdown]')
    expect(content).toContain('# Title')
    expect(content).toContain('## Cell 2 [code]')
    expect(content).toContain('print(1)')
  })

  it('rejects a directory with an actionable message', async () => {
    await mkdir(join(workspace, 'sub'))
    const tool = await createReadFileTool()
    const { content, isError } = await call(tool, { file_path: join(workspace, 'sub') })
    expect(isError).toBe(true)
    expect(content).toMatch(/is a directory/)
  })

  it('reports a missing file as not-found, not as a raw errno', async () => {
    const tool = await createReadFileTool()
    const { content, isError } = await call(tool, { file_path: join(workspace, 'nope.txt') })
    expect(isError).toBe(true)
    expect(content).toMatch(/File not found/)
  })

  it('requires file_path', async () => {
    const tool = await createReadFileTool()
    expect((await call(tool, {})).isError).toBe(true)
  })

  it('denies a path outside the workspace', async () => {
    const outside = await makeTempDir('outside-')
    dirs.push(outside)
    await writeFile(join(outside, 'secret.txt'), 'nope')
    const tool = await createReadFileTool()
    const { content, isError } = await call(tool, { file_path: join(outside, 'secret.txt') })
    expect(isError).toBe(true)
    expect(content).toMatch(/outside workspace/)
  })

  it('denies a symlink that points outside the workspace', async () => {
    // The guard canonicalises before comparing; a prefix check would pass this.
    const outside = await makeTempDir('outside-')
    dirs.push(outside)
    await writeFile(join(outside, 'secret.txt'), 'nope')
    await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'))
    const tool = await createReadFileTool()
    const { content, isError } = await call(tool, { file_path: join(workspace, 'link.txt') })
    expect(isError).toBe(true)
    expect(content).toMatch(/outside workspace/)
  })

  it('denies a sibling directory that merely shares the workspace prefix', async () => {
    // `<workspace>-backup` starts with `<workspace>` as a STRING but is not
    // inside it. This is the exact shape a startsWith() check waves through.
    const sibling = `${workspace}-backup`
    await mkdir(sibling, { recursive: true })
    dirs.push(sibling)
    await writeFile(join(sibling, 'secret.txt'), 'nope')
    const tool = await createReadFileTool()
    expect((await call(tool, { file_path: join(sibling, 'secret.txt') })).isError).toBe(true)
  })
})

// ── write_file ────────────────────────────────────────────────────────────────

describe('write_file', () => {
  it('creates missing parent directories', async () => {
    const tool = await createWriteFileTool()
    const path = join(workspace, 'deep', 'deeper', 'a.txt')
    const { isError } = await call(tool, { file_path: path, content: 'hi' })
    expect(isError).toBe(false)
    expect(await readFile(path, 'utf-8')).toBe('hi')
  })

  it('overwrites atomically and leaves no temp file behind', async () => {
    const tool = await createWriteFileTool()
    const path = join(workspace, 'a.txt')
    await call(tool, { file_path: path, content: 'first' })
    await call(tool, { file_path: path, content: 'second' })
    expect(await readFile(path, 'utf-8')).toBe('second')
    // The .write temp is renamed into place; a leftover means a leak.
    expect((await readdir(workspace)).filter(f => f.endsWith('.write'))).toEqual([])
  })

  it('writes an empty string rather than treating it as a missing argument', async () => {
    const tool = await createWriteFileTool()
    const path = join(workspace, 'empty.txt')
    const { isError } = await call(tool, { file_path: path, content: '' })
    expect(isError).toBe(false)
    expect(await readFile(path, 'utf-8')).toBe('')
  })

  it('rejects content past the size cap', async () => {
    const tool = await createWriteFileTool()
    const { content, isError } = await call(tool, {
      file_path: join(workspace, 'big.txt'),
      content: 'x'.repeat(6 * 1024 * 1024),
    })
    expect(isError).toBe(true)
    expect(content).toMatch(/too large/)
  })

  it('denies a write outside the workspace', async () => {
    const outside = await makeTempDir('outside-')
    dirs.push(outside)
    const tool = await createWriteFileTool()
    const { isError } = await call(tool, { file_path: join(outside, 'x.txt'), content: 'nope' })
    expect(isError).toBe(true)
    await expect(stat(join(outside, 'x.txt'))).rejects.toThrow()
  })

  it('serialises concurrent writers through the write mutex', async () => {
    // Auto mode injects the mutex; without it two sub-agents writing the same
    // path interleave. Assert the tool actually takes and releases it.
    const order: string[] = []
    let releaseCount = 0
    const writeMutex = {
      acquire: async (path: string) => {
        order.push(`acquire:${path.endsWith('a.txt')}`)
        return () => { releaseCount++ }
      },
    }
    const tool = await createWriteFileTool()
    await call(tool, { file_path: join(workspace, 'a.txt'), content: 'x' },
      ctx({ writeMutex } as unknown as Partial<ToolCallContext>))
    expect(order).toEqual(['acquire:true'])
    expect(releaseCount).toBe(1)
  })

  it('releases the mutex even when the write fails', async () => {
    let released = 0
    const writeMutex = { acquire: async () => () => { released++ } }
    const tool = await createWriteFileTool()
    // A directory in place of the file makes rename() fail.
    await mkdir(join(workspace, 'blocked'))
    const { isError } = await call(tool, { file_path: join(workspace, 'blocked'), content: 'x' },
      ctx({ writeMutex } as unknown as Partial<ToolCallContext>))
    expect(isError).toBe(true)
    expect(released).toBe(1)
  })
})

// ── append_file ───────────────────────────────────────────────────────────────

describe('append_file', () => {
  it('appends without replacing existing content', async () => {
    const path = join(workspace, 'log.jsonl')
    await writeFile(path, '{"a":1}\n')
    const tool = await createAppendFileTool()
    await call(tool, { file_path: path, content: '{"b":2}\n' })
    expect(await readFile(path, 'utf-8')).toBe('{"a":1}\n{"b":2}\n')
  })

  it('creates the file and its parents when absent', async () => {
    const tool = await createAppendFileTool()
    const path = join(workspace, 'logs', 'run.jsonl')
    const { isError } = await call(tool, { file_path: path, content: 'first\n' })
    expect(isError).toBe(false)
    expect(await readFile(path, 'utf-8')).toBe('first\n')
  })

  it('appends the bytes EXACTLY, adding no separator of its own', async () => {
    const path = join(workspace, 'log.txt')
    const tool = await createAppendFileTool()
    await call(tool, { file_path: path, content: 'a' })
    await call(tool, { file_path: path, content: 'b' })
    expect(await readFile(path, 'utf-8')).toBe('ab')
  })

  it('reports the byte length, not the character length', async () => {
    const tool = await createAppendFileTool()
    const { content } = await call(tool, { file_path: join(workspace, 'u.txt'), content: '中文' })
    expect(content).toMatch(/6 bytes/)   // 2 chars, 6 UTF-8 bytes
  })

  it('rejects a non-string content instead of coercing it', async () => {
    const tool = await createAppendFileTool()
    expect((await call(tool, { file_path: join(workspace, 'x'), content: 42 })).isError).toBe(true)
  })

  it('rejects an oversized append', async () => {
    const tool = await createAppendFileTool()
    const { isError } = await call(tool, {
      file_path: join(workspace, 'x'), content: 'x'.repeat(2 * 1024 * 1024),
    })
    expect(isError).toBe(true)
  })

  it('denies a path outside the workspace', async () => {
    const outside = await makeTempDir('outside-')
    dirs.push(outside)
    const tool = await createAppendFileTool()
    expect((await call(tool, { file_path: join(outside, 'x'), content: 'y' })).isError).toBe(true)
  })
})

// ── edit_file ─────────────────────────────────────────────────────────────────

describe('edit_file', () => {
  it('replaces a unique occurrence', async () => {
    const path = join(workspace, 'a.ts')
    await writeFile(path, 'const x = 1\nconst y = 2\n')
    const tool = await createEditFileTool()
    const { content, isError } = await call(tool, { file_path: path, old_string: 'const y = 2', new_string: 'const y = 3' })
    expect(isError).toBe(false)
    expect(content).toMatch(/Replaced 1 occurrence/)
    expect(await readFile(path, 'utf-8')).toBe('const x = 1\nconst y = 3\n')
  })

  it('refuses an ambiguous edit and names the count', async () => {
    const path = join(workspace, 'a.ts')
    await writeFile(path, 'foo\nfoo\nfoo\n')
    const tool = await createEditFileTool()
    const { content, isError } = await call(tool, { file_path: path, old_string: 'foo', new_string: 'bar' })
    expect(isError).toBe(true)
    expect(content).toMatch(/appears 3 times/)
    // And it changed nothing.
    expect(await readFile(path, 'utf-8')).toBe('foo\nfoo\nfoo\n')
  })

  it('replace_all replaces every occurrence and reports the count', async () => {
    const path = join(workspace, 'a.ts')
    await writeFile(path, 'foo\nfoo\nfoo\n')
    const tool = await createEditFileTool()
    const { content } = await call(tool, { file_path: path, old_string: 'foo', new_string: 'bar', replace_all: true })
    expect(content).toMatch(/Replaced 3 occurrence/)
    expect(await readFile(path, 'utf-8')).toBe('bar\nbar\nbar\n')
  })

  it('inserts $& / $1 / $$ literally instead of interpreting them', async () => {
    // String.prototype.replace would expand these; the tool uses split/join.
    const path = join(workspace, 'a.ts')
    await writeFile(path, 'TOKEN')
    const tool = await createEditFileTool()
    await call(tool, { file_path: path, old_string: 'TOKEN', new_string: '$& $1 $$ $`' })
    expect(await readFile(path, 'utf-8')).toBe('$& $1 $$ $`')
  })

  it('rejects an empty old_string', async () => {
    const path = join(workspace, 'a.ts')
    await writeFile(path, 'abc')
    const tool = await createEditFileTool()
    const { content, isError } = await call(tool, { file_path: path, old_string: '', new_string: 'X' })
    expect(isError).toBe(true)
    expect(content).toMatch(/non-empty/)
    // Without the guard, split('') explodes the file character-by-character.
    expect(await readFile(path, 'utf-8')).toBe('abc')
  })

  it('reports old_string not found without touching the file', async () => {
    const path = join(workspace, 'a.ts')
    await writeFile(path, 'abc')
    const tool = await createEditFileTool()
    const { content, isError } = await call(tool, { file_path: path, old_string: 'zzz', new_string: 'X' })
    expect(isError).toBe(true)
    expect(content).toMatch(/not found/)
    expect(await readFile(path, 'utf-8')).toBe('abc')
  })

  it('deletes text when new_string is empty', async () => {
    const path = join(workspace, 'a.ts')
    await writeFile(path, 'keep REMOVE keep')
    const tool = await createEditFileTool()
    await call(tool, { file_path: path, old_string: ' REMOVE', new_string: '' })
    expect(await readFile(path, 'utf-8')).toBe('keep keep')
  })

  it('refuses to edit a file that changed on disk since it was read', async () => {
    const path = join(workspace, 'a.ts')
    await writeFile(path, 'original content')
    const cache = new FileStateCache()
    const c = ctx({ readFileState: cache })

    const reader = await createReadFileTool()
    await call(reader, { file_path: path }, c)

    // Another process writes a DIFFERENT length so the size check fires.
    await writeFile(path, 'something else entirely, longer')

    const tool = await createEditFileTool()
    const { content, isError } = await call(tool, { file_path: path, old_string: 'something', new_string: 'X' }, c)
    expect(isError).toBe(true)
    expect(content).toMatch(/changed on disk/)
  })

  it('allows two edits in the same turn by refreshing its own snapshot', async () => {
    // The tool writes the file itself, which would trip the TOCTOU guard on the
    // second edit unless it re-records the post-write stat.
    const path = join(workspace, 'a.ts')
    await writeFile(path, 'aaa bbb ccc')
    const cache = new FileStateCache()
    const c = ctx({ readFileState: cache })
    const reader = await createReadFileTool()
    await call(reader, { file_path: path }, c)

    const tool = await createEditFileTool()
    expect((await call(tool, { file_path: path, old_string: 'aaa', new_string: 'AAA' }, c)).isError).toBe(false)
    expect((await call(tool, { file_path: path, old_string: 'bbb', new_string: 'BBB' }, c)).isError).toBe(false)
    expect(await readFile(path, 'utf-8')).toBe('AAA BBB ccc')
  })

  it('edits a never-read file (no snapshot means no TOCTOU check)', async () => {
    const path = join(workspace, 'a.ts')
    await writeFile(path, 'abc')
    const tool = await createEditFileTool()
    expect((await call(tool, { file_path: path, old_string: 'abc', new_string: 'xyz' },
      ctx({ readFileState: new FileStateCache() }))).isError).toBe(false)
  })

  it('holds the write mutex across the whole read-modify-write', async () => {
    const events: string[] = []
    const writeMutex = {
      acquire: async () => { events.push('acquire'); return () => { events.push('release') } },
    }
    const path = join(workspace, 'a.ts')
    await writeFile(path, 'abc')
    const tool = await createEditFileTool()
    await call(tool, { file_path: path, old_string: 'abc', new_string: 'xyz' },
      ctx({ writeMutex } as unknown as Partial<ToolCallContext>))
    expect(events).toEqual(['acquire', 'release'])
  })

  it('denies an edit outside the workspace', async () => {
    const outside = await makeTempDir('outside-')
    dirs.push(outside)
    await writeFile(join(outside, 'x.txt'), 'secret')
    const tool = await createEditFileTool()
    const { isError } = await call(tool, { file_path: join(outside, 'x.txt'), old_string: 'secret', new_string: 'leaked' })
    expect(isError).toBe(true)
    expect(await readFile(join(outside, 'x.txt'), 'utf-8')).toBe('secret')
  })

  it('reports a missing file as an error rather than creating it', async () => {
    const tool = await createEditFileTool()
    const path = join(workspace, 'ghost.ts')
    expect((await call(tool, { file_path: path, old_string: 'a', new_string: 'b' })).isError).toBe(true)
    await expect(stat(path)).rejects.toThrow()
  })
})

// ── Cross-tool: relative paths resolve against the workspace, not cwd ──────────

describe('path resolution', () => {
  it('resolves a relative path against workspaceRoot even when cwd differs', async () => {
    // process.cwd() during a test run is the repo, not the temp workspace. If
    // the tool resolved against cwd it would write into the repo — the exact
    // divergence resolveInsideWorkspace exists to close.
    expect(process.cwd()).not.toBe(workspace)
    const writer = await createWriteFileTool()
    const { isError } = await call(writer, { file_path: 'nested/rel.txt', content: 'ok' })
    expect(isError).toBe(false)
    expect(await readFile(join(workspace, 'nested', 'rel.txt'), 'utf-8')).toBe('ok')
  })

  it('a relative path may not climb out of the workspace', async () => {
    const writer = await createWriteFileTool()
    expect((await call(writer, { file_path: '../escaped.txt', content: 'nope' })).isError).toBe(true)
  })
})

// ── Pre-existing suite, preserved ─────────────────────────────────────────────
// These three came from the original FsTools.test.ts. They cover a distinct
// axis from everything above: that glob/grep DEFAULT to
// ToolCallContext.workspaceRoot rather than to process.cwd(), verified by
// actually chdir-ing somewhere else first.

describe('fs tools workspace defaults', () => {
  function defaultsCtx(workspaceRoot: string): ToolCallContext {
    return {
      sessionId: 's',
      agentId: 's',
      abortSignal: new AbortController().signal,
      workspaceRoot,
      readFileState: new FileStateCache(),
    } as ToolCallContext
  }

  async function tempProject(): Promise<string> {
    const dir = await makeTempDir('meta-agent-fs-')
    dirs.push(dir)
    return dir
  }

  it('glob defaults to ToolCallContext.workspaceRoot, not process.cwd()', async () => {
    const ws = await tempProject()
    const outside = await tempProject()
    await mkdir(join(ws, 'src'), { recursive: true })
    await writeFile(join(ws, 'src', 'target.ts'), 'export const target = true\n')
    await writeFile(join(outside, 'outside.ts'), 'export const outside = true\n')

    const previousCwd = process.cwd()
    process.chdir(outside)
    try {
      const tool = await createGlobTool()
      const result = await tool.call({ pattern: '**/*.ts' }, defaultsCtx(ws))
      expect(result.isError).toBe(false)
      expect(result.content).toContain(join(ws, 'src', 'target.ts'))
      expect(result.content).not.toContain(join(outside, 'outside.ts'))
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('grep defaults to ToolCallContext.workspaceRoot, not process.cwd()', async () => {
    const ws = await tempProject()
    const outside = await tempProject()
    await writeFile(join(ws, 'target.txt'), 'needle\n')
    await writeFile(join(outside, 'outside.txt'), 'needle\n')

    const previousCwd = process.cwd()
    process.chdir(outside)
    try {
      const tool = await createGrepTool()
      const result = await tool.call({ pattern: 'needle' }, defaultsCtx(ws))
      expect(result.isError).toBe(false)
      expect(String(result.content)).toContain(join(ws, 'target.txt'))
      expect(String(result.content)).not.toContain(join(outside, 'outside.txt'))
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('grep rejects explicit paths outside workspace', async () => {
    const ws = await tempProject()
    const outside = await tempProject()
    const tool = await createGrepTool()
    const result = await tool.call({ pattern: 'needle', path: outside }, defaultsCtx(ws))
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('outside workspace')
  })
})
