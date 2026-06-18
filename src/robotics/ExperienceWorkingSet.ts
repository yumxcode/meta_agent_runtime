/**
 * ExperienceWorkingSetManager — the "recall the right past experiences for this
 * turn" engine, extracted out of RoboticsSession (god-object — see
 * architecture-review-2026-06-18.md §3.1).
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

interface ExperiencePreloadTrace {
  queryHash: string
  domains: string[]
  keywords: string[]
  candidateSource: 'store' | 'cache' | 'none'
  candidateCount: number
  injectedIds: string[]
}

function normalizeExperienceKeyword(keyword: string): string | null {
  const normalized = keyword.trim().toLowerCase()
  if (normalized.length < 3) return null
  return normalized
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

function parseApplicableExperienceIds(raw: string, candidates: ExperienceMatch[]): Set<string> {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return new Set()
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    const validIds = new Set(candidates.map(c => c.id))
    const ids = Array.isArray(parsed['applicable'])
      ? parsed['applicable'].filter((id): id is string => typeof id === 'string' && validIds.has(id))
      : []
    return new Set(ids.slice(0, EXPERIENCE_INJECTION_LIMIT))
  } catch {
    return new Set()
  }
}

export interface ExperienceWorkingSetDeps {
  experienceSource: ExperienceSource
  contextPager: ContextPager
  /** May be null when no API key is available — selection falls back to local ranking. */
  flashClient: FlashClient | null
  /** Robot/platform name, used as a ranking signal. */
  robot: string | undefined
}

export class ExperienceWorkingSetManager {
  private readonly experienceSource: ExperienceSource
  private readonly contextPager: ContextPager
  private readonly flashClient: FlashClient | null
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

      const selected = await this._selectApplicable(prompt, intent, candidates)
      this._workingSet = selected
      this._refreshSlots(selected)
      this._lastPreloadTrace = {
        queryHash: this._queryHash(prompt),
        domains,
        keywords,
        candidateSource,
        candidateCount: candidates.length,
        injectedIds: selected.map(s => s.experience.id),
      }
    } catch {
      this._lastPreloadTrace = {
        queryHash: this._queryHash(prompt),
        domains,
        keywords,
        candidateSource: 'none',
        candidateCount: 0,
        injectedIds: [],
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
  ): Promise<SelectedExperience[]> {
    if (candidates.length === 0) return []

    const locallyRanked = this._rankCandidates(prompt, intent, candidates)
    const localFallback = locallyRanked
      .filter(s => s.hasApplicabilitySignal && s.localScore >= EXPERIENCE_STRONG_APPLICABILITY_SCORE)
      .slice(0, EXPERIENCE_INJECTION_LIMIT)

    if (!this.flashClient) {
      return localFallback
    }

    const raw = await this.flashClient.query({
      system: EXPERIENCE_RELEVANCE_SYSTEM,
      user: [
        `User task:\n${prompt.slice(0, 800)}`,
        `Intent: ${intent.intent}; risk=${intent.riskLevel}; domains=${intent.domains.join(', ')}`,
        `Search keywords: ${intent.searchKeywords.join(', ')}`,
        `Candidate experiences:\n${candidates.map(formatExperienceCandidate).join('\n\n')}`,
      ].join('\n\n'),
      maxTokens: 220,
      timeoutMs: 30_000,
      cacheKey: `experience-working-set:${createHash('sha256')
        .update([
          prompt.slice(0, 800),
          intent.intent,
          intent.riskLevel,
          intent.domains.join(','),
          intent.searchKeywords.join(','),
          candidates.map(c => c.id).join(','),
        ].join('\n'))
        .digest('hex')}`,
    })

    if (!raw) return localFallback
    const ids = parseApplicableExperienceIds(raw, candidates)
    if (ids.size === 0) return localFallback

    const byId = new Map(locallyRanked.map(s => [s.experience.id, s]))
    return [...ids]
      .map(id => byId.get(id))
      .filter((s): s is SelectedExperience => Boolean(s))
      .slice(0, EXPERIENCE_INJECTION_LIMIT)
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

  private _refreshSlots(selections: SelectedExperience[]): void {
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
      this.contextPager.checkout({
        id:       `experience:${e.id}`,
        tag:      `${icon} [EXP] ${e.title.slice(0, 40)}`,
        content,
        tokenEst: estimateTokens(content),
        priority: 'medium',
        ttlTurns: 4,
        source:   'experience',
      })
    }
  }

  private _queryHash(prompt: string): string {
    return createHash('sha256').update(prompt.slice(0, 800)).digest('hex').slice(0, 12)
  }
}
