/**
 * Post-session knowledge extraction (v1, strict + merged).
 *
 * At session end (RoboticsSession.dispose) a SINGLE flash call scans the
 * transcript and extracts BOTH durable experiences and physical anchors —
 * strictly. Both default to empty: most sessions yield little or nothing, and
 * we would rather record NOTHING than flood the stores.
 *
 *   experience — only for a task that reached a CLEAR, VERIFIED outcome.
 *   anchor     — only for a concrete physical fact established by an actual
 *                measurement/experiment, or explicitly asserted by the user.
 *
 * Candidates go to their respective pending queues for human review
 * (/experience review, /anchor review); nothing is auto-committed.
 *
 * experience ↔ anchor are extracted INDEPENDENTLY here — no cross-links. The
 * bilateral relationship (claim/propagation) is deferred (see
 * docs/anchor-integration-plan.md).
 */

import type { FlashClient } from '../core/flash/FlashClient.js'
import type { ExperiencePendingStore } from './ExperiencePendingStore.js'
import type { PhysicalAnchorPendingStore } from './PhysicalAnchorPendingStore.js'

const MIN_MESSAGES = 6
const TURN_LIMIT = 12
const MAX_EXPERIENCES = 3
const MAX_ANCHORS = 3

export const KNOWLEDGE_EXTRACT_SYSTEM = `\
You review a finished robotics session transcript and extract durable knowledge.
Return JSON only: {"experiences": [...], "anchors": [...]}. Both default to [] —
most sessions yield little or nothing. Rather record NOTHING than flood the store.

experiences — add one ONLY for a task or sub-task that reached a CLEAR, VERIFIED
outcome: a confirmed success, or a confirmed failure with an identified cause.
No speculation, no in-progress work, no "probably/likely". Omit if unverified.
Each: {"domain","title","problem","solution","success":true|false,"outcome_summary",
"abstract_principle","confidence_tier":"observed|reproduced|derived|reported|hypothesis"}

anchors — add one ONLY for a concrete physical/device fact ESTABLISHED in this
session by an actual measurement or experiment, OR explicitly asserted by the user
as fact. Not general knowledge, not guesses, not algorithm notes, not obvious physics.
Each: {"domain","scope":"global|robot|code","title","fact","implication",
"confidence_tier":"observed|reproduced|derived|reported|hypothesis","tags":[]}

Valid domains: motion_planning, perception, manipulation, locomotion, navigation,
simulation, hardware_interface, deployment, calibration, general.
Max ${MAX_EXPERIENCES} experiences, max ${MAX_ANCHORS} anchors. JSON only, no markdown, no prose.`

export interface KnowledgeExtraction {
  experiences: Array<Record<string, unknown>>
  anchors: Array<Record<string, unknown>>
}

/** Parse the merged extraction JSON. Tolerant of code fences; defaults to empty. */
export function parseKnowledgeExtraction(raw: string | null): KnowledgeExtraction {
  if (!raw?.trim()) return { experiences: [], anchors: [] }
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return { experiences: [], anchors: [] }
    const parsed = JSON.parse(match[0]) as unknown
    if (!parsed || typeof parsed !== 'object') return { experiences: [], anchors: [] }
    const obj = parsed as Record<string, unknown>
    return {
      experiences: onlyObjects(obj['experiences']),
      anchors: onlyObjects(obj['anchors']),
    }
  } catch {
    return { experiences: [], anchors: [] }
  }
}

function onlyObjects(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is Record<string, unknown> =>
    Boolean(v) && typeof v === 'object' && !Array.isArray(v))
}

/** Condense assistant turns into a capped transcript for the extractor. */
export function condenseTranscript(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): string {
  return messages
    .filter(m => m.role === 'assistant')
    .slice(-TURN_LIMIT)
    .map(m => {
      const text = typeof m.content === 'string'
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>)
            .filter(b => b.type === 'text')
            .map(b => b.text ?? '')
            .join(' ')
      return text.slice(0, 400)
    })
    .join('\n---\n')
}

export interface ExtractDeps {
  messages: ReadonlyArray<{ role: string; content: unknown }>
  flash?: FlashClient | null
  experiencePending: ExperiencePendingStore
  anchorPending: PhysicalAnchorPendingStore
}

/**
 * Run the merged strict extraction and queue candidates. Returns how many of
 * each were queued. Silently no-ops when flash is unavailable or the session is
 * too short to be meaningful.
 */
export async function extractKnowledgePostSession(deps: ExtractDeps): Promise<{ experiences: number; anchors: number }> {
  const zero = { experiences: 0, anchors: 0 }
  if (!deps.flash) return zero
  if (deps.messages.length < MIN_MESSAGES) return zero

  const transcript = condenseTranscript(deps.messages)
  if (!transcript.trim()) return zero

  let raw: string | null
  try {
    raw = await deps.flash.query({
      system: KNOWLEDGE_EXTRACT_SYSTEM,
      user: `Session transcript (recent assistant turns):\n\n${transcript}\n\n` +
        'Extract durable experiences and physical anchors per the rules. Return {} fields empty if nothing qualifies.',
      maxTokens: 1_200,
      timeoutMs: 30_000,
    })
  } catch {
    return zero
  }

  const { experiences, anchors } = parseKnowledgeExtraction(raw)
  let expN = 0
  let anchorN = 0
  for (const e of experiences.slice(0, MAX_EXPERIENCES)) {
    try { deps.experiencePending.add(e); expN++ } catch { /* queue full — skip */ }
  }
  for (const a of anchors.slice(0, MAX_ANCHORS)) {
    try { deps.anchorPending.add(a); anchorN++ } catch { /* queue full — skip */ }
  }
  await Promise.allSettled([
    deps.experiencePending.flush().catch(() => undefined),
    deps.anchorPending.flush().catch(() => undefined),
  ])
  return { experiences: expN, anchors: anchorN }
}
