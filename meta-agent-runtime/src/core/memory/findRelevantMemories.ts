/**
 * Meta-Agent Memory — per-query topic file relevance selection
 *
 * Architecture mirrors CC's findRelevantMemories.ts:
 *   1. Scan all topic files and extract frontmatter headers
 *   2. Split files into always-relevant (user + feedback) and candidates
 *   3. Select candidates via Haiku side-call (when Anthropic client provided)
 *      or keyword match (fallback)
 *   4. Load and return file content for selected files
 *
 * Differences from CC:
 *   - Uses Haiku (not Sonnet) for relevance — task is simpler, cost lower
 *   - No alreadySurfaced dedup (all injected via system prompt, not per-turn)
 *   - campaign_lessons type: only loaded in campaign mode by default
 *   - max 5 candidate files (same as CC)
 */

import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import type Anthropic from '@anthropic-ai/sdk'
import { MEMORY_DIR, MEMORY_ENTRYPOINT_NAME } from './paths.js'
import { MEMORY_TYPES, type MemoryType } from './types.js'
import type { AgentMode } from '../dynamicPrompt.js'

// ─────────────────────────────────────────────────────────────────────────────
// Shared utility: promise with hard timeout (Fix #5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Race `promise` against a timeout of `ms` milliseconds.
 * Rejects with a TimeoutError if the timeout fires first.
 * Always clears the timer to avoid leaking into the event loop.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Valid scope values for memory entries. */
export type MemoryScope = 'global' | 'project' | 'campaign' | 'domain'

/** Valid confidence levels for memory entries. */
export type MemoryConfidence = 'high' | 'medium' | 'low'

const MEMORY_SCOPES: ReadonlySet<string> = new Set<MemoryScope>([
  'global', 'project', 'campaign', 'domain',
])
const MEMORY_CONFIDENCES: ReadonlySet<string> = new Set<MemoryConfidence>([
  'high', 'medium', 'low',
])

export type TopicFileHeader = {
  filename: string
  filePath: string
  /** From frontmatter `name:` field, or derived from filename */
  name: string
  /** From frontmatter `description:` field */
  description: string
  type: MemoryType | undefined
  date: string | undefined
  campaign: string | undefined
  source: string | undefined
  mtimeMs: number
  // ── Scope & freshness metadata (optional, parsed from frontmatter) ─────────
  /** Applicability scope.  Defaults to 'global' when absent. */
  scope: MemoryScope | undefined
  /** Engineering domain tag for domain-scoped memories. */
  domain: string | undefined
  /**
   * ISO date string (YYYY-MM-DD) after which this memory should not be recalled.
   * Prevents stale standard values / outdated material properties from polluting
   * long-running task context.
   */
  validUntil: string | undefined
  /** Model confidence in the stored fact. */
  confidence: MemoryConfidence | undefined
  /** Whether the fact has been verified against a primary source. */
  sourceVerified: boolean | undefined
  /**
   * When true the memory should be presented with a revalidation notice
   * so the model knows to confirm before use.
   */
  requiresRevalidation: boolean | undefined
}

