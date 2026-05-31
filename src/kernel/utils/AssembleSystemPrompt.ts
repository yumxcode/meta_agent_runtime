/**
 * assembleSystemPrompt — combine the static and dynamic halves of the system
 * prompt into a single string the model sees.
 *
 * Contract (L1 in CODE_REVIEW_2026-05-29):
 *   • Parts that are `undefined`, `null`, or the empty string are elided.
 *     This makes `''` a deliberate, documented sentinel for callers like
 *     MetaAgentSession that build their whole prompt out of the suffix.
 *   • Non-empty parts are joined with a single `'\n\n'` separator.
 *   • If no part is present the function returns `undefined` (so the kernel
 *     can omit the `system` field from the API request entirely).
 *
 * Centralising this lets KernelLoop, MetaAgentSession, and tests agree on
 * exactly what "no system prompt" looks like, without each call site needing
 * to remember the `filter(Boolean).join('\n\n')` recipe.
 */
export function assembleSystemPrompt(
  ...parts: Array<string | undefined | null>
): string | undefined {
  const kept: string[] = []
  for (const part of parts) {
    if (typeof part !== 'string') continue
    if (part.length === 0) continue
    kept.push(part)
  }
  if (kept.length === 0) return undefined
  return kept.join('\n\n')
}
