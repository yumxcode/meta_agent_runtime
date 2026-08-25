/**
 * ExperienceWorkingSetManager — the "recall the right past experiences for this
 * turn" engine, extracted out of RoboticsSession (god-object — see
 * docs/reviews/architecture-review-2026-06-18.md §3.1).
 *
 * Responsibility: given the user prompt + analyzed intent, pick a small set of
 * stored experiences that materially apply (local heuristic ranking + an
 * optional flash-model relevance pass), check them into the ContextPager so R2
 * surfaces them, and expose the current working set for the compaction anchors.
 *
 * It owns all the experience-candidate caching state that used to be ~6 private
 * fields on the session, so the session just calls preload()/forceReload() and
 * reads `.current`.
 */
import { createHash } from 'crypto'
import { estimateTokens } from '../context/TokenEstimator.js'
import type { ExperienceSource } from '../context/sources/ExperienceSource.js'
import type { ContextPager } from '../context/ContextPager.js'
import type { QueryIntent } from '../context/QueryAnalyzer.js'
import type { ExperienceMatch } from '../context/sources/IKnowledgeSource.js'
import type { FlashClient } from '../core/flash/FlashClient.js'

const EXPERIENCE_TASK_SWITCH_RE = /\b(new task|switch task|different task|another task|unrelated)\b|换个|另一个|另外一个|新任务|重新开始/
const EXPERIENCE_INJECTION_LIMIT = 4
const EXPERIENCE_CANDIDATE_LIMIT = 18
const EXPERIENCE_STRONG_APPLICABILITY_SCORE = 100

/**
 * Identity of the selection algorithm, recorded with every injection.
 *
 * Bump when the ranking, the thresholds, the candidate limit or the relevance
 * prompt change — anything that would make two runs' selections incomparable.
 * Which of the two code paths ran on a given turn is recorded separately as
 * `selectionPath`, because that varies per turn rather than per version.
 */
export const EXPERIENCE_SELECTOR_VERSION = 'working-set-v1'
/**
 * Soft cap on how long preload() waits for the LLM relevance judgement.
 *
 * Matches QueryAnalyzer's budget on purpose: both sit on the same critical path
 * (submit() awaits the intent, then awaits preload()), so a user who presses
 * Enter should never wait more than a couple of seconds for context assembly
 * regardless of how many flash calls it involves.
 */
const SELECT_WAIT_BUDGET_MS = 5_000

const EXPERIENCE_RELEVANCE_SYSTEM = `\
You select stored robotics experiences that should be injected into the current task context.

Judge applicability by mechanism and abstract principle, not surface word overlap.
Return JSON only: {"applicable":["id1","id2"]}

Rules:
- Include only experiences that materially constrain, warn, or guide this task.
- Prefer same robot/domain/algorithm/mechanism, but allow cross-domain transfer only when the principle clearly applies.
- Exclude weakly related memories; noisy context is worse than no context.
- Return at most ${EXPERIENCE_INJECTION_LIMIT} IDs.
- If none apply, return {"applicable":[]}.`

export interface SelectedExperience {
  experience: ExperienceMatch
  appliesBecause: string
  localScore: number
  hasApplicabilitySignal: boolean
}

/**
 * Which route produced this turn's selection.
 *
 * Everything except `flash_selected` yields the locally-ranked fallback — the
 * behaviour is identical, which is exactly why the distinction has to be
 * recorded explicitly rather than inferred from the result.
 */
export type ExperienceSelectionPath =
  /** Nothing in the candidate pool; no selection was attempted. */
  | 'no_candidates'
  /** No API key, so the relevance pass never existed. Local ranking only. */
  | 'no_flash_client'
  /** The relevance call lost the wait budget. No judgement was obtained. */
  | 'flash_timeout'
  /** It answered in a shape we could not read. No judgement was obtained. */
  | 'flash_unparseable'
  /** It named ids, none of which exist. No usable judgement. */
  | 'flash_invalid_ids'
  /** It explicitly judged that none apply — a real negative, not a failure. */
  | 'flash_empty'
  /** It selected at least one entry. */
  | 'flash_selected'
  /**
   * preload() threw (store read failed, etc). The pool is unknown, not empty —
   * distinct from `no_candidates`, which asserts the store had nothing to say.
   */
  | 'preload_error'

