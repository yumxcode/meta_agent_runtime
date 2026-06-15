import type { FlashClient } from '../core/flash/FlashClient.js'
import type { ExperienceEntry } from './types.js'
import { experienceRetrievalScore, type ExperienceStore } from './ExperienceStore.js'
import type { PhysicalAnchorStore } from './PhysicalAnchorStore.js'
import type { PrinciplePendingStore } from './PrinciplePendingStore.js'
import type { PrincipleStore } from './PrincipleStore.js'

/**
 * Auto-promotion threshold against experienceRetrievalScore
 * (= CONFIDENCE_WEIGHT[tier] + min(observations,10)*8 − contradictions*40).
 *
 * At 450 the auto path admits:
 *   - reproduced (500 base)            → always
 *   - observed (400 base) with obs ≥ 7 → 400 + 7*8 = 456 ≥ 450
 * and still excludes derived (≤430), reported (≤280), hypothesis (≤180), which
 * can only become principles via an explicit user request. The earlier value of
 * 500 made the observation-count term dead weight (observed peaked at 480 < 500,
 * so ONLY reproduced could ever auto-promote regardless of corroboration).
 */
export const PRINCIPLE_PROMOTION_SCORE_THRESHOLD = 450

export type PrinciplePromotionReason = 'confidence_threshold' | 'explicit_user_request'

export interface PrinciplePromotionResult {
  promoted: boolean
  pendingId?: string
  reason:
    | 'below_threshold'
    | 'missing_experience'
    | 'missing_flash'
    | 'flash_failed'
    | 'already_promoted'
    | 'already_pending'
    | 'queued'
  score?: number
}

export function shouldTriggerPrinciplePromotion(
  experience: ExperienceEntry,
  threshold = PRINCIPLE_PROMOTION_SCORE_THRESHOLD,
): boolean {
  if (!experience.abstractPrinciple?.trim()) return false
  if ((experience.contradictionCount ?? 0) > 0) return false
  return experienceRetrievalScore(experience) >= threshold
}

export async function proposePrincipleFromExperience(opts: {
  experienceId: string
  experienceStore: ExperienceStore
  anchorStore: PhysicalAnchorStore
  pendingStore: PrinciplePendingStore
  /** Committed principle store — enables dedup against already-promoted principles. */
  principleStore?: PrincipleStore | null
  flash?: FlashClient | null
  reason: PrinciplePromotionReason
  threshold?: number
}): Promise<PrinciplePromotionResult> {
  const experience = await opts.experienceStore.load(opts.experienceId)
  if (!experience) return { promoted: false, reason: 'missing_experience' }

  const score = experienceRetrievalScore(experience)
  if (opts.reason === 'confidence_threshold' && !shouldTriggerPrinciplePromotion(experience, opts.threshold)) {
    return { promoted: false, reason: 'below_threshold', score }
  }

  // Dedup: never queue a second principle for an experience that already has a
  // committed or pending one. Without this the confidence_threshold path re-fires
  // a fresh candidate every time the experience is re-reviewed, proliferating
  // near-duplicate principles.
  if (opts.principleStore) {
    const committed = await opts.principleStore.search({ experienceId: opts.experienceId, limit: 1 })
    if (committed.length > 0) return { promoted: false, reason: 'already_promoted', score }
  }
  if (opts.pendingStore.hasPendingForExperience(opts.experienceId)) {
    return { promoted: false, reason: 'already_pending', score }
  }

  if (!opts.flash) return { promoted: false, reason: 'missing_flash', score }

  const related = await opts.experienceStore.search({
    domain: experience.domain,
    robot: experience.robot,
    limit: 8,
  })
  const anchors = await opts.anchorStore.search({
    domain: experience.domain,
    robot: experience.robot,
    limit: 8,
  })

  const raw = await opts.flash.query({
    system: PRINCIPLE_PROMOTION_SYSTEM,
    user: formatPromotionInput(experience, related, anchors, opts.reason),
    maxTokens: 1_000,
    timeoutMs: 30_000,
    cacheKey: `principle-promotion:${opts.reason}:${experience.id}:${score}`,
  })
  if (!raw) return { promoted: false, reason: 'flash_failed', score }

  const proposal = parsePrincipleProposal(raw)
  if (!proposal) return { promoted: false, reason: 'flash_failed', score }

  const pendingId = opts.pendingStore.add({
    ...proposal,
    promotion_reason: opts.reason,
    source_experience_id: experience.id,
    derived_from_experience_ids: ensureIncludes(
      proposal['derived_from_experience_ids'] as string[] | undefined,
      experience.id,
    ),
    confidence_tier: proposal['confidence_tier'] ?? experience.confidenceTier ?? 'observed',
    observation_count: proposal['observation_count'] ?? experience.observationCount ?? 1,
    contradiction_count: proposal['contradiction_count'] ?? experience.contradictionCount ?? 0,
    last_verified_at: proposal['last_verified_at'] ?? experience.lastVerifiedAt,
  })

  return { promoted: true, pendingId, reason: 'queued', score }
}

