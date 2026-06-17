/**
 * StructuralTruncate — a NO-MODEL compaction fallback for auto mode.
 *
 * Problem it solves: the model-based compactor has a circuit breaker
 * (MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES). Once it opens, nothing shrinks the
 * context, so an unattended (auto-mode) session keeps growing until it hits the
 * blocking limit and the request is hard-rejected — the run dies with no human
 * to recover it. This module guarantees forward progress without any model call.
 *
 * Strategy (chosen for SAFETY): we never DROP messages or reorder them, so
 * tool_use↔tool_result pairing and user/assistant alternation stay intact and
 * the result is always a valid API request. We only CLIP the text of oversized
 * blocks in the older portion of the history, preserving the recent tail
 * verbatim. This is intentionally lossy but never corrupting.
 *
 * Only invoked when CompactOptions.autonomyFallback is set (auto mode), so other
 * modes keep their existing fail-soft behaviour (grow, then block).
 */
import type { ContentBlock, KernelMessage } from '../types/KernelMessage.js'
import { calculateTokenWarningState } from '../utils/Context.js'
import { tokenCountWithEstimation } from '../api/TokenCount.js'

/** Recent messages always kept verbatim (full detail for the next turn). */
const KEEP_RECENT = 6
/** Progressive per-block char caps applied to the older portion. */
const CLIP_CAPS = [6000, 3000, 1500, 600, 250]
/** Aim comfortably below the autocompact threshold so we don't re-fire next turn. */
const TARGET_RATIO = 0.85

const CLIP_MARKER = '\n…[clipped by structural-truncate fallback]'

function clipText(text: string, cap: number): string {
  if (text.length <= cap) return text
  return text.slice(0, Math.max(0, cap - CLIP_MARKER.length)) + CLIP_MARKER
}

function clipBlock(block: ContentBlock, cap: number): ContentBlock {
  // Text blocks
  if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
    return { ...block, text: clipText((block as { text: string }).text, cap) }
  }
  // Thinking blocks (large reasoning traces)
  if (block.type === 'thinking' && typeof (block as { thinking?: unknown }).thinking === 'string') {
    return { ...block, thinking: clipText((block as { thinking: string }).thinking, cap) }
  }
  // Tool results — string content or array of text parts (the usual context hogs)
  if (block.type === 'tool_result') {
    const tr = block as { content?: unknown }
    if (typeof tr.content === 'string') {
      return { ...block, content: clipText(tr.content, cap) }
    }
    if (Array.isArray(tr.content)) {
      const content = tr.content.map((part: unknown) =>
        part && typeof part === 'object' && (part as { type?: string }).type === 'text'
          ? { ...(part as object), text: clipText(String((part as { text?: unknown }).text ?? ''), cap) }
          : part,
      )
      return { ...block, content } as ContentBlock
    }
  }
  // tool_use / image / redacted_thinking: leave intact (small or not safely clippable).
  return block
}

function clipMessage(message: KernelMessage, cap: number): KernelMessage {
  return { ...message, content: message.content.map((b) => clipBlock(b, cap)) }
}

export interface StructuralTruncateResult {
  postCompactMessages: KernelMessage[]
  summaryTokenEstimate: number
  /** The clip cap that brought the context under target, or the smallest tried. */
  appliedCap: number
}

/**
 * Clip the older portion of `messages` until the estimated token count drops
 * under ~85% of the autocompact threshold. The most recent KEEP_RECENT messages
 * are never clipped. Always returns a valid, same-length, same-order message
 * array.
 */
export function structuralTruncate(
  messages: readonly KernelMessage[],
  model: string,
  maxOutputTokens: number | undefined,
): StructuralTruncateResult {
  const threshold = calculateTokenWarningState(0, model, maxOutputTokens).autoCompactThreshold
  const target = Math.floor(threshold * TARGET_RATIO)
  const cutoff = Math.max(0, messages.length - KEEP_RECENT)

  let lastCandidate = [...messages]
  let appliedCap = CLIP_CAPS[CLIP_CAPS.length - 1]!

  for (const cap of CLIP_CAPS) {
    appliedCap = cap
    const candidate = messages.map((m, i) => (i < cutoff ? clipMessage(m, cap) : m))
    lastCandidate = candidate
    const estimate = tokenCountWithEstimation(candidate)
    if (estimate <= target) {
      return { postCompactMessages: candidate, summaryTokenEstimate: estimate, appliedCap: cap }
    }
  }

  // Smallest cap still over target (the recent tail alone may exceed it). Return
  // the most-clipped candidate — best effort; the loop above already minimised it.
  return {
    postCompactMessages: lastCandidate,
    summaryTokenEstimate: tokenCountWithEstimation(lastCandidate),
    appliedCap,
  }
}
