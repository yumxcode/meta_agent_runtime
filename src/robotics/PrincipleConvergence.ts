/**
 * PrincipleConvergence — recognition-before-generation pipeline run when an
 * experience is committed (inside /experience review).
 *
 * Order of operations (see docs/principle-mechanism-improvement.md §3.1):
 *   1. CLAIM     — does an existing committed principle cover this experience?
 *                  If so, link it (appendPrincipleReference) and fold the
 *                  experience's outcome back as an observation/contradiction.
 *                  No new principle is generated.
 *   2. CONVERGE  — otherwise, cluster the domain's unlinked experiences by
 *                  mechanism. If ≥ N distinct experiences converge (and none
 *                  carry an unresolved contradiction, and none are already
 *                  covered), propose ONE principle from the whole cluster.
 *   3. JUDGE     — the promotion step itself defaults to REJECT; a weak cluster
 *                  yields no principle rather than a forced abstraction.
 *
 * Source diversity affects the proposed confidence tier (observed vs reproduced),
 * NOT whether the principle may be born. It is a soft ranking signal.
 */

import type { FlashClient } from '../core/flash/FlashClient.js'
import type { ExperienceEntry, KnowledgeConfidenceTier } from './types.js'
import type { ExperienceStore } from './ExperienceStore.js'
import type { PhysicalAnchorStore } from './PhysicalAnchorStore.js'
import type { PrincipleStore } from './PrincipleStore.js'
import type { PrinciplePendingStore } from './PrinciplePendingStore.js'
import { N_CONVERGENCE, proposePrincipleFromCluster } from './PrinciplePromotion.js'

const CLAIM_CANDIDATE_LIMIT = 15
const CLUSTER_POOL_LIMIT = 30

export interface EvaluatePromotionDeps {
  experienceStore: ExperienceStore
  principleStore: PrincipleStore
  anchorStore: PhysicalAnchorStore
  pendingStore: PrinciplePendingStore
  flash?: FlashClient | null
  /** Convergence threshold (distinct experiences). Defaults to N_CONVERGENCE. */
  n?: number
}

export interface AnchorSignal {
  anchorId: string
  verdict: 'corroborated' | 'contradicted' | 'neutral'
  /** Principle IDs down-weighted by contradiction propagation (§7.2), if any. */
  propagated?: string[]
}

export type EvaluatePromotionResult =
  | { kind: 'reinforced'; principleIds: string[]; signal: 'observation' | 'contradiction'; anchorSignals?: AnchorSignal[] }
  | { kind: 'proposed'; pendingId: string; clusterIds: string[]; anchorSignals?: AnchorSignal[] }
  | { kind: 'rejected'; reason: string; anchorSignals?: AnchorSignal[] }
  | { kind: 'none'; reason: string; anchorSignals?: AnchorSignal[] }

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — claim (recognition)
// ─────────────────────────────────────────────────────────────────────────────

const PRINCIPLE_CLAIM_SYSTEM = `\
You decide which stored robotics principles a single experience actually applied or tested.

Match by MECHANISM applicability within the same domain — not surface or keyword similarity.
Be selective: include a principle ID only if the experience genuinely exercised or bore on it.
False positives create noise. When in doubt, exclude.

Return JSON only, no markdown:
{"applicable": ["principle_id", ...], "reasoning": "one concise sentence"}
If none apply: {"applicable": [], "reasoning": "none"}
Do NOT return IDs absent from the candidate list.`

/**
 * Judge which committed principles the experience applied/tested, and link them
 * onto the experience (appendPrincipleReference). Returns the linked IDs.
 * Returns [] when there is no flash judge — never guesses applicability.
 */
