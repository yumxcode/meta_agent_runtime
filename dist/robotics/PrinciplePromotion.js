import { experienceRetrievalScore } from './ExperienceStore.js';
export const PRINCIPLE_PROMOTION_SCORE_THRESHOLD = 500;
export function shouldTriggerPrinciplePromotion(experience, threshold = PRINCIPLE_PROMOTION_SCORE_THRESHOLD) {
    if (!experience.abstractPrinciple?.trim())
        return false;
    if ((experience.contradictionCount ?? 0) > 0)
        return false;
    return experienceRetrievalScore(experience) >= threshold;
}
export async function proposePrincipleFromExperience(opts) {
    const experience = await opts.experienceStore.load(opts.experienceId);
    if (!experience)
        return { promoted: false, reason: 'missing_experience' };
    const score = experienceRetrievalScore(experience);
    if (opts.reason === 'confidence_threshold' && !shouldTriggerPrinciplePromotion(experience, opts.threshold)) {
        return { promoted: false, reason: 'below_threshold', score };
    }
    if (!opts.flash)
        return { promoted: false, reason: 'missing_flash', score };
    const related = await opts.experienceStore.search({
        domain: experience.domain,
        robot: experience.robot,
        limit: 8,
    });
    const anchors = await opts.anchorStore.search({
        domain: experience.domain,
        robot: experience.robot,
        limit: 8,
    });
    const raw = await opts.flash.query({
        system: PRINCIPLE_PROMOTION_SYSTEM,
        user: formatPromotionInput(experience, related, anchors, opts.reason),
        maxTokens: 1_000,
        timeoutMs: 8_000,
        cacheKey: `principle-promotion:${opts.reason}:${experience.id}:${score}`,
    });
    if (!raw)
        return { promoted: false, reason: 'flash_failed', score };
    const proposal = parsePrincipleProposal(raw);
    if (!proposal)
        return { promoted: false, reason: 'flash_failed', score };
    const pendingId = opts.pendingStore.add({
        ...proposal,
        promotion_reason: opts.reason,
        source_experience_id: experience.id,
        derived_from_experience_ids: ensureIncludes(proposal['derived_from_experience_ids'], experience.id),
        confidence_tier: proposal['confidence_tier'] ?? experience.confidenceTier ?? 'observed',
        observation_count: proposal['observation_count'] ?? experience.observationCount ?? 1,
        contradiction_count: proposal['contradiction_count'] ?? experience.contradictionCount ?? 0,
        last_verified_at: proposal['last_verified_at'] ?? experience.lastVerifiedAt,
    });
    return { promoted: true, pendingId, reason: 'queued', score };
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
- Do not invent measurements; use only provided evidence.`;
function formatPromotionInput(target, related, anchors, reason) {
    const relatedBlock = related.map(e => [
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
    ].filter(Boolean).join('\n')).join('\n\n');
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
    ].filter(Boolean).join('\n')).join('\n\n');
    return [
        `Promotion trigger: ${reason}`,
        '',
        'Target experience:',
        relatedBlock || `ID: ${target.id}\nPrinciple hint: ${target.abstractPrinciple ?? target.outcome.summary}`,
        '',
        'Candidate physical anchors:',
        anchorBlock || '(none)',
    ].join('\n');
}
function parsePrincipleProposal(raw) {
    try {
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch)
            return null;
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
    }
    catch {
        return null;
    }
}
function ensureIncludes(values, required) {
    const out = Array.isArray(values) ? values.filter(v => typeof v === 'string') : [];
    if (!out.includes(required))
        out.unshift(required);
    return out;
}
//# sourceMappingURL=PrinciplePromotion.js.map