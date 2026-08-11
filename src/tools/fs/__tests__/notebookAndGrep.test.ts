/**
 * notebook_edit and grep.
 *
 * Both were near-untested (8.8% and 57.1%), and writing these turned up two
 * real defects:
 *
 *   1. notebook_edit VALIDATED the path against workspaceRoot and then
 *      stat/read/wrote the RAW input. Node resolves a relative path against
 *      process.cwd(), so on any `-w <dir>` run the path that was checked and
 *      the path that was written were different files. Every other fs tool had
 *      already been moved onto resolveInsideWorkspace for this exact reason.
 *   2. grep's `multiline` meant two different things: rg got
 *      `--multiline-dotall` ("`.` matches newlines"), the JS fallback got 'm'
 *      ("`^`/`$` match at line breaks"). Same pattern, different results,
 *      decided by whether ripgrep happened to be installed.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createNotebookEditTool } from '../notebook_edit/index.js'
import { createGrepTool, rejectRedosProne } from '../grep/index.js'
import type { MetaAgentTool, ToolCallContext } from '../../../core/types.js'

let workspace: string
const dirs: string[] = []

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'nb-grep-'))
  dirs.push(workspace)
})
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

function ctx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    sessionId: 'test', agentId: 'main',
    abortSignal: new AbortController().signal,
    workspaceRoot: workspace,
    ...overrides,
  } as ToolCallContext
}

async function call(
  tool: MetaAgentTool, input: Record<string, unknown>, c: ToolCallContext = ctx(),
): Promise<{ content: string; isError: boolean }> {
  const r = await tool.call(input, c)
  return { content: String(r.content), isError: r.isError === true }
}

const NOTEBOOK = {
  cells: [
    { cell_type: 'markdown', source: ['# Title\n'], metadata: {} },
    { cell_type: 'code', source: ['print(1)\n'], metadata: {}, outputs: [{ text: 'stale' }], execution_count: 7 },
  ],
  metadata: {}, nbformat: 4, nbformat_minor: 5,
}

async function notebook(name = 'nb.ipynb'): Promise<string> {
  const path = join(workspace, name)
  await writeFile(path, JSON.stringify(NOTEBOOK, null, 1))
  return path
}

async function readNotebook(path: string): Promise<typeof NOTEBOOK> {
  return JSON.parse(await readFile(path, 'utf-8')) as typeof NOTEBOOK
}

// ── notebook_edit ─────────────────────────────────────────────────────────────

describe('notebook_edit', () => {
  it('replaces a cell and splits the source back into newline-terminated lines', async () => {
    const path = await notebook()
    const tool = await createNotebookEditTool()
    const { isError } = await call(tool, { notebook_path: path, cell_number: 1, new_source: 'a = 1\nb = 2' })
    expect(isError).toBe(false)
    // nbformat stores source as a list of lines, each keeping its trailing \n
    // except the last — a single joined string breaks other notebook tooling.
    expect((await readNotebook(path)).cells[1]!.source).toEqual(['a = 1\n', 'b = 2'])
  })

  it('clears stale outputs and execution_count when a code cell is replaced', async () => {
    const path = await notebook()
    const tool = await createNotebookEditTool()
    await call(tool, { notebook_path: path, cell_number: 1, new_source: 'print(2)' })
    const cell = (await readNotebook(path)).cells[1]!
    expect(cell.outputs).toEqual([])
    expect(cell.execution_count).toBeNull()
  })

  it('inserts a cell at the given index', async () => {
    const path = await notebook()
    const tool = await createNotebookEditTool()
    await call(tool, { notebook_path: path, cell_number: 1, new_source: 'inserted', edit_mode: 'insert' })
    const cells = (await readNotebook(path)).cells
    expect(cells).toHaveLength(3)
    expect(cells[1]!.source).toEqual(['inserted'])
    expect(cells[2]!.cell_type).toBe('code')
  })

  it('inserting AT length appends', async () => {
    const path = await notebook()
    const tool = await createNotebookEditTool()
    const { isError } = await call(tool, { notebook_path: path, cell_number: 2, new_source: 'last', edit_mode: 'insert' })
    expect(isError).toBe(false)
    expect((await readNotebook(path)).cells).toHaveLength(3)
  })

  it('rejects a negative insert index instead of counting from the end', async () => {
    // splice(-1, 0, x) silently inserts BEFORE the last cell.
    const path = await notebook()
    const tool = await createNotebookEditTool()
    const { content, isError } = await call(tool, { notebook_path: path, cell_number: -1, new_source: 'x', edit_mode: 'insert' })
    expect(isError).toBe(true)
    expect(content).toMatch(/out of range/)
    expect((await readNotebook(path)).cells).toHaveLength(2)
  })

  it('rejects an insert index past the end instead of silently appending', async () => {
    const path = await notebook()
    const tool = await createNotebookEditTool()
    expect((await call(tool, { notebook_path: path, cell_number: 99, new_source: 'x', edit_mode: 'insert' })).isError).toBe(true)
  })

  it('deletes a cell', async () => {
    const path = await notebook()
    const tool = await createNotebookEditTool()
    await call(tool, { notebook_path: path, cell_number: 0, edit_mode: 'delete' })
    const cells = (await readNotebook(path)).cells
    expect(cells).toHaveLength(1)
    expect(cells[0]!.cell_type).toBe('code')
  })

  it('delete does not require new_source', async () => {
    const path = await notebook()
    const tool = await createNotebookEditTool()
    expect((await call(tool, { notebook_path: path, cell_number: 0, edit_mode: 'delete' })).isError).toBe(false)
  })

  it('replace requires new_source', async () => {
    const path = await notebook()
    const tool = await createNotebookEditTool()
    const { content, isError } = await call(tool, { notebook_path: path, cell_number: 0 })
    expect(isError).toBe(true)
    expect(content).toMatch(/new_source required/)
  })

  it('rejects an out-of-range replace/delete index', async () => {
    const path = await notebook()
    const tool = await createNotebookEditTool()
    expect((await call(tool, { notebook_path: path, cell_number: 9, new_source: 'x' })).isError).toBe(true)
    expect((await call(tool, { notebook_path: path, cell_number: 9, edit_mode: 'delete' })).isError).toBe(true)
  })

  it('converting a code cell to markdown strips the code-only fields', async () => {
    // nbformat forbids `outputs` / `execution_count` on a markdown cell. The
    // tool used to leave whatever the code cell had, producing a notebook that
    // fails validation and that some readers refuse to open.
    const path = await notebook()
    const tool = await createNotebookEditTool()
    await call(tool, { notebook_path: path, cell_number: 1, new_source: '# note', cell_type: 'markdown' })
    const cell = (await readNotebook(path)).cells[1]! as Record<string, unknown>
    expect(cell['cell_type']).toBe('markdown')
    expect(cell).not.toHaveProperty('outputs')
    expect(cell).not.toHaveProperty('execution_count')
  })

  it('reports a non-notebook JSON file rather than corrupting it', async () => {
    const path = join(workspace, 'bad.ipynb')
    await writeFile(path, JSON.stringify({ notCells: true }))
    const tool = await createNotebookEditTool()
    const { content, isError } = await call(tool, { notebook_path: path, cell_number: 0, new_source: 'x' })
    expect(isError).toBe(true)
    expect(content).toMatch(/invalid notebook/)
  })

  it('reports unparseable JSON rather than throwing', async () => {
    const path = join(workspace, 'broken.ipynb')
    await writeFile(path, '{not json')
    const tool = await createNotebookEditTool()
    expect((await call(tool, { notebook_path: path, cell_number: 0, new_source: 'x' })).isError).toBe(true)
  })

  it('resolves a RELATIVE path against the workspace, not process.cwd()', async () => {
    // The regression this pins: the tool validated `p` against workspaceRoot
    // and then wrote the raw `p`, which Node resolves against cwd. Under a
    // `-w <dir>` run those are different files.
    expect(process.cwd()).not.toBe(workspace)
    await mkdir(join(workspace, 'nbs'), { recursive: true })
    const abs = await notebook(join('nbs', 'rel.ipynb'))
    const tool = await createNotebookEditTool()
    const { isError } = await call(tool, {
      notebook_path: relative(workspace, abs),   // "nbs/rel.ipynb"
      cell_number: 1, new_source: 'edited',
    })
    expect(isError).toBe(false)
    expect((await readNotebook(abs)).cells[1]!.source).toEqual(['edited'])
  })

  it('denies a notebook outside the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'))
    dirs.push(outside)
    const path = join(outside, 'nb.ipynb')
    await writeFile(path, JSON.stringify(NOTEBOOK))
    const tool = await createNotebookEditTool()
    const { isError } = await call(tool, { notebook_path: path, cell_number: 0, new_source: 'leak' })
    expect(isError).toBe(true)
    expect((await readNotebook(path)).cells[0]!.source).toEqual(['# Title\n'])
  })

  it('takes and releases the write mutex on the CANONICAL path', async () => {
    // Keying the lock on the raw input meant "nb.ipynb" and "./nb.ipynb" took
    // two different locks for the same file.
    const path = await notebook()
    const keys: string[] = []
    const writeMutex = { acquire: async (k: string) => { keys.push(k); return () => {} } }
    const tool = await createNotebookEditTool()
    await call(tool, { notebook_path: path, cell_number: 0, new_source: 'a' },
      ctx({ writeMutex } as unknown as Partial<ToolCallContext>))
    await call(tool, { notebook_path: `./${relative(workspace, path)}`, cell_number: 0, new_source: 'b' },
      ctx({ writeMutex } as unknown as Partial<ToolCallContext>))
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })
})

// ── grep ──────────────────────────────────────────────────────────────────────

describe('grep', () => {
  async function fixture(): Promise<void> {
    await writeFile(join(workspace, 'a.ts'), 'export const needle = 1\n')
    await writeFile(join(workspace, 'b.ts'), 'nothing here\n')
    await mkdir(join(workspace, 'sub'), { recursive: true })
    await writeFile(join(workspace, 'sub', 'c.ts'), 'another NEEDLE\n')
  }

  it('finds matching files', async () => {
    await fixture()
    const tool = await createGrepTool()
    const { content, isError } = await call(tool, { pattern: 'needle' })
    expect(isError).toBe(false)
    expect(content).toContain('a.ts')
    expect(content).not.toContain('b.ts')
  })

  it('case_insensitive widens the match', async () => {
    await fixture()
    const tool = await createGrepTool()
    const sensitive = await call(tool, { pattern: 'NEEDLE' })
    const insensitive = await call(tool, { pattern: 'NEEDLE', case_insensitive: true })
    expect(sensitive.content).not.toContain('a.ts')
    expect(insensitive.content).toContain('a.ts')
  })

  it('reports no matches as a non-error result', async () => {
    await fixture()
    const tool = await createGrepTool()
    const { content, isError } = await call(tool, { pattern: 'zzz-not-present-zzz' })
    expect(isError).toBe(false)
    expect(content).toBe('No matches found')
  })

  it('requires a pattern', async () => {
    const tool = await createGrepTool()
    expect((await call(tool, {})).isError).toBe(true)
  })

  it('denies a search path outside the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'))
    dirs.push(outside)
    const tool = await createGrepTool()
    const { content, isError } = await call(tool, { pattern: 'x', path: outside })
    expect(isError).toBe(true)
    expect(content).toMatch(/outside workspace/)
  })

  it('multiline lets a pattern span lines', async () => {
    // rg: --multiline-dotall. JS fallback: 's'. Both must agree.
    await writeFile(join(workspace, 'multi.ts'), 'START\nmiddle\nEND\n')
    const tool = await createGrepTool()
    const { content } = await call(tool, { pattern: 'START.*END', multiline: true, path: join(workspace, 'multi.ts') })
    expect(content).toContain('multi.ts')
  })

  it('without multiline the same pattern does not span lines', async () => {
    await writeFile(join(workspace, 'multi.ts'), 'START\nmiddle\nEND\n')
    const tool = await createGrepTool()
    const { content } = await call(tool, { pattern: 'START.*END', path: join(workspace, 'multi.ts') })
    expect(content).toBe('No matches found')
  })
})

// ── ReDoS guard ───────────────────────────────────────────────────────────────

describe('rejectRedosProne', () => {
  it('rejects the classic nested-quantifier shapes', async () => {
    for (const pattern of ['(a+)+', '(a*)*', '(a+)*', '(\\d+)+$', '([a-z]+)+', '(.*)+', '(x+){2,}']) {
      expect(rejectRedosProne(pattern), pattern).toMatch(/backtrack catastrophically/)
    }
  })

  it('allows ordinary patterns that merely look similar', async () => {
    for (const pattern of [
      'needle',
      '(foo|bar)+',          // alternation of literals — linear
      '(\\d{3})+',           // fixed-length body
      '(ab)*',               // fixed-length body
      'a+b+',                // sequential, not nested
      '^\\s*export\\s+const',
      '\\((\\w+)\\)',        // escaped parens around a bounded group
      '[(]a+[)]+',           // parens inside a character class are literals
    ]) {
      expect(rejectRedosProne(pattern), pattern).toBeNull()
    }
  })

  it('the guard actually prevents the freeze it exists for', async () => {
    // Pre-fix, `(a+)+$` against a 41-char string blocked the event loop for
    // 86,909 ms — long enough for other processes to declare this one's file
    // locks stale and take them.
    await writeFile(join(workspace, 'v.txt'), `${'a'.repeat(40)}!`)
    const tool = await createGrepTool()
    const started = Date.now()
    const { isError } = await call(tool, { pattern: '(a+)+$', path: join(workspace, 'v.txt') })
    const elapsed = Date.now() - started
    // Either rg handled it out of process, or the guard rejected it. Either way
    // it must return promptly; only the unguarded JS path takes ~87s.
    expect(elapsed).toBeLessThan(5_000)
    expect(typeof isError).toBe('boolean')
  }, 20_000)

  it('an invalid regex is reported, not thrown', async () => {
    await writeFile(join(workspace, 'a.txt'), 'x')
    const tool = await createGrepTool()
    const { isError } = await call(tool, { pattern: '([unclosed', path: join(workspace, 'a.txt') })
    expect(isError).toBe(true)
  })
})

// ── The portable Node fallback ────────────────────────────────────────────────

/**
 * On any machine that ships ripgrep — every dev box and CI image here — the
 * fallback is unreachable, which is how it came to hold an unguarded
 * synchronous regex that could freeze the whole process for 87 seconds.
 * META_AGENT_DISABLE_RIPGREP forces it so it can be exercised.
 */