export async function claimPrinciplesForExperience(
  exp: ExperienceEntry,
  experienceStore: ExperienceStore,
  principleStore: PrincipleStore,
  flash?: FlashClient | null,
): Promise<string[]> {
  const candidates = await principleStore.search({ domain: exp.domain, limit: CLAIM_CANDIDATE_LIMIT })
  if (candidates.length === 0 || !flash) return []

  const raw = await flash.query({
    system: PRINCIPLE_CLAIM_SYSTEM,
    user: [
      'Experience:',
      formatExperienceForClaim(exp),
      '',
      'Candidate principles:',
      candidates.map(p =>
        `ID: ${p.id}\nTitle: ${p.title}\nStatement: ${p.statement}\nMechanism: ${p.mechanism}`,
      ).join('\n\n'),
    ].join('\n'),
    maxTokens: 200,
    timeoutMs: 8_000,
    cacheKey: `principle-claim:${exp.id}:${candidates.map(c => c.id).sort().join(',')}`,
  })
  if (!raw) return []

  const validIds = new Set(candidates.map(c => c.id))
  const applicable = parseIdList(raw, 'applicable').filter(id => validIds.has(id))
  for (const pid of applicable) {
    await experienceStore.appendPrincipleReference(exp.id, pid).catch(() => undefined)
  }
  return applicable
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — cluster (convergence)
// ─────────────────────────────────────────────────────────────────────────────

const MECHANISM_CLUSTER_SYSTEM = `\
You group robotics experiences that share ONE underlying transferable mechanism.

Given a TARGET experience and candidate experiences in the same domain, return the IDs of
candidates that express the SAME causal/constraint mechanism as the target — judged by
mechanism, not surface or keyword similarity. Prefer fewer, tighter clusters; never merge
distinct mechanisms just to make the group larger.

Return JSON only, no markdown:
{"cluster": ["experience_id", ...], "reasoning": "one concise sentence"}
The target is always part of its own cluster; do not list it. If nothing else fits:
{"cluster": [], "reasoning": "no convergence"}
Do NOT return IDs absent from the candidate list.`

/**
 * Cluster the domain's unlinked experiences by mechanism around `trigger`.
 * Returns the full cluster (including the trigger). Without a flash judge, the
 * trigger forms a singleton (no convergence).
 */
export async function flashClusterByMechanism(
  trigger: ExperienceEntry,
  pool: ExperienceEntry[],
  flash?: FlashClient | null,
): Promise<ExperienceEntry[]> {
  const others = pool.filter(e => e.id !== trigger.id)
  if (others.length === 0 || !flash) return [trigger]

  const raw = await flash.query({
    system: MECHANISM_CLUSTER_SYSTEM,
    user: [
      'Target experience:',
      formatExperienceForClaim(trigger),
      '',
      'Candidate experiences:',
      others.map(formatExperienceForClaim).join('\n\n'),
    ].join('\n'),
    maxTokens: 300,
    timeoutMs: 8_000,
    cacheKey: `principle-cluster-members:${trigger.id}:${others.map(e => e.id).sort().join(',')}`,
  })
  if (!raw) return [trigger]

  const poolById = new Map(others.map(e => [e.id, e]))
  const members = parseIdList(raw, 'cluster')
    .map(id => poolById.get(id))
    .filter((e): e is ExperienceEntry => Boolean(e))
  return [trigger, ...members]
}

// ─────────────────────────────────────────────────────────────────────────────
// Anchor claim + contradiction propagation (§3.2, §7.2)
// ─────────────────────────────────────────────────────────────────────────────

const ANCHOR_CLAIM_SYSTEM = `\
You decide whether a robotics experience validated or contradicted stored physical anchors
(device/physics facts). For each candidate anchor the experience genuinely bore on, output a
verdict — judged by whether the experiment's evidence is consistent with the fact:
  corroborated — the experiment's outcome is consistent with the anchor's fact
  contradicted — the experiment observed the fact NOT to hold
  neutral      — the experiment used/assumed the fact but provides no evidence either way
Be selective. Omit anchors the experiment did not actually bear on. When unsure, prefer neutral.

Return JSON only, no markdown:
{"verdicts":[{"id":"pa_...","verdict":"corroborated|contradicted|neutral"}], "reasoning":"..."}
Do NOT return IDs absent from the candidate list.`

/**
 * Judge which physical anchors the experience validated/contradicted, link them onto the
 * experience, and fold the verdict back as a signal:
 *   corroborated → anchor.recordObservation()
 *   contradicted → anchor.recordContradiction() + propagate to dependent principles (§7.2)
 *   neutral      → link only, no signal
 * Returns the per-anchor signals (with any propagated principle IDs). [] without a flash judge.
 */
export async function claimAnchorsForExperience(
  exp: ExperienceEntry,
  experienceStore: ExperienceStore,
  anchorStore: PhysicalAnchorStore,
  principleStore: PrincipleStore,
  flash?: FlashClient | null,
): Promise<AnchorSignal[]> {
  const candidates = await anchorStore.search({ domain: exp.domain, robot: exp.robot, limit: CLAIM_CANDIDATE_LIMIT })
  if (candidates.length === 0 || !flash) return []

  const raw = await flash.query({
    system: ANCHOR_CLAIM_SYSTEM,
    user: [
      'Experience:',
      formatExperienceForClaim(exp),
      '',
      'Candidate anchors:',
      candidates.map(a =>
        `ID: ${a.id}\nTitle: ${a.title}\nFact: ${a.fact}${a.mechanism ? `\nMechanism: ${a.mechanism}` : ''}`,
      ).join('\n\n'),
    ].join('\n'),
    maxTokens: 250,
    timeoutMs: 8_000,
    cacheKey: `anchor-claim:${exp.id}:${candidates.map(c => c.id).sort().join(',')}`,
  })
  if (!raw) return []

  const validIds = new Set(candidates.map(c => c.id))
  const verdicts = parseVerdicts(raw).filter(v => validIds.has(v.anchorId))
  const out: AnchorSignal[] = []
  for (const v of verdicts) {
    await experienceStore.appendAnchorReference(exp.id, v.anchorId).catch(() => undefined)
    if (v.verdict === 'corroborated') {
      await anchorStore.recordObservation(v.anchorId).catch(() => undefined)
      out.push({ anchorId: v.anchorId, verdict: v.verdict })
    } else if (v.verdict === 'contradicted') {
      const anchor = await anchorStore.recordContradiction(v.anchorId).catch(() => null)
      // Propagate: a falsified anchor's physical premise is gone — flag every
      // principle grounded on it for re-review (single hop, no cascade).
      const propagated: string[] = []
      for (const pid of anchor?.principleIds ?? []) {
        const updated = await principleStore.recordContradiction(pid).catch(() => null)
        if (updated) propagated.push(pid)
      }
      out.push({ anchorId: v.anchorId, verdict: v.verdict, propagated })
    } else {
      out.push({ anchorId: v.anchorId, verdict: 'neutral' })
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Diversity → confidence tier (soft signal, not a gate)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Distinct source signature per experience. Two experiences from the same robot
 * AND the same session count as one independent source. Diversity raises the
 * proposed tier from observed → reproduced; it never blocks promotion.
 */
export function diversityTier(cluster: ExperienceEntry[]): KnowledgeConfidenceTier {
  const sources = new Set(
    cluster.map(e => `${e.robot ?? '?'}::${e.sourceSessionId ?? e.id}`),
  )
  return sources.size >= 2 ? 'reproduced' : 'observed'
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export async function evaluatePromotion(
  experienceId: string,
  deps: EvaluatePromotionDeps,
): Promise<EvaluatePromotionResult> {
  const trigger = await deps.experienceStore.load(experienceId)
  if (!trigger) return { kind: 'none', reason: 'missing_experience' }

  const n = deps.n ?? N_CONVERGENCE

  // ── 0. Anchor claim (independent of the principle path) ─────────────────────
  // Validate/contradict physical anchors this experiment bore on; a contradicted
  // anchor propagates to dependent principles. Runs regardless of the outcome
  // below, so its signals are attached to whatever result we return.
  const anchorSignals = await claimAnchorsForExperience(
    trigger, deps.experienceStore, deps.anchorStore, deps.principleStore, deps.flash,
  )
  const withAnchors = (r: EvaluatePromotionResult): EvaluatePromotionResult =>
    anchorSignals.length ? { ...r, anchorSignals } : r

  // ── 1. Claim: covered by an existing principle? → link + reinforce ──────────
  const claimed = await claimPrinciplesForExperience(
    trigger, deps.experienceStore, deps.principleStore, deps.flash,
  )
  if (claimed.length > 0) {
    const signal: 'observation' | 'contradiction' = trigger.outcome.success ? 'observation' : 'contradiction'
    for (const pid of claimed) {
      await deps.principleStore.recordOutcomeSignal(pid, signal).catch(() => undefined)
    }
    return withAnchors({ kind: 'reinforced', principleIds: claimed, signal })
  }

  // ── 2. Converge: cluster unlinked same-domain experiences by mechanism ──────
  const candidates = await deps.experienceStore.search({ domain: trigger.domain, limit: CLUSTER_POOL_LIMIT })
  const pool = candidates.filter(e => (e.principleIds ?? []).length === 0)
  const cluster = await flashClusterByMechanism(trigger, pool, deps.flash)

  if (cluster.length < n) return withAnchors({ kind: 'none', reason: 'below_convergence' })
  // Unresolved contradiction anywhere in the cluster blocks promotion.
  if (cluster.some(e => (e.contradictionCount ?? 0) > 0)) {
    return withAnchors({ kind: 'none', reason: 'unresolved_contradiction' })
  }
  // Cluster-level dedup: if any member is already covered by a principle, the
  // mechanism is already represented — reinforce path will handle future hits.
  if (cluster.some(e => (e.principleIds ?? []).length > 0)) {
    return withAnchors({ kind: 'none', reason: 'already_covered' })
  }

  // ── 3. Judge + propose (default-reject prompt) ─────────────────────────────
  const result = await proposePrincipleFromCluster({
    cluster,
    trigger,
    anchorStore: deps.anchorStore,
    pendingStore: deps.pendingStore,
    flash: deps.flash,
    tier: diversityTier(cluster),
    minRetained: n,
  })

  if (result.promoted && result.pendingId) {
    return withAnchors({ kind: 'proposed', pendingId: result.pendingId, clusterIds: cluster.map(e => e.id) })
  }
  if (result.reason === 'rejected_by_judge') {
    return withAnchors({ kind: 'rejected', reason: result.judgeReason ?? 'cluster rejected by judge' })
  }
  return withAnchors({ kind: 'none', reason: result.reason })
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatExperienceForClaim(e: ExperienceEntry): string {
  return [
    `ID: ${e.id}`,
    `Domain: ${e.domain}`,
    e.robot ? `Robot: ${e.robot}` : '',
    `Outcome: ${e.outcome.success ? 'success' : 'failure'}`,
    `Title: ${e.title}`,
    e.abstractPrinciple ? `Principle hint: ${e.abstractPrinciple}` : '',
    `Problem: ${e.problem}`,
    `Solution: ${e.solution}`,
    e.outcome.failureReason ? `Failure reason: ${e.outcome.failureReason}` : '',
  ].filter(Boolean).join('\n')
}

function parseIdList(raw: string, field: 'applicable' | 'cluster'): string[] {
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return []
    const parsed = JSON.parse(match[0]) as unknown
    if (!parsed || typeof parsed !== 'object') return []
    const arr = (parsed as Record<string, unknown>)[field]
    if (!Array.isArray(arr)) return []
    return [...new Set(arr.filter((v): v is string => typeof v === 'string'))]
  } catch {
    return []
  }
}

function parseVerdicts(raw: string): Array<{ anchorId: string; verdict: 'corroborated' | 'contradicted' | 'neutral' }> {
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return []
    const parsed = JSON.parse(match[0]) as unknown
    if (!parsed || typeof parsed !== 'object') return []
    const arr = (parsed as Record<string, unknown>)['verdicts']
    if (!Array.isArray(arr)) return []
    const seen = new Set<string>()
    const out: Array<{ anchorId: string; verdict: 'corroborated' | 'contradicted' | 'neutral' }> = []
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const id = typeof rec['id'] === 'string' ? rec['id'] : undefined
      const verdict = rec['verdict']
      if (!id || seen.has(id)) continue
      if (verdict === 'corroborated' || verdict === 'contradicted' || verdict === 'neutral') {
        seen.add(id)
        out.push({ anchorId: id, verdict })
      }
    }
    return out
  } catch {
    return []
  }
}
