/**
 * VolatileContext — the single canonical implementation of the volatile
 * `<context>…</context>` user-message prefix parser.
 *
 * Callers (MetaAgentSession / RoboticsSession / CampaignSession) prepend
 * per-turn ephemeral state to the user prompt as:
 *
 *   `<context>\n{xml-tagged blocks}\n</context>\n\n---\n\n{user prompt}`
 *
 * Previously four near-copies of the stripper existed (KernelSession,
 * KernelLoop, CompactConversation, CompactPrompt) with diverging boundary
 * rules (`indexOf('</context>')` vs `lastIndexOf(full sentinel)`). They are
 * unified here with these deliberate choices:
 *
 *  - Match the FULL sentinel `\n</context>\n\n---\n\n`, not the bare closing
 *    tag: a bare `</context>` inside section content (e.g. memory recall
 *    quoting a past transcript) must not terminate the prefix early.
 *  - Use the FIRST occurrence of the full sentinel: the prefix is always
 *    emitted before the user prompt, so the first sentinel is the real
 *    boundary. Using the LAST occurrence would destroy genuine user text when
 *    the user pastes a transcript that itself contains a volatile prefix —
 *    losing user intent is strictly worse than leaking some context text.
 *  - When the text starts with `<context>` but no full sentinel exists, return
 *    the text unchanged rather than guessing a boundary.
 */

export const VOLATILE_CONTEXT_PREFIX_START = '<context>\n'
export const VOLATILE_CONTEXT_PREFIX_END = '\n</context>\n\n---\n\n'

/**
 * Strip the leading volatile context prefix from a user-message text block.
 * Returns the text unchanged when no well-formed prefix is present.
 */
export function stripVolatileContextPrefix(text: string): string {
  if (!text.startsWith(VOLATILE_CONTEXT_PREFIX_START)) return text
  const end = text.indexOf(VOLATILE_CONTEXT_PREFIX_END)
  if (end < 0) return text
  return text.slice(end + VOLATILE_CONTEXT_PREFIX_END.length)
}
