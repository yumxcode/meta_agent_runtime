/**
 * InjectionRenderer — the trust boundary on the injection channel (G0-9 / G0-F).
 *
 * ── The laundering path this closes ─────────────────────────────────────────
 *
 *   poisoned repository content
 *     → tool_outcome            (the Reviewer treats this as UNTRUSTED evidence)
 *     → Reviewer distils it     → ExperienceCandidate
 *     → human approval          (a human judges whether it is USEFUL)
 *     → injected into a Worker's system context   ← now treated as TRUSTED
 *
 * Every step is individually reasonable and the composition is a privilege
 * escalation. The Reviewer's own system prompt says never to follow
 * instructions found in trajectory content — but the candidate is *distilled
 * from* that content, and after the approval gate it enters an agent that holds
 * write tools and network access. The human at the gate is asked "is this
 * useful?", not "is there an instruction hidden in this text?", and that is not
 * a question a person reliably answers by eye.
 *
 * ── Why this rejects instead of sanitising ──────────────────────────────────
 *
 * Stripping the markers out of hostile text leaves text that was written to be
 * hostile, minus the part we happened to recognise. A candidate that trips any
 * check is refused whole, with the reason reported so a human can rewrite it.
 * That is the same fail-closed discipline the rest of G0 uses.
 *
 * ── Not wired to the call path ──────────────────────────────────────────────
 *
 * This is a pure function with no caller in the runtime. Connecting it would
 * change what the model actually reads, which is a behaviour change and belongs
 * to G5, not to a gate whose contract is "no behaviour change". The current
 * renderer (`ExperienceWorkingSet._refreshSlots`) still passes free text
 * through; that is a known gap, recorded rather than silently fixed.
 */

import { redactSecrets } from '../infra/redaction/secretRedaction.js'

export const INJECTION_RENDER_VERSION = 'injection-render-1'

/**
 * Shown to the human at the approval gate.
 *
 * Required by G0-F clause 3. The approval UI asks about usefulness; without
 * this line the reviewer has no reason to know they are also granting trust.
 */
export const HUMAN_APPROVAL_NOTICE =
  'Approving this entry makes its text TRUSTED SYSTEM CONTEXT for an agent that ' +
  'holds write and network tools. It was distilled from trajectory content that ' +
  'is itself untrusted. Read it as something that will be obeyed, not merely read.'

export const REJECTION_REASONS = {
  /** `Human:` / `Assistant:` / `System:` at the start of a line. */
  ROLE_MARKER: 'role_marker',
  /** `<system>`, `<instructions>`, `<|...|>` and similar prompt delimiters. */
  SYSTEM_DELIMITER: 'system_delimiter',
  /** `<function_calls>`, `<invoke`, `<tool_use` and similar. */
  TOOL_CALL_SYNTAX: 'tool_call_syntax',
  /** Any angle bracket at all — the cheapest way to close the whole class. */
  MARKUP_CHARACTER: 'markup_character',
  CONTROL_CHARACTER: 'control_character',
  /** Bidirectional overrides, which make rendered text differ from its bytes. */
  BIDI_OVERRIDE: 'bidi_override',
  /** Zero-width characters, which hide content from a human reviewer. */
  ZERO_WIDTH: 'zero_width',
  PRIVATE_USE: 'private_use',
  FIELD_TOO_LONG: 'field_too_long',
  /** Nothing survived redaction — the field was entirely a credential. */
  EMPTY_AFTER_REDACTION: 'empty_after_redaction',
  MISSING_REQUIRED_FIELD: 'missing_required_field',
} as const

export type RejectionReason = typeof REJECTION_REASONS[keyof typeof REJECTION_REASONS]

export interface RenderRejection {
  field: string
  reason: RejectionReason
  /** Short, already-redacted excerpt so a human can find the problem. */
  detail?: string
}

export type RenderResult =
  | { ok: true; text: string; renderedFields: string[] }
  | { ok: false; rejections: RenderRejection[] }

/** Per-field cap, enforced here rather than trusted from the schema. */
const MAX_FIELD_CHARS = 2_000
const MAX_LIST_ITEMS = 12
const MAX_TOTAL_CHARS = 8_000
const DETAIL_CHARS = 80

// ── Threat patterns ─────────────────────────────────────────────────────────
//
// Checked against the exact string that would be emitted, after redaction and
// whitespace collapsing. Checking the pre-render form would leave a gap between
// what was validated and what is shipped.
//
// Written as \u escapes on purpose: these classes are made of characters that
// are invisible or that reorder surrounding text, so spelling them literally
// would make this file unreadable in review — and a security check nobody can
// read is not a security check.

