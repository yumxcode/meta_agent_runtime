/**
 * imageBlocks — construction, sniffing and measurement of image content blocks.
 *
 * The runtime's single internal representation for an image is the Anthropic
 * shape:
 *
 *   { type: 'image', source: { type: 'base64', media_type, data } }
 *   { type: 'image', source: { type: 'url', url } }
 *
 * That choice is deliberate. `KernelMessage.content` is already Anthropic-shaped
 * and `MessageNormalizer` is an identity pass-through, so protocol differences
 * collapse into ONE place: the OpenAI-format exit in DeepSeekMessageNormalizer.
 * Storing images in OpenAI shape instead would force a translation on the two
 * primary paths (Claude, GLM) to save one on the third.
 *
 * This module is a DEPENDENCY LEAF: it takes only type-only imports, so it can
 * be used from `providers/`, `kernel/`, `core/` and `tools/` without any of the
 * cycles ArchitecturalInvariants.test.ts guards against.
 */
import { readFile } from 'node:fs/promises'
import type { ImageBlock, TextBlock, ContentBlock } from '../types/KernelMessage.js'

// ─────────────────────────────────────────────────────────────────────────────
// Formats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The intersection of what GLM and DeepSeek accept, which is also exactly the
 * Anthropic SDK's `Base64ImageSource.media_type` union. Widening this list means
 * proving every provider in the registry accepts the new type.
 */
export const SUPPORTED_IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const

export type SupportedImageMediaType = typeof SUPPORTED_IMAGE_MEDIA_TYPES[number]

/**
 * Narrowed forms of `ImageBlock`.
 *
 * The Anthropic type declares `source` as an unnarrowed `Base64ImageSource |
 * URLImageSource`, so a value typed as plain `ImageBlock` cannot be assigned
 * anywhere that requires one specific variant — `ContentBlockLike`, for one.
 * The constructors below return these instead; both remain assignable to
 * `ImageBlock`.
 */
export interface Base64ImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: SupportedImageMediaType; data: string }
}

export interface UrlImageBlock {
  type: 'image'
  source: { type: 'url'; url: string }
}

/** File extensions that MAY be images. Only a hint — the bytes decide. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

export function hasImageExtension(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot !== -1 && IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

// ─────────────────────────────────────────────────────────────────────────────
// Magic-number sniffing
// ─────────────────────────────────────────────────────────────────────────────

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false
  }
  return true
}

const SIG_JPEG = [0xff, 0xd8, 0xff]
const SIG_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const SIG_GIF = [0x47, 0x49, 0x46, 0x38] // "GIF8" — 87a and 89a both start here
const SIG_RIFF = [0x52, 0x49, 0x46, 0x46] // "RIFF"
const SIG_WEBP = [0x57, 0x45, 0x42, 0x50] // "WEBP" at offset 8

/**
 * Determine the media type from the bytes themselves.
 *
 * Extensions and declared MIME types are NOT consulted, because DeepSeek states
 * outright that it decides format "由文件实际内容判断，而非文件名或声明的 MIME
 * 类型". A JPEG renamed to `.png` is accepted there but would be labelled
 * `image/png` on our side, which the Anthropic path rejects with a 400 — a
 * failure that would look like a provider outage rather than a bad filename.
 */
