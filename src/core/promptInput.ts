/**
 * PromptInput — what a caller may submit as one user turn.
 *
 * Historically every session layer took `prompt: string`, and the kernel
 * (`KernelSession.submitMessage`) was the only place that could already accept
 * content blocks. Attachments need the block form to survive the whole way
 * down, so the session layers widen to `PromptInput` and use the helpers here
 * to keep their text-based logic — goal anchoring, memory recall, mode
 * detection, continuation detection — working on the text alone.
 *
 * The shape is described structurally rather than re-exported from the
 * Anthropic SDK, so a caller of the public API does not have to depend on a
 * provider's types to attach an image. It is a strict subset of `ContentBlock`,
 * so conversion is a widening cast.
 *
 * Dependency leaf: type-only imports.
 */
import type { SupportedImageMediaType } from '../kernel/messages/imageBlocks.js'
import type { ContentBlock } from '../kernel/types/KernelMessage.js'

export type PromptImageSource =
  | { type: 'base64'; media_type: SupportedImageMediaType; data: string }
  | { type: 'url'; url: string }

export type PromptTextPart = { type: 'text'; text: string }
export type PromptImagePart = { type: 'image'; source: PromptImageSource }
export type PromptPart = PromptTextPart | PromptImagePart

/**
 * A prompt is either a plain string — the form virtually every caller uses and
 * the form that stays on the wire unchanged — or a list of parts.
 */
export type PromptInput = string | PromptPart[]

// ─────────────────────────────────────────────────────────────────────────────
// Inspection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The text of a prompt, with attachments dropped.
 *
 * This is what every existing string-typed consumer should be given. Goal
 * anchoring, `isAutoContinuationPrompt`, memory recall queries and mode
 * detection are all reasoning about what the user SAID; an image contributes
 * nothing to any of them and `String(part)` would contribute `[object Object]`.
 */
export function promptTextOf(input: PromptInput): string {
  if (typeof input === 'string') return input
  return input
    .filter((p): p is PromptTextPart => p.type === 'text')
    .map(p => p.text)
    .join('')
}

export function promptImagesOf(input: PromptInput): PromptImagePart[] {
  if (typeof input === 'string') return []
  return input.filter((p): p is PromptImagePart => p.type === 'image')
}

export function promptHasImages(input: PromptInput): boolean {
  return typeof input !== 'string' && input.some(p => p.type === 'image')
}

// ─────────────────────────────────────────────────────────────────────────────
// Transformation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prepend context ahead of the user's turn.
 *
 * Several layers wrap the prompt in a preamble — volatile context sections,
 * auto-resume checkpoints, campaign phase suffixes. Each did it by string
 * interpolation, which is exactly the operation that destroys an attachment.
 * The prefix becomes its own leading text part instead, so images keep both
 * their content and their position relative to the user's words.
 *
 * A string prompt stays a string, so the text-only path is byte-identical to
 * what it was.
 */
export function withPromptPrefix(
  input: PromptInput,
  prefix: string,
  separator = '\n\n',
): PromptInput {
  if (!prefix) return input
  if (typeof input === 'string') return `${prefix}${separator}${input}`
  return [{ type: 'text', text: `${prefix}${separator}` }, ...input]
}

/** Replace the text of a prompt while keeping its attachments in order. */
export function withPromptText(input: PromptInput, text: string): PromptInput {
  if (typeof input === 'string') return text
  const images = promptImagesOf(input)
  if (images.length === 0) return text
  return [{ type: 'text', text }, ...images]
}

/**
 * Widen to kernel content blocks.
 *
 * `PromptPart` is a structural subset of `ContentBlock`, so this is a cast
 * rather than a conversion; it exists to keep the cast in one reviewed place
 * instead of at every call site.
 */
export function promptToContentBlocks(input: PromptInput): ContentBlock[] {
  if (typeof input === 'string') return [{ type: 'text', text: input }]
  return input as ContentBlock[]
}