export type RelevantMemory = {
  header: TopicFileHeader
  /** Full file content including frontmatter */
  content: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter delimited by `---` lines.
 * Handles only simple `key: value` pairs — no nested objects or arrays.
 */
function parseFrontmatter(raw: string): Record<string, string> {
  const result: Record<string, string> = {}
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match?.[1]) return result

  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    // Strip inline comments (# ...) after the value
    const rawVal = line.slice(colon + 1)
    const val = rawVal.replace(/#.*$/, '').trim()
    if (key && val) result[key] = val
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Topic file scanning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read all *.md files in the memory directory (excluding MEMORY.md) and
 * extract their frontmatter headers.  Files that cannot be parsed are skipped.
 */
export async function scanTopicFiles(
  memoryDir: string = MEMORY_DIR,
): Promise<TopicFileHeader[]> {
  let entries: string[]
  try {
    entries = await readdir(memoryDir)
  } catch {
    return []
  }

  // Parallelise all file reads across the directory (Fix #9: was a serial loop).
  const results = await Promise.all(
    entries
      .filter(entry => entry.endsWith('.md') && entry !== MEMORY_ENTRYPOINT_NAME)
      .map(async (entry): Promise<TopicFileHeader | null> => {
        const filePath = join(memoryDir, entry)
        try {
          const [content, stats] = await Promise.all([
            readFile(filePath, 'utf-8'),
            stat(filePath),
          ])
          const fm = parseFrontmatter(content)
          const rawType = fm['type']
          const parsedType = MEMORY_TYPES.find(t => t === rawType) as MemoryType | undefined

          // Scope & freshness fields
          const rawScope = fm['scope']
          const parsedScope = MEMORY_SCOPES.has(rawScope ?? '')
            ? rawScope as MemoryScope
            : undefined
          const rawConf = fm['confidence']
          const parsedConf = MEMORY_CONFIDENCES.has(rawConf ?? '')
            ? rawConf as MemoryConfidence
            : undefined
          const rawSv = fm['source_verified']
          const parsedSv = rawSv === 'true' ? true : rawSv === 'false' ? false : undefined
          const rawRv = fm['requires_revalidation']
          const parsedRv = rawRv === 'true' ? true : rawRv === 'false' ? false : undefined

          return {
            filename: entry,
            filePath,
            name: fm['name'] ?? entry.replace(/\.md$/, '').replace(/_/g, ' '),
            description: fm['description'] ?? '',
            type: parsedType,
            date: fm['date'],
            campaign: fm['campaign'],
            source: fm['source'],
            mtimeMs: stats.mtimeMs,
            // Scope & freshness
            scope:                parsedScope,
            domain:               fm['domain'],
            validUntil:           fm['valid_until'],
            confidence:           parsedConf,
            sourceVerified:       parsedSv,
            requiresRevalidation: parsedRv,
          }
        } catch {
          return null // Unreadable or malformed file — skip silently
        }
      }),
  )

  return results.filter((h): h is TopicFileHeader => h !== null)
}

// ─────────────────────────────────────────────────────────────────────────────
// Always-relevant type set
// ─────────────────────────────────────────────────────────────────────────────

/** These types are loaded on every turn regardless of query. */
const ALWAYS_RELEVANT: ReadonlySet<MemoryType> = new Set(['user', 'feedback'])

// ─────────────────────────────────────────────────────────────────────────────
// Keyword-based selection (fallback)
// ─────────────────────────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s,.()[\]{}:;'"!?/\\+=<>@#$%^&*|-]+/)
      .filter(t => t.length > 2),
  )
}

function keywordScore(header: TopicFileHeader, queryTokens: Set<string>): number {
  const targetText = `${header.name} ${header.description} ${header.campaign ?? ''} ${header.source ?? ''}`.toLowerCase()
  const targetTokens = tokenize(targetText)
  let score = 0
  for (const qt of queryTokens) {
    if (targetTokens.has(qt)) {
      score += 1
    } else {
      // Partial match: substring overlap
      for (const tt of targetTokens) {
        if (tt.includes(qt) || qt.includes(tt)) {
          score += 0.4
          break
        }
      }
    }
  }
  return score
}

// ─────────────────────────────────────────────────────────────────────────────
// Haiku-based selection (preferred)
// ─────────────────────────────────────────────────────────────────────────────

const RELEVANCE_MODEL = 'claude-haiku-4-5-20251001'

const RELEVANCE_SYSTEM_PROMPT = `\
You are selecting engineering memory files that will be useful to an AI assistant as it processes a user query.

You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected" array of filenames (strings) for memories that will CLEARLY help with this specific query (up to 5).

Rules:
- Include only memories you are certain will help. If unsure, exclude.
- For domain_knowledge: include only when the query needs that specific physical constant, material, or standard.
- For campaign_lessons: include only when the query is about a DOE or campaign problem in the same domain.
- For reference: include only when the query likely needs that external system.
- Do NOT select memories for tools the AI is already actively invoking (those are already in context).
- If no memories would clearly help, return {"selected": []}.

Output format: {"selected": ["filename1.md", "filename2.md"]}`

