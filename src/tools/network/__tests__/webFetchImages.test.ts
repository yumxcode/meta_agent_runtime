/**
 * web_fetch image handling.
 *
 * The defect these pin (found reviewing the 0.9.5 multimodal work): the image
 * branch declared a 5 MiB inline cap, but the transfer itself stopped at
 * `MAX_CONTENT * 2` = 200 KiB. Every image larger than 200 KiB was therefore
 * cut short, and because magic bytes live at offset 0 the truncated body still
 * sniffed as a valid PNG/JPEG — so a partial download was base64-inlined and
 * labelled as a complete image. Silent wrong answer: nothing in the result said
 * the picture was half missing.
 *
 * Driven through `renderImageResponse` rather than the tool: the SSRF guard
 * refuses loopback by design, which is also why `classifyBody` and `renderPage`
 * are exported for their own tests.
 */

import { describe, it, expect } from 'vitest'
import { renderImageResponse } from '../web_fetch/index.js'
import { isImageBlock, imageBlockByteLength } from '../../../kernel/messages/imageBlocks.js'

/** A syntactically valid PNG header of `size` bytes. */
function pngOf(size: number, width = 1920, height = 1080): Buffer {
  const buf = Buffer.alloc(size)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function jpegOf(size: number): Buffer {
  const buf = Buffer.alloc(size)
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(buf, 0)
  return buf
}

const URL = 'https://example.com/photo.png'

describe('web_fetch image truncation', () => {
  it('refuses a truncated image instead of inlining the partial bytes', () => {
    // The exact shape of the bug: 200 KiB of a larger PNG. Valid signature,
    // well under the 5 MiB cap — it would have sailed through both checks.
    const partial = pngOf(200 * 1024)
    const res = renderImageResponse(URL, 'image/png', partial, true)

    expect(res.isError).toBe(true)
    expect(res.blocks).toBeUndefined()
    expect(res.content).toMatch(/partial download/)
  })

  it('says why, so the failure is actionable rather than mysterious', () => {
    const res = renderImageResponse(URL, 'image/png', pngOf(200 * 1024), true)
    expect(res.content).toMatch(/corrupt image/)
    expect(res.content).toMatch(/downscale/)
  })

  it('refuses on truncation even though the magic bytes still sniff correctly', () => {
    // Guards the ORDER of the two checks. Sniffing first would report "not a
    // supported image", which is both wrong and misleading — the format was
    // fine, the download was not.
    for (const body of [pngOf(150 * 1024), jpegOf(150 * 1024)]) {
      const res = renderImageResponse(URL, 'image/png', body, true)
      expect(res.isError).toBe(true)
      expect(res.content).not.toMatch(/not a supported image/)
    }
  })

  it('refuses an image over the inline cap', () => {
    const res = renderImageResponse(URL, 'image/png', pngOf(6 * 1024 * 1024), false)
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/larger than 5 MiB/)
  })

  it('inlines a complete image that fits', () => {
    const body = pngOf(300 * 1024)
    const res = renderImageResponse(URL, 'image/png', body, false)

    expect(res.isError).toBe(false)
    const image = res.blocks?.find(isImageBlock)
    expect(image).toBeDefined()
    // The whole file, not a prefix — this is what regressed.
    expect(imageBlockByteLength(image!)).toBe(300 * 1024)
  })

  it('reports dimensions and media type from the bytes', () => {
    const res = renderImageResponse(URL, 'image/png', pngOf(4096, 800, 600), false)
    expect(res.content).toMatch(/image\/png/)
    expect(res.content).toMatch(/800×600/)
  })

  it('trusts the bytes over a mislabelled content-type', () => {
    // Server says TIFF, bytes say PNG. The media_type we send must come from
    // the bytes, or the provider rejects the request with an opaque 400.
    const res = renderImageResponse(URL, 'image/tiff', pngOf(1024), false)
    expect(res.isError).toBe(false)
    expect(res.content).toMatch(/image\/png/)
  })

  it('refuses bytes that are not an image at all, naming what it accepts', () => {
    const res = renderImageResponse(URL, 'image/png', Buffer.from('<html>nope</html>'), false)
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/not a supported image/)
    expect(res.content).toMatch(/image\/jpeg/)
  })

  it('carries a text fallback alongside the image block', () => {
    // Compaction, the trajectory record and the debug transcript cannot render
    // an image; the text block is what they will show.
    const res = renderImageResponse(URL, 'image/png', pngOf(2048), false)
    const text = res.blocks?.find(b => b.type === 'text')
    expect(text).toBeDefined()
    expect(res.content).toContain(URL)
  })
})
