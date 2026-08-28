import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReadFileTool } from '../read_file/index.js'
import type { MetaAgentTool, ToolCallContext } from '../../../core/types.js'

let dir: string
let tool: MetaAgentTool

function pngBytes(width = 32, height = 16): Buffer {
  const b = Buffer.alloc(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'readimg-'))
  tool = await createReadFileTool()
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function ctx(): ToolCallContext {
  return { workspaceRoot: dir } as unknown as ToolCallContext
}

describe('read_file with images', () => {
  it('returns an image block instead of utf-8 mojibake', async () => {
    // These files used to fall through to readFile(path, 'utf-8') and come back
    // as replacement characters — a silent wrong answer, since nothing in the
    // result said "this is binary".
    await writeFile(join(dir, 'shot.png'), pngBytes())
    const result = await tool.call({ file_path: join(dir, 'shot.png') }, ctx())

    expect(result.isError).toBe(false)
    expect(result.blocks).toBeDefined()
    const image = result.blocks!.find(b => b.type === 'image')
    expect(image).toBeDefined()
    expect((image as { source: { media_type: string } }).source.media_type).toBe('image/png')
  })

  it('puts a readable summary in content, which is what compaction will show', async () => {
    await writeFile(join(dir, 'shot.png'), pngBytes(1920, 1080))
    const result = await tool.call({ file_path: join(dir, 'shot.png') }, ctx())
    expect(result.content).toContain('image/png')
    expect(result.content).toContain('1920×1080')
    // The base64 must not leak into the text fallback.
    expect(result.content.length).toBeLessThan(300)
  })

  it('reports a file whose extension lies rather than declaring a wrong media type', async () => {
    await writeFile(join(dir, 'fake.png'), Buffer.from('#!/bin/sh\necho hi\n'))
    const result = await tool.call({ file_path: join(dir, 'fake.png') }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not a supported image')
  })

  it('leaves text files entirely alone', async () => {
    await writeFile(join(dir, 'a.txt'), 'line one\nline two\n')
    const result = await tool.call({ file_path: join(dir, 'a.txt') }, ctx())
    expect(result.blocks).toBeUndefined()
    expect(result.content).toContain('line one')
  })
})
