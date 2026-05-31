/**
 * ExperienceSource — IKnowledgeSource backed by the robotics ExperienceStore.
 *
 * listExperiences() returns recent entries filtered by domain (if provided),
 * sorted by recency. Both successes and failures are included — the caller's
 * LLM decides which principles apply via principle-level reasoning.
 */

import type { ExperienceStore } from '../../robotics/ExperienceStore.js'
import { experienceRetrievalScore } from '../../robotics/ExperienceStore.js'
import type { IKnowledgeSource, ExperienceMatch, ExperienceListOpts } from './IKnowledgeSource.js'
import type { ExperienceEntry } from '../../robotics/types.js'

const MAX_CANDIDATE_POOL = 60

function normalizeKeyword(keyword: string): string | null {
  const normalized = keyword.trim().toLowerCase()
  if (normalized.length < 3) return null
  return normalized
}

function keywordHitCount(entry: ExperienceEntry, keywords: string[]): number {
  if (keywords.length === 0) return 0
  const searchable = [
    entry.title,
    entry.problem,
    entry.solution,
    entry.outcome.summary,
    entry.outcome.failureReason ?? '',
    entry.abstractPrinciple ?? '',
    entry.algorithm ?? '',
    entry.tags.join(' '),
  ].join(' ').toLowerCase()

  return keywords.filter(kw => searchable.includes(kw)).length
}

function toMatch(e: ExperienceEntry): ExperienceMatch {
  return {
    id: e.id,
    title: e.title,
    domain: e.domain,
    outcome: e.outcome.success ? 'success' : 'failure',
    // abstractPrinciple is the same-domain transfer vehicle.
    // Fall back to outcome summary if not yet extracted (older entries).
    abstractPrinciple: e.abstractPrinciple ?? e.outcome.summary,
    failureReason: !e.outcome.success ? e.outcome.failureReason : undefined,
    workarounds: e.outcome.workarounds,
    confidenceTier: e.confidenceTier ?? 'observed',
    evidenceRefs: e.evidenceRefs,
    observationCount: e.observationCount ?? 1,
    contradictionCount: e.contradictionCount ?? 0,
  } satisfies ExperienceMatch
}

export class ExperienceSource implements IKnowledgeSource {
  constructor(private readonly store: ExperienceStore) {}

  async listExperiences(opts: ExperienceListOpts = {}): Promise<ExperienceMatch[]> {
    const limit = opts.limit ?? 12
    const domains = [...new Set(opts.domains?.filter(Boolean) ?? [])]
    const keywords = [...new Set((opts.keywords ?? [])
      .map(normalizeKeyword)
      .filter((kw): kw is string => Boolean(kw)))]

    const pool = new Map<string, ExperienceEntry>()
    const add = (entries: ExperienceEntry[]) => {
      for (const entry of entries) pool.set(entry.id, entry)
    }

    const perQueryLimit = Math.min(20, Math.max(limit * 2, 8))
    if (domains.length > 0) {
      for (const domain of domains) {
        add(await this.store.search({
          domain: domain as any,
          successOnly: false,
          limit: perQueryLimit,
        }))
      }
    } else {
      add(await this.store.search({
        successOnly: false,
        limit: Math.min(MAX_CANDIDATE_POOL, Math.max(limit * 3, 20)),
      }))
    }

    for (const keyword of keywords.slice(0, 8)) {
      if (domains.length > 0) {
        for (const domain of domains) {
          add(await this.store.search({
            domain: domain as any,
            keyword,
            successOnly: false,
            limit: perQueryLimit,
          }))
        }
      } else {
        add(await this.store.search({
          keyword,
          successOnly: false,
          limit: perQueryLimit,
        }))
      }
    }

    const domainSet = new Set(domains)
    const ranked = [...pool.values()].sort((a, b) => {
      const domainDelta = Number(domainSet.has(b.domain)) - Number(domainSet.has(a.domain))
      if (domainDelta !== 0) return domainDelta

      const keywordDelta = keywordHitCount(b, keywords) - keywordHitCount(a, keywords)
      if (keywordDelta !== 0) return keywordDelta

      const scoreDelta = experienceRetrievalScore(b) - experienceRetrievalScore(a)
      return scoreDelta !== 0 ? scoreDelta : b.createdAt - a.createdAt
    })

    return ranked
      .slice(0, limit)
      .map(toMatch)
  }

  async getManifestLine(): Promise<string> {
    try {
      const stats = await this.store.getStats()
      if (stats.total === 0) return 'Experiences: none yet'

      const topDomains = Object.entries(stats.domainCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([d, n]) => `${d}:${n}`)
        .join(', ')

      return `Experiences: ${stats.total} total (${topDomains}) | failures: ${stats.failures}`
    } catch {
      return 'Experiences: (unavailable)'
    }
  }
}