/** A candidate as it stood when the selector looked at it. */
export interface ExperienceCandidateRecord {
  entryId: string
  contentHash: string
  localScore: number
  hasApplicabilitySignal: boolean
  /**
   * Whether it clears the local threshold.
   *
   * Recorded per candidate rather than pre-filtered because the two selection
   * paths disagree about what "eligible" means: the local path treats this flag
   * as the eligibility gate, while the flash path sends the whole pool and
   * ignores the threshold entirely. Storing the raw verdict alongside the
   * chosen path keeps both definitions recoverable instead of freezing one of
   * them into the record.
   */
  eligibleByThreshold: boolean
}

interface ExperiencePreloadTrace {
  queryHash: string
  domains: string[]
  keywords: string[]
  candidateSource: 'store' | 'cache' | 'none'
  candidateCount: number
  /**
   * Ids selected for this turn.
   *
   * Named `injectedIds` historically; it never meant "injected". Selection is
   * upstream of checkout and of rendering, and slots outlive their selection,
   * so this set is neither a subset nor a superset of what actually reached the
   * model. The pager's render trace is the authority on injection.
   */
  injectedIds: string[]
  selectorVersion: string
  selectionPath: ExperienceSelectionPath
  pool: ExperienceCandidateRecord[]
  /** Slots this turn's checkout refused outright (see ContextPager 'oversized'). */
  checkoutRejected: ExperienceCandidateRecord[]
}

function normalizeExperienceKeyword(keyword: string): string | null {
  const normalized = keyword.trim().toLowerCase()
  if (normalized.length >= 3) return normalized
  // Accept 2-char CJK terms — Chinese technical terms (步态/标定/力矩) are often
  // exactly two characters and would otherwise be dropped before store search.
  if (normalized.length === 2 && /[一-鿿]/.test(normalized)) return normalized
  return null
}

function formatExperienceCandidate(e: ExperienceMatch): string {
  return [
    `ID: ${e.id}`,
    `Domain: ${e.domain}`,
    `Outcome: ${e.outcome}`,
    `Confidence: ${e.confidenceTier ?? 'observed'} (${e.observationCount ?? 1} obs, ${e.contradictionCount ?? 0} contradictions)`,
    `Title: ${e.title}`,
    `Principle: ${e.abstractPrinciple}`,
    ...(e.failureReason ? [`Failure: ${e.failureReason.slice(0, 160)}`] : []),
    ...(e.workarounds?.length ? [`Workaround: ${e.workarounds[0]}`] : []),
  ].join('\n')
}

/**
 * Outcome of reading the relevance model's answer.
 *
 * Previously this returned a bare `Set`, which collapsed three different
 * situations into one empty set: the model said "none apply", the model
 * answered in a shape we could not read, and the model named only ids that do
 * not exist. All three then hit the same `return localFallback`, so nothing
 * downstream could tell an informative negative judgement apart from a
 * malfunction. For provenance those are opposite facts — "no experience
 * applied here" is evidence, "we failed to ask" is an absence of evidence.
 */
type ApplicableIdsOutcome =
  | { kind: 'parsed'; ids: Set<string>; namedCount: number }
  | { kind: 'unparseable' }

function parseApplicableExperienceIds(
  raw: string,
  candidates: ExperienceMatch[],
): ApplicableIdsOutcome {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { kind: 'unparseable' }
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    const named = parsed['applicable']
    if (!Array.isArray(named)) return { kind: 'unparseable' }
    const validIds = new Set(candidates.map(c => c.id))
    const ids = named.filter((id): id is string => typeof id === 'string' && validIds.has(id))
    return {
      kind: 'parsed',
      ids: new Set(ids.slice(0, EXPERIENCE_INJECTION_LIMIT)),
      // How many the model named before validity filtering: a non-zero
      // namedCount with an empty id set means it invented ids, which is a
      // different failure from it deliberately returning an empty list.
      namedCount: named.length,
    }
  } catch {
    return { kind: 'unparseable' }
  }
}