const PRINCIPLE_PROMOTION_SYSTEM = `\
You promote robotics experiences into a reusable Principle candidate.

Return JSON only. The candidate will go to human review before it is committed.

Principle means: a transferable causal or constraint structure, not a one-off fact and not an action recipe.
It must explicitly state boundaries so future agents know when it applies and when it does not.

Schema:
{
  "title": "short name",
  "statement": "transferable principle",
  "mechanism": "why it holds",
  "first_principles_support": ["physics/math/control/signal/statistical reason"],
  "domains": ["one or more valid robotics domains"],
  "abstraction_level": "physical|system|algorithmic|statistical|operational",
  "preconditions": ["conditions required for the principle to apply"],
  "applicability_bounds": ["numeric, structural, or context bounds"],
  "non_applicable_when": ["clear exclusions"],
  "derived_from_experience_ids": ["experience ids"],
  "anchored_by_physical_anchor_ids": ["physical anchor ids"],
  "evidence_refs": ["logs, commits, reports, papers, datasheets"],
  "invalidated_assumptions": ["assumptions this principle corrects"],
  "counter_examples": ["known counterexamples or contradiction notes"],
  "confidence_tier": "observed|reproduced|derived|reported|hypothesis",
  "observation_count": 1,
  "contradiction_count": 0
}

Rules:
- Use physical anchors when they genuinely constrain the principle; otherwise leave the anchor list empty.
- Use first_principles_support for foundational reasons, not citations.
- Bound the principle narrowly enough to avoid overgeneralization.
- Do not invent measurements; use only provided evidence.`

function formatExperienceBlock(e: ExperienceEntry): string {
  return [
    `ID: ${e.id}`,
    `Domain: ${e.domain}`,
    e.robot ? `Robot: ${e.robot}` : '',
    `Outcome: ${e.outcome.success ? 'success' : 'failure'}`,
    `Confidence: ${e.confidenceTier ?? 'observed'} obs=${e.observationCount ?? 1} contradictions=${e.contradictionCount ?? 0}`,
    `Principle hint: ${e.abstractPrinciple ?? e.outcome.summary}`,
    `Problem: ${e.problem}`,
    `Solution: ${e.solution}`,
    e.outcome.failureReason ? `Failure reason: ${e.outcome.failureReason}` : '',
    e.invalidatedAssumptions?.length ? `Invalidated assumptions: ${e.invalidatedAssumptions.join('; ')}` : '',
    e.evidenceRefs?.length ? `Evidence refs: ${e.evidenceRefs.join('; ')}` : '',
  ].filter(Boolean).join('\n')
}

function formatPromotionInput(
  target: ExperienceEntry,
  related: ExperienceEntry[],
  anchors: Awaited<ReturnType<PhysicalAnchorStore['search']>>,
  reason: PrinciplePromotionReason,
): string {
  // The TARGET experience is what we are promoting — render it as its own block,
  // never folded into (or replaced by) the related set. The related search can
  // exceed its limit or use different filters, so relying on it to surface the
  // target is unsafe.
  const targetBlock = formatExperienceBlock(target)
  const relatedBlock = related
    .filter(e => e.id !== target.id)
    .map(formatExperienceBlock)
    .join('\n\n')

  const anchorBlock = anchors.map(a => [
    `ID: ${a.id}`,
    `Domain: ${a.domain}`,
    `Scope: ${a.scope}`,
    a.robot ? `Robot: ${a.robot}` : '',
    `Confidence: ${a.confidenceTier}`,
    `Fact: ${a.fact}`,
    a.mechanism ? `Mechanism: ${a.mechanism}` : '',
    `Implication: ${a.implication}`,
    a.evidenceRefs.length ? `Evidence refs: ${a.evidenceRefs.join('; ')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')

  return [
    `Promotion trigger: ${reason}`,
    '',
    'Target experience (the one being promoted):',
    targetBlock,
    '',
    'Related experiences (same domain/robot — context only):',
    relatedBlock || '(none)',
    '',
    'Candidate physical anchors:',
    anchorBlock || '(none)',
  ].join('\n')
}

function parsePrincipleProposal(raw: string): Record<string, unknown> | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const parsed = JSON.parse(jsonMatch[0]) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function ensureIncludes(values: string[] | undefined, required: string): string[] {
  const out = Array.isArray(values) ? values.filter(v => typeof v === 'string') : []
  if (!out.includes(required)) out.unshift(required)
  return out
}