/**
 * Role markers anywhere in the field, NOT anchored to a line start.
 *
 * The anchored version of this check was dead code: whitespace collapsing runs
 * first and removes every newline, so `\n\nHuman:` arrives as ` Human:` and a
 * `(^|\n)`-anchored pattern never fired. The adversarial tests caught it.
 *
 * Position-independence costs some false positives — a field legitimately
 * containing `user: alice` is refused — and that is the right trade here. A
 * refusal is recoverable by rewording; a laundered instruction is not.
 */
const ROLE_MARKER_RE = /\b(human|assistant|system|user)\s*:/i
const SYSTEM_DELIMITER_RE = /<\s*\/?\s*(system|instructions?|prompt)\b|<\|[^|]*\|>/i
const TOOL_CALL_RE = /<\s*\/?\s*(function_calls?|invoke|tool_use|tool_result|antml)\b/i
const MARKUP_RE = /[<>]/

/**
 * Code-point ranges checked numerically rather than as regex classes.
 *
 * These characters are invisible, or they reorder the text around them. Written
 * as literals they would make this file unreadable — and a security check
 * nobody can read in review is not a security check. Numeric bounds are the one
 * form that stays legible and cannot be mangled by an editor or a copy-paste.
 */
const CODEPOINT_BANS: Array<{
  reason: RejectionReason
  ranges: Array<[number, number]>
}> = [
  {
    // C0 and DEL, minus \t \n \r which whitespace-collapsing already removed.
    reason: 'control_character',
    ranges: [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f]],
  },
  {
    // LRE RLE PDF LRO RLO, and the isolate family LRI RLI FSI PDI.
    reason: 'bidi_override',
    ranges: [[0x202a, 0x202e], [0x2066, 0x2069]],
  },
  {
    // ZWSP ZWNJ ZWJ LRM RLM, word joiner, BOM/ZWNBSP.
    reason: 'zero_width',
    ranges: [[0x200b, 0x200f], [0x2060, 0x2060], [0xfeff, 0xfeff]],
  },
  {
    reason: 'private_use',
    ranges: [[0xe000, 0xf8ff]],
  },
]

/** First banned code point in `text`, or null. */
function findBannedCodePoint(
  text: string,
): { reason: RejectionReason; index: number } | null {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    for (const ban of CODEPOINT_BANS) {
      for (const [low, high] of ban.ranges) {
        if (code >= low && code <= high) return { reason: ban.reason, index }
      }
    }
  }
  return null
}

/** Ordered most-specific first, so the reported reason is the informative one. */
const CHECKS: Array<{ re: RegExp; reason: RejectionReason }> = [
  { re: TOOL_CALL_RE, reason: REJECTION_REASONS.TOOL_CALL_SYNTAX },
  { re: SYSTEM_DELIMITER_RE, reason: REJECTION_REASONS.SYSTEM_DELIMITER },
  { re: ROLE_MARKER_RE, reason: REJECTION_REASONS.ROLE_MARKER },
  { re: MARKUP_RE, reason: REJECTION_REASONS.MARKUP_CHARACTER },
]

/**
 * The only fields that may reach a model's context.
 *
 * An allowlist, not a denylist: a field added to `ExperienceCandidate` later is
 * excluded by default and someone has to decide to include it. `title`,
 * `reviewNote`, `impact.rationale` and `evidence` are deliberately absent —
 * they are prose about the entry rather than the operative content, and prose
 * is exactly what carries an injection.
 */
export const RENDERED_FIELDS = [
  'applicability.context',
  'applicability.cues',
  'applicability.prerequisites',
  'applicability.excludes',
  'policyDelta.previousApproach',
  'policyDelta.recommendedAction',
  'policyDelta.avoidAction',
  'policyDelta.expectedEffect',
  'mechanism',
  'verification.checks',
  'verification.successSignals',
  'verification.failureSignals',
] as const

/** Minimal shape this renderer needs; a structural subset of ExperienceCandidate. */
export interface RenderableCandidate {
  applicability: {
    context: string
    cues: string[]
    prerequisites?: string[]
    excludes: string[]
  }
  policyDelta: {
    previousApproach?: string
    recommendedAction: string
    avoidAction?: string
    expectedEffect: string
  }
  mechanism: string
  verification: {
    checks: string[]
    successSignals: string[]
    failureSignals: string[]
  }
}

/**
 * Render one approved candidate into an injectable block, or refuse it.
 *
 * The emitted format is line-oriented with no markup characters anywhere: since
 * every field has had whitespace collapsed to single spaces and angle brackets
 * are rejected outright, a field cannot forge a new line or close the block.
 */