function toCandidateRecord(selection: SelectedExperience): ExperienceCandidateRecord {
  return {
    entryId: selection.experience.id,
    contentHash: selection.experience.contentHash,
    localScore: selection.localScore,
    hasApplicabilitySignal: selection.hasApplicabilitySignal,
    eligibleByThreshold:
      selection.hasApplicabilitySignal &&
      selection.localScore >= EXPERIENCE_STRONG_APPLICABILITY_SCORE,
  }
}

export interface ExperienceWorkingSetDeps {
  experienceSource: ExperienceSource
  contextPager: ContextPager
  /** May be null when no API key is available — selection falls back to local ranking. */
  flashClient: FlashClient | null
  /** Robot/platform name, used as a ranking signal. */
  robot: string | undefined
  /**
   * How long preload() will WAIT for the LLM relevance judgement before falling
   * back to the locally-ranked selection. Defaults to
   * SELECT_WAIT_BUDGET_MS; 0 waits for the full flash timeout (~41s).
   * Exposed mainly so tests can shrink it.
   */
  selectWaitBudgetMs?: number
}

export class ExperienceWorkingSetManager {
  private readonly experienceSource: ExperienceSource
  private readonly contextPager: ContextPager
  private readonly flashClient: FlashClient | null
  private readonly selectWaitBudgetMs: number
  private readonly robot: string | undefined

  private _candidatePool: ExperienceMatch[] = []
  private _workingSet: SelectedExperience[] = []
  private _workingSetDomains = new Set<string>()
  private _workingSetKeywords = new Set<string>()
  private _forceCandidateLoad = true
  private _lastPreloadTrace: ExperiencePreloadTrace | null = null

  constructor(deps: ExperienceWorkingSetDeps) {
    this.experienceSource = deps.experienceSource
    this.contextPager = deps.contextPager
    this.flashClient = deps.flashClient
    this.robot = deps.robot
    this.selectWaitBudgetMs = deps.selectWaitBudgetMs ?? SELECT_WAIT_BUDGET_MS
  }

  /** The experiences selected for the current turn (consumed by compaction anchors). */
  get current(): SelectedExperience[] {
    return this._workingSet
  }

  /** Last preload trace (diagnostics). */
  get lastPreloadTrace(): ExperiencePreloadTrace | null {
    return this._lastPreloadTrace
  }

  /**
   * Force a fresh candidate load on the next preload() — called at session-start
   * moments (e.g. after compaction) so the working set is rebuilt from the store.
   */
  forceReload(): void {
    this._forceCandidateLoad = true
  }

  async preload(prompt: string, intent: QueryIntent | null): Promise<void> {
    if (!intent) {
      this._lastPreloadTrace = {
        queryHash: this._queryHash(prompt),
        domains: [],
        keywords: [],
        candidateSource: 'none',
        candidateCount: 0,
        injectedIds: [],
        selectorVersion: EXPERIENCE_SELECTOR_VERSION,
        selectionPath: 'no_candidates',
        pool: [],
        checkoutRejected: [],
      }
      return
    }

    const domains = intent.domains.filter(d => d !== 'general')
    const keywords = intent.searchKeywords
      .map(normalizeExperienceKeyword)
      .filter((kw): kw is string => Boolean(kw))
      .slice(0, 8)

    const shouldLoad = this._shouldLoadCandidates(prompt, domains, keywords)
    let candidateSource: ExperiencePreloadTrace['candidateSource'] = 'cache'

    try {
      let candidates = this._candidatePool
      if (shouldLoad) {
        candidates = await this.experienceSource.listExperiences({
          domains: domains.length > 0 ? domains : undefined,
          keywords,
          robot: this.robot,
          currentQuery: prompt,
          limit: EXPERIENCE_CANDIDATE_LIMIT,
        })
        this._candidatePool = candidates
        this._workingSetDomains = new Set(domains)
        this._workingSetKeywords = new Set(keywords)
        this._forceCandidateLoad = false
        candidateSource = 'store'
      }

      const { selected, path, ranked } = await this._selectApplicable(prompt, intent, candidates)
      this._workingSet = selected
      const queryHash = this._queryHash(prompt)
      const checkoutRejected = this._refreshSlots(selected, queryHash, path)
      this._lastPreloadTrace = {
        queryHash,
        domains,
        keywords,
        candidateSource,
        candidateCount: candidates.length,
        injectedIds: selected.map(s => s.experience.id),
        selectorVersion: EXPERIENCE_SELECTOR_VERSION,
        selectionPath: path,
        pool: ranked.map(toCandidateRecord),
        checkoutRejected: checkoutRejected.map(toCandidateRecord),
      }
    } catch {
      this._lastPreloadTrace = {
        queryHash: this._queryHash(prompt),
        domains,
        keywords,
        candidateSource: 'none',
        candidateCount: 0,
        injectedIds: [],
        selectorVersion: EXPERIENCE_SELECTOR_VERSION,
        // A thrown preload is not a judgement that nothing applied; the pool is
        // simply unknown. 'no_candidates' would misreport it as an empty pool.
        selectionPath: 'preload_error',
        pool: [],
        checkoutRejected: [],
      }
      // Experience preload is mandatory in shape but opportunistic in effect;
      // failures must not block the user turn.
    }
  }