async function selectByHaiku(
  query: string,
  candidates: TopicFileHeader[],
  client: Anthropic,
): Promise<string[]> {
  if (candidates.length === 0) return []

  const manifest = candidates
    .map(h => `${h.filename}: [${h.type}] ${h.name} — ${h.description}`)
    .join('\n')

  try {
    // 3 s timeout: this is a pre-turn side-call; a hung Haiku request would
    // stall every submit() for up to 600 s (SDK default).  On timeout the
    // catch block falls through to keyword-based selection (Fix #5).
    const msg = await withTimeout(
      client.messages.create({
        model: RELEVANCE_MODEL,
        max_tokens: 256,
        system: RELEVANCE_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Query: ${query}\n\nAvailable memory files:\n${manifest}`,
        }],
      }),
      3_000,
    )

    const raw = msg.content[0]?.type === 'text' ? msg.content[0].text : ''
    const jsonMatch = raw.match(/\{[\s\S]*?\}/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0]) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>)['selected'])
    ) return []

    const validFilenames = new Set(candidates.map(h => h.filename))
    return ((parsed as Record<string, unknown>)['selected'] as unknown[])
      .filter((f): f is string => typeof f === 'string' && validFilenames.has(f))
  } catch {
    // Network error, timeout, malformed output — fall through to keyword match
    return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface FindRelevantMemoriesOptions {
  query: string
  mode?: AgentMode
  memoryDir?: string
  client?: Anthropic
  /** Maximum number of candidate (non-always-relevant) topic files to load. Default: 5 */
  maxCandidates?: number

  // ── Scope & freshness filters ────────────────────────────────────────────
  /**
   * When provided, memories whose `scope` is `project` but whose project tag
   * does not match are excluded.  Pass the current project/campaign identifier.
   * Memories with `scope: 'global'` or no scope are always included.
   */
  projectScope?: string
  /**
   * Current campaign ID.  Memories with `scope: 'campaign'` whose `campaign`
   * field does not match are excluded.
   */
  campaignScope?: string
  /**
   * Current engineering domain.  Memories with `scope: 'domain'` whose
   * `domain` field does not match are excluded.
   */
  domainScope?: string
  /**
   * When true (default), memories whose `valid_until` date is in the past are
   * excluded from recall.  Set to false to include expired memories (e.g., for
   * debugging or explicit "show me all memories" queries).
   */
  filterStale?: boolean
}

// ── Scope/freshness filter predicate ─────────────────────────────────────────

/**
 * Returns true if the header passes all configured scope and freshness filters.
 * "Pass" means: include the file in the recall set.
 */
function _passesFilters(
  header: TopicFileHeader,
  opts: FindRelevantMemoriesOptions,
  nowDate: string,
): boolean {
  // ── Always-relevant types bypass ALL filters ───────────────────────────────
  // user + feedback memories encode the current user's preferences and session
  // feedback — they are session-scoped by definition and must never be silently
  // dropped due to a stale valid_until date or a scope mismatch.
  if (header.type && ALWAYS_RELEVANT.has(header.type)) return true

  // ── Freshness: valid_until ──────────────────────────────────────────────────
  // Default: filter stale memories (filterStale !== false).
  if (opts.filterStale !== false && header.validUntil) {
    // String comparison works for ISO dates (YYYY-MM-DD lexicographic order).
    // valid_until is the LAST VALID day: a memory valid_until 2026-05-18 is still
    // valid on 2026-05-18 but excluded on 2026-05-19 (nowDate > validUntil).
    if (header.validUntil < nowDate) return false
  }

  // ── Scope filtering ────────────────────────────────────────────────────────

  const scope = header.scope ?? 'global'

  if (scope === 'project' && opts.projectScope) {
    // Exclude project-scoped memories from different projects.
    // Project-scoped memories MUST store their project identifier in the
    // frontmatter `campaign:` field.  The `domain:` field is intentionally
    // NOT used as a fallback here — domain tags are independent of project
    // identity and conflating them would silently drop cross-domain memories
    // that happen to share a domain name with a different project.
    const tag = header.campaign ?? ''
    if (tag && tag !== opts.projectScope) return false
  }

  if (scope === 'campaign' && opts.campaignScope) {
    const tag = header.campaign ?? ''
    if (tag && tag !== opts.campaignScope) return false
  }

  if (scope === 'domain' && opts.domainScope) {
    const tag = header.domain ?? ''
    if (tag && tag !== opts.domainScope) return false
  }

  return true
}

/**
 * Find and load the memory files most relevant to the current query.
 *
 * Always loads: user + feedback topic files (small, always applicable).
 * Loads from candidates: domain_knowledge, campaign_lessons, reference files
 *   selected by Haiku side-call (when client provided) or keyword match.
 *
 * Applies scope and freshness filters before selection so stale or out-of-scope
 * memories cannot pollute a long-running task's context.
 *
 * Returns an array of { header, content } objects ready to inject into the
 * system prompt.  Empty array when no memory files exist yet.
 */
export async function findRelevantMemories(
  opts: FindRelevantMemoriesOptions,
): Promise<RelevantMemory[]> {
  const {
    query,
    memoryDir = MEMORY_DIR,
    client,
    maxCandidates = 5,
  } = opts

  const allHeaders = await scanTopicFiles(memoryDir)
  if (allHeaders.length === 0) return []

  // Apply scope and freshness filters before partitioning.
  // ISO date string for "today" — used for valid_until comparisons.
  const nowDate = new Date().toISOString().slice(0, 10)
  const filteredHeaders = allHeaders.filter(h => _passesFilters(h, opts, nowDate))

  // Partition filtered headers: always-relevant vs. query-dependent candidates.
  // user + feedback bypass scope filters (already handled in _passesFilters) but
  // are still subject to valid_until checks.
  const alwaysHeaders = filteredHeaders.filter(h => h.type && ALWAYS_RELEVANT.has(h.type))
  const candidateHeaders = filteredHeaders.filter(h => !ALWAYS_RELEVANT.has(h.type as MemoryType))

  // Select candidates
  let selectedFilenames: string[]
  if (client && query.trim() && candidateHeaders.length > 0) {
    // Preferred: Haiku side-call
    selectedFilenames = await selectByHaiku(query, candidateHeaders, client)
    // Fallback to keyword match if Haiku returned nothing (handles empty query / network failure)
    if (selectedFilenames.length === 0 && query.trim()) {
      selectedFilenames = selectByKeyword(query, candidateHeaders, maxCandidates)
    }
  } else {
    selectedFilenames = selectByKeyword(query, candidateHeaders, maxCandidates)
  }

  const selectedCandidates = candidateHeaders.filter(h =>
    selectedFilenames.includes(h.filename),
  )

  // Load content for all selected files in parallel (P2 fix: was a serial loop)
  const toLoad = [...alwaysHeaders, ...selectedCandidates]
  const settled = await Promise.allSettled(
    toLoad.map(async (header): Promise<RelevantMemory> => {
      const content = await readFile(header.filePath, 'utf-8')
      return { header, content: content.trim() }
    }),
  )

  // Collect fulfilled results; silently skip files that disappeared between
  // scan and load (rejected promise = file gone or permission error).
  const memories: RelevantMemory[] = []
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      memories.push(outcome.value)
    }
  }

  return memories
}

function selectByKeyword(
  query: string,
  candidates: TopicFileHeader[],
  maxCandidates: number,
): string[] {
  if (!query.trim()) return []
  const queryTokens = tokenize(query)
  return candidates
    .map(h => ({ h, score: keywordScore(h, queryTokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates)
    .map(({ h }) => h.filename)
}
