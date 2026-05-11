/**
 * System Prompt Section Registry
 *
 * A lightweight memoization layer for system prompt sections, inspired by the
 * pattern used in Claude Code (src/constants/systemPromptSections.ts).
 *
 * Two section types:
 *   - memoized  : computed once per session, cached until invalidated
 *   - volatile  : recomputed on every call (DANGEROUS — breaks prompt cache)
 *
 * One SectionRegistry is created per MetaAgentSession.  Sections that depend
 * on per-turn state (campaign_context, phase_guidance) are marked volatile.
 * All others are memoized and only recomputed when explicitly invalidated.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ComputeFn = () => string | null | Promise<string | null>

export interface SystemPromptSection {
  readonly name: string
  readonly compute: ComputeFn
  /** If true, recompute every call (cache-breaking). */
  readonly volatile: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a memoized section.
 * Computed once and cached until `registry.invalidate(name)` or `invalidateAll()`.
 */
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, volatile: false }
}

/**
 * Create a volatile section that recomputes on every resolve() call.
 *
 * WARNING: Volatile sections break the Anthropic prompt cache whenever their
 * content changes.  Only use when the value genuinely changes between turns
 * and staleness would cause incorrect model behaviour.
 *
 * @param _reason  — document why cache-breaking is acceptable here.
 */
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, volatile: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// SectionRegistry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-session cache for memoized system prompt sections.
 *
 * Usage:
 *   const registry = new SectionRegistry()
 *   const sections = [memorySection, envSection, campaignContextSection, ...]
 *   const strings = await registry.resolve(sections)
 *   const systemPrompt = strings.filter(Boolean).join('\n\n')
 */
export class SectionRegistry {
  private readonly cache = new Map<string, string | null>()

  /**
   * Remove a single section from the cache so it will be recomputed next call.
   * No-op if the section was not yet cached.
   */
  invalidate(name: string): void {
    this.cache.delete(name)
  }

  /**
   * Clear the entire section cache (e.g. on /clear or /compact equivalent).
   */
  invalidateAll(): void {
    this.cache.clear()
  }

  /**
   * Resolve all sections in parallel, returning their string values in order.
   * Memoized sections are read from cache when available.
   * Volatile sections are always recomputed.
   * Null/empty-string results are preserved — callers should filter them out.
   */
  async resolve(sections: SystemPromptSection[]): Promise<(string | null)[]> {
    return Promise.all(
      sections.map(async s => {
        if (!s.volatile && this.cache.has(s.name)) {
          return this.cache.get(s.name) ?? null
        }
        const value = await s.compute()
        if (!s.volatile) {
          this.cache.set(s.name, value)
        }
        return value
      }),
    )
  }

  /**
   * Resolve sections and join non-empty results with double newlines.
   * Convenience wrapper over resolve().
   */
  async resolveToString(sections: SystemPromptSection[]): Promise<string> {
    const parts = await this.resolve(sections)
    return parts.filter((s): s is string => !!s).join('\n\n')
  }
}