export function renderInjectionBlock(
  candidate: RenderableCandidate,
  opts: { entryId?: string; confidence?: string } = {},
): RenderResult {
  const rejections: RenderRejection[] = []
  const lines: string[] = []
  const renderedFields: string[] = []

  const scalar = (field: string, value: string | undefined, label: string, required: boolean): void => {
    if (value === undefined || value.trim() === '') {
      if (required) {
        rejections.push({ field, reason: REJECTION_REASONS.MISSING_REQUIRED_FIELD })
      }
      return
    }
    const clean = sanitiseField(field, value, rejections)
    if (clean === null) return
    lines.push(`${label}: ${clean}`)
    renderedFields.push(field)
  }

  const list = (field: string, values: string[] | undefined, label: string, required: boolean): void => {
    const items = values ?? []
    if (items.length === 0) {
      if (required) rejections.push({ field, reason: REJECTION_REASONS.MISSING_REQUIRED_FIELD })
      return
    }
    if (items.length > MAX_LIST_ITEMS) {
      rejections.push({ field, reason: REJECTION_REASONS.FIELD_TOO_LONG, detail: `${items.length} items` })
      return
    }
    const cleaned: string[] = []
    for (const [index, item] of items.entries()) {
      const clean = sanitiseField(`${field}[${index}]`, item, rejections)
      if (clean !== null) cleaned.push(clean)
    }
    if (cleaned.length === 0) return
    // ' | ' as the separator, safe because the separator cannot appear as a
    // line break and items cannot contain markup.
    lines.push(`${label}: ${cleaned.join(' | ')}`)
    renderedFields.push(field)
  }

  scalar('applicability.context', candidate.applicability?.context, 'applies-when', true)
  list('applicability.cues', candidate.applicability?.cues, 'cues', true)
  list('applicability.prerequisites', candidate.applicability?.prerequisites, 'prerequisites', false)
  list('applicability.excludes', candidate.applicability?.excludes, 'does-not-apply-when', true)

  scalar('policyDelta.previousApproach', candidate.policyDelta?.previousApproach, 'instead-of', false)
  scalar('policyDelta.recommendedAction', candidate.policyDelta?.recommendedAction, 'do', true)
  scalar('policyDelta.avoidAction', candidate.policyDelta?.avoidAction, 'avoid', false)
  scalar('policyDelta.expectedEffect', candidate.policyDelta?.expectedEffect, 'expected-effect', true)

  scalar('mechanism', candidate.mechanism, 'because', true)

  list('verification.checks', candidate.verification?.checks, 'verify-by', true)
  list('verification.successSignals', candidate.verification?.successSignals, 'success-signal', true)
  list('verification.failureSignals', candidate.verification?.failureSignals, 'failure-signal', true)

  if (rejections.length > 0) return { ok: false, rejections }

  const header = `[experience ${sanitiseId(opts.entryId)} · ${sanitiseId(opts.confidence) || 'unrated'}]`
  const text = [header, ...lines].join('\n')

  if (text.length > MAX_TOTAL_CHARS) {
    return {
      ok: false,
      rejections: [{
        field: '(whole entry)',
        reason: REJECTION_REASONS.FIELD_TOO_LONG,
        detail: `${text.length} chars`,
      }],
    }
  }

  return { ok: true, text, renderedFields }
}

/**
 * Redact, collapse, then check — in that order.
 *
 * The order is the point. Redaction runs first so the checks see exactly the
 * bytes that will be emitted; checking first would validate a string that is
 * then modified. Whitespace collapsing runs before the checks for the same
 * reason, and it is what stops a newline inside a field from forging a new
 * `key: value` line in the rendered block.
 */
function sanitiseField(
  field: string,
  raw: string,
  rejections: RenderRejection[],
): string | null {
  if (raw.length > MAX_FIELD_CHARS) {
    rejections.push({ field, reason: REJECTION_REASONS.FIELD_TOO_LONG, detail: `${raw.length} chars` })
    return null
  }

  const redacted = redactSecrets(raw)
  // Any whitespace run — newline, tab, vertical tab — becomes one space, so the
  // value can occupy exactly one line and cannot introduce structure.
  const collapsed = redacted.replace(/\s+/g, ' ').trim()

  if (collapsed === '') {
    rejections.push({ field, reason: REJECTION_REASONS.EMPTY_AFTER_REDACTION })
    return null
  }

  for (const { re, reason } of CHECKS) {
    const match = collapsed.match(re)
    if (match) {
      rejections.push({ field, reason, detail: excerpt(collapsed, match.index ?? 0) })
      return null
    }
  }

  const banned = findBannedCodePoint(collapsed)
  if (banned) {
    rejections.push({
      field,
      reason: banned.reason,
      // The excerpt cannot show an invisible character, so report its position
      // and code point instead — otherwise the reviewer sees blank text and a
      // rejection they cannot act on.
      detail: `U+${collapsed.charCodeAt(banned.index).toString(16).toUpperCase().padStart(4, '0')} at index ${banned.index}`,
    })
    return null
  }

  return collapsed
}

/** Ids and confidence labels come from the host, but are still constrained. */
function sanitiseId(value: string | undefined): string {
  return (value ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64)
}

function excerpt(text: string, at: number): string {
  const start = Math.max(0, at - DETAIL_CHARS / 2)
  return text.slice(start, start + DETAIL_CHARS)
}