describe('grep · Node fallback (META_AGENT_DISABLE_RIPGREP)', () => {
  beforeEach(() => { process.env['META_AGENT_DISABLE_RIPGREP'] = '1' })
  afterEach(() => { delete process.env['META_AGENT_DISABLE_RIPGREP'] })

  async function fixture(): Promise<void> {
    await writeFile(join(workspace, 'a.ts'), 'export const needle = 1\n')
    await writeFile(join(workspace, 'b.ts'), 'nothing here\n')
    await mkdir(join(workspace, 'sub'), { recursive: true })
    await writeFile(join(workspace, 'sub', 'c.ts'), 'another needle\n')
  }

  it('finds matches recursively without ripgrep', async () => {
    await fixture()
    const tool = await createGrepTool()
    const { content, isError } = await call(tool, { pattern: 'needle' })
    expect(isError).toBe(false)
    expect(content).toContain('a.ts')
    expect(content).toContain('c.ts')
    expect(content).not.toContain('b.ts')
  })

  it('agrees with the rg path on case sensitivity', async () => {
    await writeFile(join(workspace, 'x.ts'), 'NEEDLE\n')
    const tool = await createGrepTool()
    expect((await call(tool, { pattern: 'needle', path: join(workspace, 'x.ts') })).content).toBe('No matches found')
    expect((await call(tool, { pattern: 'needle', case_insensitive: true, path: join(workspace, 'x.ts') })).content)
      .toContain('x.ts')
  })

  it('multiline means dotAll here too, matching the rg path', async () => {
    // The bug: JS 'm' (line anchors) instead of 's' (dotAll). Same pattern,
    // different answer depending on whether rg happened to be installed.
    await writeFile(join(workspace, 'multi.ts'), 'START\nmiddle\nEND\n')
    const tool = await createGrepTool()
    expect((await call(tool, { pattern: 'START.*END', multiline: true, path: join(workspace, 'multi.ts') })).content)
      .toContain('multi.ts')
    expect((await call(tool, { pattern: 'START.*END', path: join(workspace, 'multi.ts') })).content)
      .toBe('No matches found')
  })

  it('skips node_modules, .git and dist', async () => {
    for (const d of ['node_modules', '.git', 'dist']) {
      await mkdir(join(workspace, d), { recursive: true })
      await writeFile(join(workspace, d, 'junk.ts'), 'needle\n')
    }
    await writeFile(join(workspace, 'real.ts'), 'needle\n')
    const tool = await createGrepTool()
    const { content } = await call(tool, { pattern: 'needle' })
    expect(content).toContain('real.ts')
    expect(content).not.toContain('node_modules')
    expect(content).not.toContain('dist')
  })

  it('searches a single file when path points at one', async () => {
    await fixture()
    const tool = await createGrepTool()
    expect((await call(tool, { pattern: 'needle', path: join(workspace, 'a.ts') })).content)
      .toContain('a.ts')
  })

  it('REJECTS a catastrophic pattern instead of freezing the event loop', async () => {
    // With rg forced off there is no out-of-process timeout to save us, and
    // regex.test() is synchronous — the FALLBACK_MAX_MS check at the top of the
    // scan loop can never run while it backtracks. Measured pre-fix: 86,909 ms
    // on a 41-character file, long enough for other processes to declare this
    // one's file locks stale.
    await writeFile(join(workspace, 'v.txt'), `${'a'.repeat(40)}!`)
    const tool = await createGrepTool()
    const started = Date.now()
    const { content, isError } = await call(tool, { pattern: '(a+)+$', path: join(workspace, 'v.txt') })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(isError).toBe(true)
    expect(content).toMatch(/backtrack catastrophically/)
  }, 20_000)

  it('reports an invalid regex as a tool error', async () => {
    await writeFile(join(workspace, 'a.txt'), 'x')
    const tool = await createGrepTool()
    const { content, isError } = await call(tool, { pattern: '([unclosed', path: join(workspace, 'a.txt') })
    expect(isError).toBe(true)
    expect(content).toMatch(/invalid regular expression/)
  })

  it('reports no matches without erroring', async () => {
    await fixture()
    const tool = await createGrepTool()
    expect((await call(tool, { pattern: 'zzz-absent-zzz' })).content).toBe('No matches found')
  })

  it('skips a file bigger than the per-file cap and says the search stopped early', async () => {
    await writeFile(join(workspace, 'huge.txt'), 'needle'.repeat(400_000))   // ~2.4 MB
    await writeFile(join(workspace, 'small.txt'), 'needle\n')
    const tool = await createGrepTool()
    const { content } = await call(tool, { pattern: 'needle' })
    expect(content).toContain('small.txt')
    expect(content).not.toContain('huge.txt')
    expect(content).toContain('stopped early')
  })

  it('rejects a single oversized file given directly', async () => {
    await writeFile(join(workspace, 'huge.txt'), 'x'.repeat(3 * 1024 * 1024))
    const tool = await createGrepTool()
    const { content, isError } = await call(tool, { pattern: 'x', path: join(workspace, 'huge.txt') })
    expect(isError).toBe(true)
    expect(content).toMatch(/too large/)
  })

  it('still denies a path outside the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'))
    dirs.push(outside)
    const tool = await createGrepTool()
    expect((await call(tool, { pattern: 'x', path: outside })).isError).toBe(true)
  })
})
