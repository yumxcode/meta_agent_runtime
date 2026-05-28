/**
 * ExperienceSource — IKnowledgeSource backed by the robotics ExperienceStore.
 *
 * listExperiences() returns recent entries filtered by domain (if provided),
 * sorted by recency. Both successes and failures are included — the caller's
 * LLM decides which principles apply via principle-level reasoning.
 */

import type { ExperienceStore } from '../../robotics/ExperienceStore.js'
import type { IKnowledgeSource, ExperienceMatch, ExperienceListOpts } from './IKnowledgeSource.js'

export class ExperienceSource implements IKnowledgeSource {
  constructor(private readonly store: ExperienceStore) {}

  async listExperiences(opts: ExperienceListOpts = {}): Promise<ExperienceMatch[]> {
    const limit = opts.limit ?? 12

    // Load all entries, apply domain filter if provided
    const all = await this.store.search({
      domain: (opts.domains?.length === 1 ? opts.domains[0] : undefined) as any,
      successOnly: false,
      limit: Math.min(limit * 3, 60),  // over-fetch before domain filter
    })

    // Multi-domain filter (store.search only supports single domain)
    const filtered = opts.domains?.length
      ? all.filter(e => opts.domains!.includes(e.domain))
      : all

    // ExperienceStore.search already applies confidence-aware ranking with
    // recency as the tiebreaker. Preserve that order here.
    return filtered
      .slice(0, limit)
      .map(e => ({
        id: e.id,
        title: e.title,
        domain: e.domain,
        outcome: e.outcome.success ? 'success' : 'failure',
        // abstractPrinciple is the same-domain transfer vehicle.
        // Fall back to outcome summary if not yet extracted (older entries).
        abstractPrinciple: (e as any).abstractPrinciple ?? e.outcome.summary,
        failureReason: !e.outcome.success ? e.outcome.failureReason : undefined,
        workarounds: e.outcome.workarounds,
        confidenceTier: e.confidenceTier ?? 'observed',
        evidenceRefs: e.evidenceRefs,
        observationCount: e.observationCount ?? 1,
        contradictionCount: e.contradictionCount ?? 0,
      } satisfies ExperienceMatch))
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