  private _shouldLoadCandidates(
    prompt: string,
    domains: string[],
    keywords: string[],
  ): boolean {
    if (this._forceCandidateLoad) return true
    if (this._candidatePool.length === 0) return true

    if (this._workingSetDomains.size === 0 && this._workingSetKeywords.size === 0) {
      return true
    }

    const domainOverlap = domains.some(d => this._workingSetDomains.has(d))
    if (domains.length > 0 && this._workingSetDomains.size > 0 && !domainOverlap) {
      return true
    }

    const taskSwitch = EXPERIENCE_TASK_SWITCH_RE.test(prompt.toLowerCase())
    if (!taskSwitch) return false

    const keywordOverlap = keywords.some(kw => this._workingSetKeywords.has(kw))
    return keywords.length > 0 && this._workingSetKeywords.size > 0 && !keywordOverlap
  }

  private async _selectApplicable(
    prompt: string,
    intent: QueryIntent,
    candidates: ExperienceMatch[],
  ): Promise<{ selected: SelectedExperience[]; path: ExperienceSelectionPath; ranked: SelectedExperience[] }> {
    if (candidates.length === 0) {
      return { selected: [], path: 'no_candidates', ranked: [] }
    }

    const locallyRanked = this._rankCandidates(prompt, intent, candidates)
    const localFallback = locallyRanked
      .filter(s => s.hasApplicabilitySignal && s.localScore >= EXPERIENCE_STRONG_APPLICABILITY_SCORE)
      .slice(0, EXPERIENCE_INJECTION_LIMIT)

    if (!this.flashClient) {
      return { selected: localFallback, path: 'no_flash_client', ranked: locallyRanked }
    }

    // Soft deadline, same shape as QueryAnalyzer's.
    //
    // This call had NO wait budget: `preload()` is awaited on the turn's
    // critical path, and the flash query's derived timeout is ~41s, so a slow
    // provider could hold the user's Enter key for forty seconds before the
    // main model was even asked anything. The irony was that the line above it
    // — the intent analysis — went to great lengths to race a 5s budget, and
    // then handed control straight to something unbounded.
    //
    // `localFallback` is already computed, so losing the race costs nothing but
    // precision: the locally-ranked, strongly-applicable experiences get
    // injected instead of the LLM-selected ones. The request keeps running in
    // the background purely to populate the cache, which a repeat of the same
    // (prompt, intent, candidate-set) will hit — that is a realistic repeat,
    // unlike an identical free-text prompt, because the candidate pool is
    // stable across turns.
    const raw = await this.raceWithBudget(this.flashClient.query({
      system: EXPERIENCE_RELEVANCE_SYSTEM,
      user: [
        `User task:\n${prompt.slice(0, 800)}`,
        `Intent: ${intent.intent}; domains=${intent.domains.join(', ')}`,
        `Search keywords: ${intent.searchKeywords.join(', ')}`,
        `Candidate experiences:\n${candidates.map(formatExperienceCandidate).join('\n\n')}`,
      ].join('\n\n'),
      maxTokens: 220,
      cacheKey: `experience-working-set:${createHash('sha256')
        .update([
          prompt.slice(0, 800),
          intent.intent,
          intent.domains.join(','),
          intent.searchKeywords.join(','),
          candidates.map(c => c.id).join(','),
        ].join('\n'))
        .digest('hex')}`,
      // Losing the race is an expected outcome, not a failure worth a warning
      // in the middle of the user's turn. See FlashClient.speculative.
      speculative: true,
      label: 'experience-working-set',
    }))

    // Every branch below returns the same `localFallback` the original code
    // returned; only the recorded reason differs.
    if (!raw) return { selected: localFallback, path: 'flash_timeout', ranked: locallyRanked }

    const outcome = parseApplicableExperienceIds(raw, candidates)
    if (outcome.kind === 'unparseable') {
      return { selected: localFallback, path: 'flash_unparseable', ranked: locallyRanked }
    }
    if (outcome.ids.size === 0) {
      return {
        selected: localFallback,
        path: outcome.namedCount > 0 ? 'flash_invalid_ids' : 'flash_empty',
        ranked: locallyRanked,
      }
    }

    const byId = new Map(locallyRanked.map(s => [s.experience.id, s]))
    const selected = [...outcome.ids]
      .map(id => byId.get(id))
      .filter((s): s is SelectedExperience => Boolean(s))
      .slice(0, EXPERIENCE_INJECTION_LIMIT)
    return { selected, path: 'flash_selected', ranked: locallyRanked }
  }