export function sniffImageMediaType(bytes: Uint8Array): SupportedImageMediaType | null {
  if (startsWith(bytes, SIG_PNG)) return 'image/png'
  if (startsWith(bytes, SIG_JPEG)) return 'image/jpeg'
  if (startsWith(bytes, SIG_GIF)) return 'image/gif'
  if (startsWith(bytes, SIG_RIFF) && startsWith(bytes, SIG_WEBP, 8)) return 'image/webp'
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Dimensions
// ─────────────────────────────────────────────────────────────────────────────

export interface ImageDimensions {
  width: number
  height: number
}

/**
 * Read pixel dimensions from a header, without decoding the image.
 *
 * Needed because the per-image edge cap is a hard provider limit (DeepSeek:
 * 8192 px per side, dropping to 4096 px once a request carries 15+ images), and
 * a request that violates it fails AFTER the whole payload has been uploaded.
 * Returns null when the header cannot be parsed — callers treat that as
 * "unknown", not as "over the limit".
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // PNG: IHDR is always the first chunk; width/height are big-endian at 16/20.
  if (startsWith(bytes, SIG_PNG) && bytes.length >= 24) {
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) }
  }

  // GIF: logical screen descriptor, little-endian at 6/8.
  if (startsWith(bytes, SIG_GIF) && bytes.length >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }

  // WebP: three container flavours.
  if (startsWith(bytes, SIG_RIFF) && startsWith(bytes, SIG_WEBP, 8) && bytes.length >= 30) {
    const fourcc = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
    if (fourcc === 'VP8X') {
      // 24-bit little-endian, stored as (dimension - 1).
      const w = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1
      const h = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1
      return { width: w, height: h }
    }
    if (fourcc === 'VP8 ') {
      // Lossy: 14-bit dimensions after the 3-byte start code at offset 23.
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      }
    }
    if (fourcc === 'VP8L') {
      // Lossless: 14-bit each, packed across 4 bytes after the 0x2f signature.
      const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return null
  }

  // JPEG: walk the segment chain looking for a Start-Of-Frame marker.
  if (startsWith(bytes, SIG_JPEG)) return readJpegDimensions(bytes, view)

  return null
}

function readJpegDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++ // resynchronise on fill bytes / padding
      continue
    }
    const marker = bytes[offset + 1]!
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xda || marker === 0xd9) return null // start of scan / end of image
    const length = view.getUint16(offset + 2, false)
    if (length < 2) return null
    // SOF0..SOF15, excluding DHT (c4), DNL (c8) and DAC (cc) which share the range.
    const isSOF = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSOF) {
      return {
        height: view.getUint16(offset + 5, false),
        width: view.getUint16(offset + 7, false),
      }
    }
    offset += 2 + length
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedImageError'
  }
}

export function makeImageBlockFromBytes(bytes: Uint8Array, sourceLabel?: string): Base64ImageBlock {
  const mediaType = sniffImageMediaType(bytes)
  if (!mediaType) {
    const where = sourceLabel ? ` (${sourceLabel})` : ''
    throw new UnsupportedImageError(
      `Not a supported image${where}. Recognised by content: ${SUPPORTED_IMAGE_MEDIA_TYPES.join(', ')}. ` +
      `The file extension is not consulted — the bytes are.`,
    )
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: Buffer.from(bytes).toString('base64'),
    },
  }
}

export async function makeImageBlockFromFile(path: string): Promise<Base64ImageBlock> {
  const bytes = await readFile(path)
  return makeImageBlockFromBytes(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), path)
}

/**
 * Reference an image by public URL instead of inlining it.
 *
 * Cheaper on the wire (no base64 33% inflation, no request-body cap) but not
 * universally supported — check `VisionLimits.acceptsImageUrl` before using it.
 */
export function makeImageBlockFromUrl(url: string): UrlImageBlock {
  return { type: 'image', source: { type: 'url', url } }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inspection
// ─────────────────────────────────────────────────────────────────────────────

export function isImageBlock(block: ContentBlock | { type?: string }): block is ImageBlock {
  return (block as { type?: string }).type === 'image'
}

/** Decoded byte length of an inline image; 0 for URL references. */
export function imageBlockByteLength(block: ImageBlock): number {
  const source = block.source
  if (source.type !== 'base64') return 0
  // base64 encodes 3 bytes per 4 chars, minus padding.
  const chars = source.data.length
  const padding = source.data.endsWith('==') ? 2 : source.data.endsWith('=') ? 1 : 0
  return Math.floor((chars * 3) / 4) - padding
}

/** Decode an inline image back to bytes. Returns null for URL references. */
export function imageBlockBytes(block: ImageBlock): Uint8Array | null {
  if (block.source.type !== 'base64') return null
  return new Uint8Array(Buffer.from(block.source.data, 'base64'))
}

/** `data:` URL form, which is how both OpenAI-protocol providers take inline images. */
export function imageBlockToDataUrl(block: ImageBlock): string {
  const source = block.source
  if (source.type === 'url') return source.url
  return `data:${source.media_type};base64,${source.data}`
}

export function imageBlockMediaType(block: ImageBlock): string {
  return block.source.type === 'base64' ? block.source.media_type : 'image/*'
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost & degradation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Token cost of one image, as a per-provider constant.
 *
 * Providers scale every image to a fixed budget before inference (DeepSeek: to
 * roughly 800×800, capped at 384 tokens), so cost does not track byte size at
 * all. Estimating from the base64 string instead — which is what a generic
 * chars/4 estimator does — inflates a 1 MB image to ~350k tokens and trips
 * auto-compaction on the very first attachment.
 */
export function estimateImageTokens(_block: ImageBlock, ceiling: number): number {
  return ceiling
}

/**
 * Replace an image with a text placeholder.
 *
 * Used on three paths: a non-vision model receiving history that contains
 * images, a provider that forbids images outside `user` messages, and the
 * retention sweep that ages out older attachments.
 */
export function downgradeImageBlock(block: ImageBlock, hint?: string): TextBlock {
  const label = hint ?? (block.source.type === 'url' ? block.source.url : imageBlockMediaType(block))
  return { type: 'text', text: `[image: ${label}]` }
}
