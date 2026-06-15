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

/**
 * Convergence threshold: the minimum number of distinct experiences that must
 * share one mechanism before a cluster may be promoted to a principle. A single
 * experience is only ever an observation point, never a principle.
 */
export const N_CONVERGENCE = 3

export type PrinciplePromotionReason = 'confidence_threshold' | 'explicit_user_request'

export interface PrinciplePromotionResult {
  promoted: boolean
  pendingId?: string
  reason:
    | 'below_threshold'
    | 'below_convergence'
    | 'missing_experience'
    | 'missing_flash'
    | 'flash_failed'
    | 'rejected_by_judge'
    | 'already_promoted'
    | 'already_pending'
    | 'queued'
  /** One-sentence reason the abstraction judge declined, when reason === 'rejected_by_judge'. */
  judgeReason?: string
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

  const judged = parsePrincipleJudgement(raw)
  if (judged.kind === 'invalid') return { promoted: false, reason: 'flash_failed', score }
  if (judged.kind === 'reject') {
    return { promoted: false, reason: 'rejected_by_judge', judgeReason: judged.reason, score }
  }
  const proposal = judged.proposal

  const derivedIds = filterRejectedMembers(
    ensureIncludes(proposal['derived_from_experience_ids'] as string[] | undefined, experience.id),
    proposal['rejected_members'],
  )

  const pendingId = opts.pendingStore.add({
    ...proposal,
    promotion_reason: opts.reason,
    source_experience_id: experience.id,
    derived_from_experience_ids: derivedIds,
    confidence_tier: proposal['confidence_tier'] ?? experience.confidenceTier ?? 'observed',
    observation_count: proposal['observation_count'] ?? experience.observationCount ?? 1,
    contradiction_count: proposal['contradiction_count'] ?? experience.contradictionCount ?? 0,
    last_verified_at: proposal['last_verified_at'] ?? experience.lastVerifiedAt,
  })

  return { promoted: true, pendingId, reason: 'queued', score }
}

/**
 * Promote a CONVERGENT CLUSTER of experiences into one principle candidate.
 *
 * Unlike the single-experience path, the trigger here is mechanism convergence
 * across ≥ N distinct experiences. The Flash judge may still REJECT the whole
 * cluster (default-reject prompt), or trim non-fitting members via
 * `rejected_members`; if the retained set falls below `minRetained` the cluster
 * is rejected as below_convergence rather than forced through.
 */