  /**
   * Resolve `work` if it finishes within the wait budget, otherwise null.
   *
   * The losing promise is NOT cancelled: it keeps running under the flash
   * client's own timeout and populates the result cache, so the next turn with
   * the same (prompt, intent, candidates) gets it for free. Cancelling would
   * throw that work away for no gain — the cost was already paid the moment the
   * request went out.
   */
  private async raceWithBudget<T>(work: Promise<T | null>): Promise<T | null> {
    if (this.selectWaitBudgetMs <= 0) return work
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), this.selectWaitBudgetMs)
      timer.unref?.()
    })
    try {
      // work never rejects (FlashClient.query catches its own errors), so a
      // plain race is safe here.
      return await Promise.race([work, budget])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private _rankCandidates(
    prompt: string,
    intent: QueryIntent,
    candidates: ExperienceMatch[],
  ): SelectedExperience[] {
    const queryText = [
      prompt,
      ...intent.searchKeywords,
      ...intent.domains,
      this.robot ?? '',
    ].join(' ').toLowerCase()
    const domainSet = new Set<string>(intent.domains.filter(d => d !== 'general'))
    const keywords = intent.searchKeywords
      .map(normalizeExperienceKeyword)
      .filter((kw): kw is string => Boolean(kw))

    return candidates.map(experience => {
      const searchable = [
        experience.title,
        experience.abstractPrinciple,
        experience.failureReason ?? '',
        experience.workarounds?.join(' ') ?? '',
        experience.algorithm ?? '',
        experience.robot ?? '',
      ].join(' ').toLowerCase()

      const matchingKeywords = keywords.filter(kw => searchable.includes(kw)).slice(0, 3)
      const sameDomain = domainSet.has(experience.domain)
      const sameRobot = Boolean(this.robot && experience.robot?.toLowerCase() === this.robot.toLowerCase())
      const sameAlgorithm = Boolean(experience.algorithm && queryText.includes(experience.algorithm.toLowerCase()))
      const hardwareMechanism = intent.hasHardware || intent.domains.includes('hardware_interface') || intent.domains.includes('deployment')
        ? /\b(torque|force|velocity|joint|motor|actuator|sensor|limit|thermal|driver|can|gpio|gripper)\b/i.test(searchable)
        : false

      const confidence = experience.confidenceTier ?? 'observed'
      const confidenceScore = confidence === 'reproduced' ? 90 :
        confidence === 'observed' ? 70 :
        confidence === 'derived' ? 60 :
        confidence === 'reported' ? 30 :
        confidence === 'hypothesis' ? -40 : 40
      const evidenceBoost = experience.evidenceRefs?.length ? 30 : 0
      const contradictionPenalty = Math.max(0, experience.contradictionCount ?? 0) * 45
      const observationBoost = Math.min(Math.max(1, experience.observationCount ?? 1), 5) * 8

      const applicabilityScore =
        (sameDomain ? 120 : 0) +
        (sameRobot ? 100 : 0) +
        (sameAlgorithm ? 110 : 0) +
        matchingKeywords.length * 55 +
        (hardwareMechanism ? 75 : 0)

      const reasons: string[] = []
      if (sameDomain) reasons.push(`same ${experience.domain} domain`)
      if (sameRobot) reasons.push(`same robot platform (${this.robot})`)
      if (sameAlgorithm && experience.algorithm) reasons.push(`same algorithm (${experience.algorithm})`)
      if (hardwareMechanism) reasons.push('same hardware constraint')
      if (matchingKeywords.length > 0) reasons.push(`matching task terms (${matchingKeywords.join(', ')})`)
      const hasApplicabilitySignal = reasons.length > 0

      return {
        experience,
        appliesBecause: reasons.slice(0, 2).join('; ') || 'flash judged the stored principle applicable',
        localScore: applicabilityScore + confidenceScore + evidenceBoost + observationBoost - contradictionPenalty,
        hasApplicabilitySignal,
      }
    }).sort((a, b) => b.localScore - a.localScore)
  }

  /**
   * Check the selected experiences into the pager.
   *
   * Returns the selections the pager refused. `checkout()` has always returned
   * a boolean and this method has always ignored it, so an experience larger
   * than the whole non-sticky budget vanished with no record anywhere — the
   * model never saw it and nothing said so. The return value is now captured so
   * provenance can report the exclusion.
   *
   * The drop itself is unchanged on purpose: G0's contract is that it does not
   * alter Agent behaviour, and truncating the content to make it fit would
   * change what the model reads. Fixing it is a separate decision, and one that
   * should be made after the data says how often it actually happens.
   */
  private _refreshSlots(
    selections: SelectedExperience[],
    queryHash: string,
    selectionPath: ExperienceSelectionPath,
  ): SelectedExperience[] {
    const rejected: SelectedExperience[] = []
    for (const selection of selections) {
      const e = selection.experience
      const icon = e.outcome === 'success' ? '✓' : '⚠️'
      const lines = [
        `### ${icon} Past Experience: ${e.title}`,
        `**Domain:** ${e.domain}  **Outcome:** ${e.outcome}`,
        `**Confidence:** ${e.confidenceTier ?? 'observed'}${e.observationCount ? ` (${e.observationCount} observation${e.observationCount === 1 ? '' : 's'})` : ''}`,
        `**Applies because:** ${selection.appliesBecause}`,
        `**Principle:** ${e.abstractPrinciple}`,
        ...(e.failureReason ? [`**Failure detail:** ${e.failureReason}`] : []),
        ...(e.workarounds?.length ? [`**Workarounds:** ${e.workarounds.join(' / ')}`] : []),
      ]
      const content = lines.join('\n')
      const accepted = this.contextPager.checkout({
        id:       `experience:${e.id}`,
        tag:      `${icon} [EXP] ${e.title.slice(0, 40)}`,
        content,
        tokenEst: estimateTokens(content),
        priority: 'medium',
        ttlTurns: 4,
        source:   'experience',
        // Identity travels with the slot: by the time this slot is rendered the
        // working set may have moved on, and the pager has no way back to the
        // selection that produced it. queryHash in particular is stamped here,
        // so a slot still being injected three turns later still points at the
        // query that actually retrieved it.
        provenance: {
          entryId:         e.id,
          contentHash:     e.contentHash,
          queryHash,
          // The route is part of the effective selector: a turn where the judge
          // chose and a turn where it timed out and local ranking chose are two
          // different selectors, even though the version constant is the same.
          selectorVersion: `${EXPERIENCE_SELECTOR_VERSION}/${selectionPath}`,
        },
      })
      if (!accepted) rejected.push(selection)
    }
    return rejected
  }

  private _queryHash(prompt: string): string {
    return createHash('sha256').update(prompt.slice(0, 800)).digest('hex').slice(0, 12)
  }
}
