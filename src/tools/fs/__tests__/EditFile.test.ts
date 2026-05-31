import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEditFileTool } from '../edit_file/index.js'
import { FileStateCache } from '../../../kernel/session/FileStateCache.js'
import type { ToolCallContext } from '../../../core/types.js'

function makeCtx(workspaceRoot: string, fileCache: FileStateCache = new FileStateCache()): ToolCallContext {
  return {
    sessionId: 'test',
    agentId: 'test',
    abortSignal: new AbortController().signal,
    workspaceRoot,
    readFileState: fileCache,
  } as unknown as ToolCallContext
}

describe('edit_file — regression fixes (H2 / H3 / L4)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'edit-file-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('H2: inserts $1 / $& verbatim instead of treating them as backrefs', async () => {
    const tool = await createEditFileTool()
    const filePath = join(dir, 'a.txt')
    await writeFile(filePath, 'placeholder', 'utf8')
    const result = await tool.call(
      { file_path: filePath, old_string: 'placeholder', new_string: 'literal $1 $& $$' },
      makeCtx(dir),
    )
    expect(result.isError).toBe(false)
    const after = await readFile(filePath, 'utf8')
    expect(after).toBe('literal $1 $& $$')
  })

  it('H2: replace_all also handles $1 correctly', async () => {
    const tool = await createEditFileTool()
    const filePath = join(dir, 'b.txt')
    await writeFile(filePath, 'x x x', 'utf8')
    const result = await tool.call(
      { file_path: filePath, old_string: 'x', new_string: '$1', replace_all: true },
      makeCtx(dir),
    )
    expect(result.isError).toBe(false)
    const after = await readFile(filePath, 'utf8')
    expect(after).toBe('$1 $1 $1')
  })

  it('H3: rejects empty old_string', async () => {
    const tool = await createEditFileTool()
    const filePath = join(dir, 'c.txt')
    await writeFile(filePath, 'anything', 'utf8')
    const result = await tool.call(
      { file_path: filePath, old_string: '', new_string: 'BAD' },
      makeCtx(dir),
    )
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('non-empty string')
  })

  it('L4: refuses to edit when file was modified after the recorded read', async () => {
    const tool = await createEditFileTool()
    const filePath = join(dir, 'd.txt')
    await writeFile(filePath, 'original', 'utf8')
    const fileCache = new FileStateCache()
    // Record a fake snapshot taken at a wildly different (older) mtime so the
    // guard fires regardless of FS timestamp resolution.
    fileCache.record(filePath, /* sizeBytes */ 'original'.length, /* mtimeMs */ 1)
    const ctx = makeCtx(dir, fileCache)
    const result = await tool.call(
      { file_path: filePath, old_string: 'original', new_string: 'tampered' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('changed on disk')
    // file unchanged
    expect(await readFile(filePath, 'utf8')).toBe('original')
  })

  it('L4: allows edit when no cache entry exists (first-time edit)', async () => {
    const tool = await createEditFileTool()
    const filePath = join(dir, 'e.txt')
    await writeFile(filePath, 'fresh', 'utf8')
    const result = await tool.call(
      { file_path: filePath, old_string: 'fresh', new_string: 'updated' },
      makeCtx(dir, new FileStateCache()),
    )
    expect(result.isError).toBe(false)
    expect(await readFile(filePath, 'utf8')).toBe('updated')
  })
})
