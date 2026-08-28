/**
 * attachments — turn a typed CLI line into a PromptInput carrying images.
 *
 * Two ways in:
 *   • `@path/to/shot.png` inline in the prompt text (also what a terminal
 *     drag-and-drop produces, modulo quoting)
 *   • `--image <path|url>`, repeatable, for the non-interactive `-p` path
 *
 * Everything is validated HERE, against the target model's registry limits,
 * rather than left to the API. An over-limit request fails only after the whole
 * base64 payload has been uploaded, and the resulting 400 names neither the
 * offending image nor the limit it broke.
 */
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  hasImageExtension,
  imageBlockByteLength,
  makeImageBlockFromFile,
  makeImageBlockFromUrl,
  readImageDimensions,
  imageBlockBytes,
  UnsupportedImageError,
} from '../kernel/messages/imageBlocks.js'
import type { PromptImagePart, PromptInput, PromptPart } from '../core/promptInput.js'
import type { ImageBlock } from '../kernel/types/KernelMessage.js'
import {
  effectiveEdgePixels,
  getVisionLimits,
  modelSupportsVision,
  PROVIDERS,
} from '../providers/registry.js'

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentError'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing `@path` references
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedAttachmentLine {
  /** The line with attachment references removed. */
  text: string
  /** Raw path strings, in the order they appeared. */
  refs: string[]
}

/**
 * Pull `@path` image references out of a typed line.
 *
 * A reference is recognised ONLY when the token carries an image extension.
 * That restriction is what makes the syntax safe to apply to every line: `@`
 * is ordinary text in email addresses, scoped package names
 * (`@meta-agent/runtime`), decorators and handles, and treating all of them as
 * file references would break far more prompts than it would serve. The
 * extension is a routing hint only — once a token is claimed, the file's actual
 * BYTES decide whether it is a usable image, and a mismatch is reported rather
 * than guessed at.
 *
 * Quoting follows what terminals emit on drag-and-drop: iTerm2 and friends wrap
 * paths containing spaces in single quotes, others backslash-escape the spaces.
 * Both are accepted.
 */
export function parseAttachmentRefs(line: string): ParsedAttachmentLine {
  const refs: string[] = []
  let text = ''
  let i = 0

  while (i < line.length) {
    if (line[i] !== '@') {
      text += line[i]
      i++
      continue
    }
    // A reference must start a token: beginning of line or preceded by space.
    const prev = i > 0 ? line[i - 1]! : ' '
    if (!/\s/.test(prev)) {
      text += line[i]
      i++
      continue
    }

    const parsed = readPathToken(line, i + 1)
    if (parsed && hasImageExtension(parsed.value)) {
      refs.push(parsed.value)
      i = parsed.next
      // Collapse the whitespace the removed token would have left behind.
      while (i < line.length && line[i] === ' ') i++
      if (text.endsWith(' ') === false && text.length > 0) text += ' '
      continue
    }
    text += line[i]
    i++
  }

  return { text: text.trim(), refs }
}

interface PathToken {
  value: string
  next: number
}

function readPathToken(line: string, start: number): PathToken | null {
  if (start >= line.length) return null
  const quote = line[start]
  if (quote === '"' || quote === "'") {
    const end = line.indexOf(quote, start + 1)
    if (end === -1) return null
    return { value: line.slice(start + 1, end), next: end + 1 }
  }

  let value = ''
  let i = start
  while (i < line.length) {
    const ch = line[i]!
    if (ch === '\\' && i + 1 < line.length && line[i + 1] === ' ') {
      value += ' '   // terminal-escaped space in a dragged path
      i += 2
      continue
    }
    if (/\s/.test(ch)) break
    value += ch
    i++
  }
  return value.length > 0 ? { value, next: i } : null
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

function isHttpUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref)
}

/**
 * Load one reference — a URL stays a reference, a path is read and inlined.
 *
 * @param maxBytes Refuse before reading anything larger than this. The size
 *   limit is enforced again in `validateAttachments()` against the decoded
 *   block, but that is far too late to be the ONLY check: by then the file has
 *   been read into a Buffer and base64-encoded into a string 33% larger again,
 *   so pointing `@` at a multi-gigabyte file would exhaust memory before the
 *   validation that was supposed to reject it ever ran. `stat` already gives us
 *   the size for free.
 */
