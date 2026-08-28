import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseAttachmentRefs,
  loadAttachment,
  validateAttachments,
  buildPromptInput,
  AttachmentError,
} from '../attachments.js'
import type { Base64ImageBlock } from '../../kernel/messages/imageBlocks.js'

function pngBytes(width = 8, height = 8): Buffer {
  const b = Buffer.alloc(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

async function fixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'attach-'))
}

describe('parseAttachmentRefs', () => {
  it('extracts a reference and removes it from the text', () => {
    const { text, refs } = parseAttachmentRefs('what is this @/tmp/shot.png')
    expect(refs).toEqual(['/tmp/shot.png'])
    expect(text).toBe('what is this')
  })

  it('extracts several references in order', () => {
    const { text, refs } = parseAttachmentRefs('compare @a.png and @b.jpg please')
    expect(refs).toEqual(['a.png', 'b.jpg'])
    expect(text).toBe('compare and please')
  })

  it('leaves ordinary @ text alone', () => {
    // The extension is what makes this syntax safe to run on every line: `@` is
    // ordinary text in package names, emails and handles, and claiming all of
    // them would break far more prompts than the feature serves.
    for (const line of [
      'install @meta-agent/runtime',
      'email me at bob@example.com',
      'the @Override annotation',
    ]) {
      expect(parseAttachmentRefs(line)).toEqual({ text: line, refs: [] })
    }
  })

  it('does not claim an @ in the middle of a token', () => {
    const { refs } = parseAttachmentRefs('user@host.png')
    expect(refs).toEqual([])
  })

  it('accepts a quoted path, which is what terminals emit for dragged files', () => {
    const { text, refs } = parseAttachmentRefs("look at @'/Users/me/My Photos/a.png' now")
    expect(refs).toEqual(['/Users/me/My Photos/a.png'])
    expect(text).toBe('look at now')
  })

  it('accepts a backslash-escaped path from terminals that escape instead of quote', () => {
    const { refs } = parseAttachmentRefs('see @/Users/me/My\\ Photos/a.png')
    expect(refs).toEqual(['/Users/me/My Photos/a.png'])
  })
})

describe('loadAttachment', () => {
  it('reads a real image and inlines it', async () => {
    const dir = await fixtureDir()
    await writeFile(join(dir, 'a.png'), pngBytes())
    const block = await loadAttachment('a.png', dir) as Base64ImageBlock
    expect(block.source.media_type).toBe('image/png')
  })

  it('reports a missing file instead of sending the path as text', async () => {
    const dir = await fixtureDir()
    await expect(loadAttachment('nope.png', dir)).rejects.toThrow(AttachmentError)
  })

  it('reports a file whose extension lies about its contents', async () => {
    const dir = await fixtureDir()
    await writeFile(join(dir, 'fake.png'), Buffer.from('not an image at all'))
    await expect(loadAttachment('fake.png', dir)).rejects.toThrow(/Not a supported image/)
  })

  it('keeps a URL as a reference rather than downloading it', async () => {
    const block = await loadAttachment('https://example.com/a.png', '/tmp')
    expect(block.source).toEqual({ type: 'url', url: 'https://example.com/a.png' })
  })

  // The size ceiling is enforced here, on the stat size, and NOT only in
  // validateAttachments(). By the time validation sees the block the file has
  // been read into a Buffer and base64-encoded into a string 33% larger again,
  // so an oversized attachment would exhaust memory before the check that was
  // meant to reject it ever ran.
  it('refuses an oversized file before reading it', async () => {
    const dir = await fixtureDir()
    const big = Buffer.alloc(64 * 1024)
    pngBytes().copy(big, 0)
    await writeFile(join(dir, 'big.png'), big)

    await expect(loadAttachment('big.png', dir, 1024)).rejects.toThrow(/per-image limit/)
  })

  it('does not read the bytes of a file it is going to refuse', async () => {
    const dir = await fixtureDir()
    const big = Buffer.alloc(64 * 1024)
    pngBytes().copy(big, 0)
    await writeFile(join(dir, 'big.png'), big)

    // A file that is BOTH oversized and not a valid image must fail on size.
    // If the size error wins, the read never happened — which is the point.
    const garbage = Buffer.alloc(64 * 1024, 0x41)
    await writeFile(join(dir, 'garbage.png'), garbage)
    await expect(loadAttachment('garbage.png', dir, 1024)).rejects.toThrow(/per-image limit/)
  })

  it('accepts a file at exactly the ceiling', async () => {
    const dir = await fixtureDir()
    const exact = Buffer.alloc(1024)
    pngBytes().copy(exact, 0)
    await writeFile(join(dir, 'exact.png'), exact)

    const block = await loadAttachment('exact.png', dir, 1024) as Base64ImageBlock
    expect(block.source.media_type).toBe('image/png')
  })

  it('applies no ceiling when none is supplied', async () => {
    const dir = await fixtureDir()
    const big = Buffer.alloc(64 * 1024)
    pngBytes().copy(big, 0)
    await writeFile(join(dir, 'big.png'), big)

    const block = await loadAttachment('big.png', dir) as Base64ImageBlock
    expect(block.source.media_type).toBe('image/png')
  })
})

