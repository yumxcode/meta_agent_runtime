import { describe, it, expect } from 'vitest'
import {
  sniffImageMediaType,
  readImageDimensions,
  makeImageBlockFromBytes,
  makeImageBlockFromUrl,
  imageBlockByteLength,
  imageBlockToDataUrl,
  hasImageExtension,
  UnsupportedImageError,
} from '../imageBlocks.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────
//
// Hand-built headers rather than real files: every field the code reads is
// visible here, so a dimension test that breaks says which byte moved.

function pngBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(b.buffer)
  view.setUint32(8, 13, false)          // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12)   // "IHDR"
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  return b
}

function gifBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(13)
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0) // "GIF89a"
  const view = new DataView(b.buffer)
  view.setUint16(6, width, true)
  view.setUint16(8, height, true)
  return b
}

function jpegBytes(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment to be skipped over, then SOF0 carrying the dimensions.
  const b = new Uint8Array(40)
  const view = new DataView(b.buffer)
  b.set([0xff, 0xd8], 0)                 // SOI
  b.set([0xff, 0xe0], 2)                 // APP0
  view.setUint16(4, 16, false)           // APP0 length (payload skipped)
  b.set([0xff, 0xc0], 20)                // SOF0
  view.setUint16(22, 17, false)          // SOF0 length
  b[24] = 8                              // precision
  view.setUint16(25, height, false)
  view.setUint16(27, width, false)
  return b
}

function webpBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30)
  b.set([0x52, 0x49, 0x46, 0x46], 0)     // "RIFF"
  b.set([0x57, 0x45, 0x42, 0x50], 8)     // "WEBP"
  b.set([0x56, 0x50, 0x38, 0x58], 12)    // "VP8X"
  const w = width - 1
  const h = height - 1
  b[24] = w & 0xff; b[25] = (w >> 8) & 0xff; b[26] = (w >> 16) & 0xff
  b[27] = h & 0xff; b[28] = (h >> 8) & 0xff; b[29] = (h >> 16) & 0xff
  return b
}

describe('sniffImageMediaType', () => {
  it('identifies each supported format from its magic number', () => {
    expect(sniffImageMediaType(pngBytes(1, 1))).toBe('image/png')
    expect(sniffImageMediaType(jpegBytes(1, 1))).toBe('image/jpeg')
    expect(sniffImageMediaType(gifBytes(1, 1))).toBe('image/gif')
    expect(sniffImageMediaType(webpBytes(1, 1))).toBe('image/webp')
  })

  it('rejects non-image bytes', () => {
    expect(sniffImageMediaType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull() // %PDF
    expect(sniffImageMediaType(new Uint8Array(0))).toBeNull()
  })

  it('ignores the extension entirely — the bytes decide the media type', () => {
    // DeepSeek states outright that it judges format by content, not filename.
    // A JPEG named .png must be labelled image/jpeg or the Anthropic path 400s.
    const block = makeImageBlockFromBytes(jpegBytes(4, 4), 'screenshot.png')
    expect(block.source.media_type).toBe('image/jpeg')
  })

  it('refuses a file whose extension lies and whose bytes are not an image', () => {
    expect(() => makeImageBlockFromBytes(new Uint8Array([1, 2, 3, 4]), 'fake.png'))
      .toThrow(UnsupportedImageError)
  })
})

describe('readImageDimensions', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(readImageDimensions(pngBytes(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  it('reads GIF dimensions (little-endian) from the screen descriptor', () => {
    expect(readImageDimensions(gifBytes(640, 480))).toEqual({ width: 640, height: 480 })
  })

  it('reads JPEG dimensions by walking past intervening segments to SOF0', () => {
    expect(readImageDimensions(jpegBytes(800, 600))).toEqual({ width: 800, height: 600 })
  })

  it('reads WebP VP8X dimensions, which are stored as (size - 1)', () => {
    expect(readImageDimensions(webpBytes(2048, 1536))).toEqual({ width: 2048, height: 1536 })
  })

  it('returns null rather than guessing when the header is unparseable', () => {
    // Callers must treat this as "unknown", never as "over the limit" — a parse
    // miss of ours should not reject a valid image.
    expect(readImageDimensions(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull()
  })
})

describe('block construction', () => {
  it('round-trips bytes through base64 and reports the decoded length', () => {
    const bytes = pngBytes(10, 10)
    const block = makeImageBlockFromBytes(bytes)
    expect(imageBlockByteLength(block)).toBe(bytes.length)
    expect(imageBlockToDataUrl(block)).toMatch(/^data:image\/png;base64,/)
  })

  it('leaves a URL reference as a URL, costing no request bytes', () => {
    const block = makeImageBlockFromUrl('https://example.com/a.png')
    expect(imageBlockByteLength(block)).toBe(0)
    expect(imageBlockToDataUrl(block)).toBe('https://example.com/a.png')
  })
})

describe('hasImageExtension', () => {
  it('accepts the supported extensions case-insensitively', () => {
    for (const p of ['a.png', 'B.JPG', 'c.jpeg', 'd.GIF', 'e.webp']) {
      expect(hasImageExtension(p)).toBe(true)
    }
  })

  it('rejects everything else, so `@` stays safe in ordinary prose', () => {
    for (const p of ['notes.md', '@meta-agent/runtime', 'a.png.txt', 'noext']) {
      expect(hasImageExtension(p)).toBe(false)
    }
  })
})