export async function proposePrincipleFromCluster(opts: {
  cluster: ExperienceEntry[]
  /** The experience whose commit triggered this evaluation (becomes source_experience_id). */
  trigger: ExperienceEntry
  anchorStore: PhysicalAnchorStore
  pendingStore: PrinciplePendingStore
  flash?: FlashClient | null
  /** Confidence tier computed from source diversity (see diversityTier). */
  tier: ExperienceEntry['confidenceTier']
  minRetained?: number
}): Promise<PrinciplePromotionResult> {
  const minRetained = opts.minRetained ?? N_CONVERGENCE
  if (opts.cluster.length < minRetained) return { promoted: false, reason: 'below_convergence' }
  if (!opts.flash) return { promoted: false, reason: 'missing_flash' }

  const domain = opts.trigger.domain
  const anchors = await opts.anchorStore.search({ domain, robot: opts.trigger.robot, limit: 8 })

  const clusterIds = opts.cluster.map(e => e.id).join(',')
  const raw = await opts.flash.query({
    system: PRINCIPLE_PROMOTION_SYSTEM,
    user: formatClusterPromotionInput(opts.cluster, anchors),
    maxTokens: 1_000,
    timeoutMs: 30_000,
    cacheKey: `principle-cluster:${domain}:${clusterIds}`,
  })
  if (!raw) return { promoted: false, reason: 'flash_failed' }

  const judged = parsePrincipleJudgement(raw)
  if (judged.kind === 'invalid') return { promoted: false, reason: 'flash_failed' }
  if (judged.kind === 'reject') {
    return { promoted: false, reason: 'rejected_by_judge', judgeReason: judged.reason }
  }
  const proposal = judged.proposal

  // Trim members the judge flagged as not fitting the mechanism, then ensure the
  // retained set is still convergent. Default to the full cluster when the model
  // omits derived_from_experience_ids.
  const proposed = proposal['derived_from_experience_ids'] as string[] | undefined
  const clusterIdSet = new Set(opts.cluster.map(e => e.id))
  const base = Array.isArray(proposed) && proposed.some(id => clusterIdSet.has(id))
    ? proposed.filter(id => clusterIdSet.has(id))
    : opts.cluster.map(e => e.id)
  const retained = filterRejectedMembers(base, proposal['rejected_members'])
  if (retained.length < minRetained) return { promoted: false, reason: 'below_convergence' }

  // Ground the principle: union the Flash-proposed anchors with anchors the
  // retained cluster experiences already validated, so a newborn principle is
  // anchored on the physical facts its evidence rests on (§2.4 晋升时接锚点).
  const retainedSet = new Set(retained)
  const sharedAnchorIds = new Set<string>()
  for (const e of opts.cluster) {
    if (!retainedSet.has(e.id)) continue
    for (const aid of e.anchorIds ?? []) sharedAnchorIds.add(aid)
  }
  const proposedAnchors = Array.isArray(proposal['anchored_by_physical_anchor_ids'])
    ? (proposal['anchored_by_physical_anchor_ids'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  const anchoredBy = [...new Set([...proposedAnchors, ...sharedAnchorIds])]

  const pendingId = opts.pendingStore.add({
    ...proposal,
    promotion_reason: 'confidence_threshold',
    source_experience_id: opts.trigger.id,
    derived_from_experience_ids: retained,
    anchored_by_physical_anchor_ids: anchoredBy,
    confidence_tier: opts.tier ?? proposal['confidence_tier'] ?? 'observed',
    observation_count: proposal['observation_count'] ?? retained.length,
    contradiction_count: 0,
    last_verified_at: proposal['last_verified_at'] ?? opts.trigger.lastVerifiedAt,
  })

  return { promoted: true, pendingId, reason: 'queued' }
}

const PRINCIPLE_PROMOTION_SYSTEM = `\
You evaluate whether a CLUSTER of robotics experiences justifies ONE reusable principle.

Default to REJECT. Most clusters do not deserve a principle. Do not abstract for the sake
of abstracting — a false principle pollutes the knowledge base and misleads future agents.
Return JSON only. The candidate, if any, goes to human review before it is committed.

A principle is a transferable causal or constraint structure — not a one-off fact, not an
action recipe, not a restatement of the observations.

REJECT — return {"promote": false, "reason": "<one sentence>"} — when ANY holds:
- The experiences are only superficially or coincidentally similar; no single shared
  causal or constraint mechanism actually links them.
- You cannot state a mechanism (WHY it holds) grounded in physics, math, control, signal,
  or statistics — restating the observation is NOT a mechanism.
- It is a one-off fact, an environment/version/tooling quirk, or a workaround, not
  transferable within the domain.
- It is an action recipe ("do X then Y") rather than a causal or constraint structure.
- It is too vague to bound — you cannot state real preconditions or non-applicable cases.
- It merely restates something trivially obvious or true by definition.
- The evidence is too thin or internally contradictory to trust.

PROMOTE — return the full schema with "promote": true — ONLY when ALL hold:
- A single transferable mechanism genuinely explains EVERY retained experience.
- You can articulate why it holds from first principles.
- You can state concrete boundaries: when it applies AND when it does not.
- It would actually change a future agent's decision in this domain.

Schema when promoting:
{
  "promote": true,
  "title": "short name",
  "statement": "transferable principle",
  "mechanism": "why it holds",
  "first_principles_support": ["physics/math/control/signal/statistical reason"],
  "domains": ["one or more valid robotics domains"],
  "abstraction_level": "physical|system|algorithmic|statistical|operational",
  "preconditions": ["conditions required for the principle to apply"],
  "applicability_bounds": ["numeric, structural, or context bounds"],
  "non_applicable_when": ["clear exclusions"],
  "derived_from_experience_ids": ["experience ids that fit the mechanism"],
  "rejected_members": ["cluster experience ids that do NOT fit — do not fold them in"],
  "anchored_by_physical_anchor_ids": ["physical anchor ids"],
  "evidence_refs": ["logs, commits, reports, papers, datasheets"],
  "invalidated_assumptions": ["assumptions this principle corrects"],
  "counter_examples": ["known counterexamples or contradiction notes"],
  "confidence_tier": "observed|reproduced|derived|reported|hypothesis",
  "observation_count": 1,
  "contradiction_count": 0
}

Rules:
- Prefer rejecting over forcing a weak principle.
- If only a subset of the cluster shares the mechanism, promote on that subset and list the
  rest in rejected_members.
- Use physical anchors only when they genuinely constrain the principle; otherwise leave empty.
- Use first_principles_support for foundational reasons, not citations.
- Bound narrowly; never overgeneralize beyond the evidence.
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

type PromotionJudgement =
  | { kind: 'invalid' }
  | { kind: 'reject'; reason: string }
  | { kind: 'promote'; proposal: Record<string, unknown> }

/**
 * Parse the Flash judge's response. The strict prompt may abstain via
 * `{"promote": false, "reason": ...}`; an explicit promote:false is the ONLY
 * abstain signal. A body with no `promote` field but a real proposal is treated
 * as a promotion (backward compatible) and validated downstream.
 */
function parsePrincipleJudgement(raw: string): PromotionJudgement {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { kind: 'invalid' }
    const parsed = JSON.parse(jsonMatch[0]) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'invalid' }
    const obj = parsed as Record<string, unknown>
    if (obj['promote'] === false) {
      const reason = typeof obj['reason'] === 'string' && obj['reason'].trim()
        ? obj['reason'].trim().slice(0, 300)
        : 'cluster does not justify a transferable principle'
      return { kind: 'reject', reason }
    }
    return { kind: 'promote', proposal: obj }
  } catch {
    return { kind: 'invalid' }
  }
}

function ensureIncludes(values: string[] | undefined, required: string): string[] {
  const out = Array.isArray(values) ? values.filter(v => typeof v === 'string') : []
  if (!out.includes(required)) out.unshift(required)
  return out
}

/** Drop any experience IDs the judge flagged as not fitting the mechanism. */
function filterRejectedMembers(ids: string[], rejected: unknown): string[] {
  if (!Array.isArray(rejected) || rejected.length === 0) return ids
  const drop = new Set(rejected.filter((v): v is string => typeof v === 'string'))
  const kept = ids.filter(id => !drop.has(id))
  // Never return empty if everything was dropped — fall back to the original set
  // so the caller's minRetained check decides, rather than silently zeroing out.
  return kept.length > 0 ? kept : ids
}

function formatClusterPromotionInput(
  cluster: ExperienceEntry[],
  anchors: Awaited<ReturnType<PhysicalAnchorStore['search']>>,
): string {
  const clusterBlock = cluster.map(formatExperienceBlock).join('\n\n')
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
    'Promotion trigger: mechanism convergence across a cluster of experiences',
    '',
    'Candidate cluster (judge whether ONE mechanism explains these):',
    clusterBlock,
    '',
    'Candidate physical anchors:',
    anchorBlock || '(none)',
  ].join('\n')
}