export async function loadAttachment(ref: string, cwd: string, maxBytes?: number): Promise<ImageBlock> {
  if (isHttpUrl(ref)) return makeImageBlockFromUrl(ref)

  const path = isAbsolute(ref) ? ref : resolve(cwd, ref)
  let size: number
  try {
    const info = await stat(path)
    if (info.isDirectory()) throw new AttachmentError(`Attachment is a directory: ${path}`)
    size = info.size
  } catch (err) {
    if (err instanceof AttachmentError) throw err
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new AttachmentError(`Attachment not found: ${path}`)
    }
    throw new AttachmentError(`Cannot read attachment ${path}: ${(err as Error).message}`)
  }
  if (size === 0) throw new AttachmentError(`Attachment is empty: ${path}`)
  if (maxBytes !== undefined && size > maxBytes) {
    throw new AttachmentError(
      `Attachment ${path} is ${formatBytes(size)}; the per-image limit is ${formatBytes(maxBytes)}. ` +
      'Compress or downscale it first.',
    )
  }

  try {
    return await makeImageBlockFromFile(path)
  } catch (err) {
    if (err instanceof UnsupportedImageError) throw new AttachmentError(err.message)
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/** Vision-capable models this provider offers, for the "use one of these" hint. */
function visionModelsFor(model: string | undefined, baseURL?: string): string[] {
  const out: string[] = []
  for (const spec of Object.values(PROVIDERS)) {
    const matchesProvider =
      (baseURL && spec.urlMatchers.some(m => baseURL.includes(m))) ||
      (model && spec.modelMatchers.some(m => model.startsWith(m)))
    if (!matchesProvider) continue
    for (const [name, ms] of Object.entries(spec.modelTable)) {
      if (ms.capabilities?.vision) out.push(name)
    }
  }
  return out
}

export interface AttachmentTarget {
  model: string
  baseURL?: string
}

/**
 * Reject anything the target model would reject, while the user is still
 * looking at the prompt and can do something about it.
 */
export async function validateAttachments(
  images: readonly ImageBlock[],
  target: AttachmentTarget,
): Promise<void> {
  if (images.length === 0) return

  if (!modelSupportsVision(target.model, target.baseURL)) {
    const alternatives = visionModelsFor(target.model, target.baseURL)
    const hint = alternatives.length > 0
      ? ` Vision-capable models on this provider: ${alternatives.join(', ')}.`
      : ''
    throw new AttachmentError(
      `Model '${target.model}' does not accept images.${hint}`,
    )
  }

  const limits = getVisionLimits(target.model, target.baseURL)

  if (images.length > limits.maxImagesPerRequest) {
    throw new AttachmentError(
      `${images.length} images attached; '${target.model}' accepts at most ${limits.maxImagesPerRequest} per request.`,
    )
  }

  const inlineImages = images.filter(b => b.source.type === 'base64')
  if (inlineImages.length < images.length && !limits.acceptsImageUrl) {
    throw new AttachmentError(
      `Model '${target.model}' does not accept image URLs. Download the image and attach the file instead.`,
    )
  }

  // The edge cap is not a constant: DeepSeek halves it once a request carries
  // 15+ images, so an image that is fine alone can fail purely because of what
  // it was batched with. Compute it from the final count.
  const edgeCap = effectiveEdgePixels(limits, images.length)

  let totalBytes = 0
  for (const [index, block] of inlineImages.entries()) {
    const bytes = imageBlockByteLength(block)
    totalBytes += bytes
    if (bytes > limits.maxImageBytes) {
      throw new AttachmentError(
        `Image #${index + 1} is ${formatBytes(bytes)}; the per-image limit for '${target.model}' is ${formatBytes(limits.maxImageBytes)}. Compress or downscale it first.`,
      )
    }
    const raw = imageBlockBytes(block)
    const dims = raw ? readImageDimensions(raw) : null
    // A header we cannot parse means "unknown", never "over the limit" — the
    // provider will scale it anyway, and refusing on a parse miss would reject
    // valid images for a shortcoming of ours.
    if (dims && Math.max(dims.width, dims.height) > edgeCap) {
      const because = limits.edgeDowngradeAtCount !== undefined && images.length >= limits.edgeDowngradeAtCount
        ? ` (reduced from ${limits.maxEdgePixels} px because this request carries ${images.length} images)`
        : ''
      throw new AttachmentError(
        `Image #${index + 1} is ${dims.width}×${dims.height}; the longest side must be at most ${edgeCap} px${because}.`,
      )
    }
  }

  if (totalBytes > limits.maxRequestImageBytes) {
    throw new AttachmentError(
      `Attachments total ${formatBytes(totalBytes)}; '${target.model}' accepts at most ${formatBytes(limits.maxRequestImageBytes)} per request.`,
    )
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`
  return `${bytes} B`
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildPromptOptions {
  /** Raw line as typed; `@path` references are extracted from it. */
  line: string
  /** Extra references from repeated `--image` flags. */
  extraRefs?: readonly string[]
  cwd: string
  target: AttachmentTarget
}

/**
 * Build the prompt for one turn.
 *
 * Returns a plain string when nothing was attached, so the text-only path — the
 * overwhelming majority of turns — is byte-identical to what it was before
 * attachments existed.
 */
export async function buildPromptInput(options: BuildPromptOptions): Promise<PromptInput> {
  const { text, refs } = parseAttachmentRefs(options.line)
  const allRefs = [...refs, ...(options.extraRefs ?? [])]
  if (allRefs.length === 0) return options.line

  // Resolve the per-image ceiling BEFORE reading anything, so an oversized file
  // is refused on its `stat` size rather than after it has been read and
  // base64-encoded. validateAttachments() still re-checks every limit — this is
  // only the cheap pre-filter that keeps the expensive path bounded.
  const perImageCeiling = getVisionLimits(options.target.model, options.target.baseURL).maxImageBytes

  const images: ImageBlock[] = []
  for (const ref of allRefs) {
    images.push(await loadAttachment(ref, options.cwd, perImageCeiling))
  }
  await validateAttachments(images, options.target)

  const parts: PromptPart[] = []
  if (text) parts.push({ type: 'text', text })
  for (const block of images) {
    parts.push({ type: 'image', source: block.source } as PromptImagePart)
  }
  return parts
}