describe('validateAttachments', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } } as const

  it('names the model and offers alternatives when it cannot see', async () => {
    await expect(validateAttachments([image], { model: 'deepseek-v4-pro' }))
      .rejects.toThrow(/does not accept images.*deepseek-v4-flash-vision-exp/s)
  })

  it('accepts an attachment on a vision model', async () => {
    await expect(validateAttachments([image], { model: 'deepseek-v4-flash-vision-exp' }))
      .resolves.toBeUndefined()
  })

  it('rejects an over-count request before anything is uploaded', async () => {
    const many = Array.from({ length: 30 }, () => image)
    await expect(validateAttachments(many, { model: 'mystery-vision' }))
      .rejects.toThrow()
  })

  it('rejects an image whose longest side exceeds the cap', async () => {
    const huge = {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: pngBytes(20_000, 100).toString('base64'),
      },
    }
    await expect(validateAttachments([huge], { model: 'deepseek-v4-flash-vision-exp' }))
      .rejects.toThrow(/20000×100/)
  })

  it('does not reject an image whose header it cannot parse', async () => {
    // A parse miss is "unknown", never "over the limit" — refusing on a
    // shortcoming of ours would reject valid images.
    await expect(validateAttachments([image], { model: 'deepseek-v4-flash-vision-exp' }))
      .resolves.toBeUndefined()
  })

  it('does nothing at all when there are no attachments', async () => {
    // A text-only turn must never be gated on the model's vision capability.
    await expect(validateAttachments([], { model: 'deepseek-v4-pro' })).resolves.toBeUndefined()
  })
})

describe('buildPromptInput', () => {
  it('returns the line unchanged as a string when nothing is attached', async () => {
    const out = await buildPromptInput({
      line: 'just a question',
      cwd: '/tmp',
      target: { model: 'deepseek-v4-pro' },
    })
    expect(out).toBe('just a question')
  })

  it('splits text and images into parts, text first', async () => {
    const dir = await fixtureDir()
    await writeFile(join(dir, 'a.png'), pngBytes())
    const out = await buildPromptInput({
      line: 'explain @a.png',
      cwd: dir,
      target: { model: 'deepseek-v4-flash-vision-exp' },
    })
    expect(Array.isArray(out)).toBe(true)
    const parts = out as Array<{ type: string }>
    expect(parts.map(p => p.type)).toEqual(['text', 'image'])
  })

  it('merges --image references with inline @ references', async () => {
    const dir = await fixtureDir()
    await writeFile(join(dir, 'a.png'), pngBytes())
    await writeFile(join(dir, 'b.png'), pngBytes())
    const out = await buildPromptInput({
      line: 'compare @a.png',
      extraRefs: ['b.png'],
      cwd: dir,
      target: { model: 'deepseek-v4-flash-vision-exp' },
    })
    const parts = out as Array<{ type: string }>
    expect(parts.filter(p => p.type === 'image')).toHaveLength(2)
  })

  it('fails the turn rather than sending an unresolved reference as text', async () => {
    const dir = await fixtureDir()
    await expect(buildPromptInput({
      line: 'explain @missing.png',
      cwd: dir,
      target: { model: 'deepseek-v4-flash-vision-exp' },
    })).rejects.toThrow(AttachmentError)
  })
})
