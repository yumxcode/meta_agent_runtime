/**
 * Meta-Agent Memory — per-query topic file relevance selection
 *
 * Architecture mirrors CC's findRelevantMemories.ts:
 *   1. Scan all topic files and extract frontmatter headers
 *   2. Split files into always-relevant (user + feedback) and candidates
 *   3. Select candidates via flash model side-call (when client provided)
 *      or keyword match (fallback)
 *   4. Load and return file content for selected files
 *
 * Differences from CC:
 *   - Uses flash model (not primary model) for relevance — task is simpler, cost lower
 *   - No alreadySurfaced dedup (all injected via system prompt, not per-turn)
 *   - campaign_lessons type: only loaded in campaign mode by default
 *   - robot_lessons type: removed; all robotics experience lives in ExperienceStore
 *   - max 5 candidate files (same as CC)
 */

import { open, readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import type Anthropic from '@anthropic-ai/sdk'
import { MEMORY_DIR, MEMORY_ENTRYPOINT_NAME } from './paths.js'
import { MEMORY_TYPES, type MemoryType } from './types.js'
import type { AgentMode } from '../dynamicPrompt.js'
import { withAbortableTimeout } from '../utils/withTimeout.js'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Valid scope values for memory entries. */
export type MemoryScope = 'global' | 'domain'

const MEMORY_SCOPES: ReadonlySet<string> = new Set<MemoryScope>([
  'global', 'domain',
])
const MAX_TOPIC_FILES_TO_SCAN = 500
const MAX_FRONTMATTER_BYTES = 64 * 1024
const MAX_MEMORY_CONTENT_BYTES = 24 * 1024
const MAX_MEMORY_CONTEXT_BYTES = 64 * 1024

export type TopicFileHeader = {
  filename: string
  filePath: string
  /** From frontmatter `name:` field, or derived from filename */
  name: string
  /** From frontmatter `description:` field */
  description: string
  type: MemoryType | undefined
  date: string | undefined
  source: string | undefined
  mtimeMs: number
  // ── Scope & freshness metadata (optional, parsed from frontmatter) ─────────
  /** Applicability scope.  Defaults to 'global' when absent. */
  scope: MemoryScope | undefined
  /** Engineering domain tag for domain-scoped memories. */
  domain: string | undefined
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

async function readPrefix(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf-8')
  } finally {
    await handle.close()
  }
}

function truncateMemoryContent(content: string): string {
  const bytes = Buffer.byteLength(content, 'utf-8')
  if (bytes <= MAX_MEMORY_CONTENT_BYTES) return content.trim()
  return (
    content.slice(0, MAX_MEMORY_CONTENT_BYTES) +
    `\n\n[Memory file truncated: ${bytes} bytes exceeds ${MAX_MEMORY_CONTENT_BYTES} byte limit.]`
  ).trim()
}

function truncateToBytes(content: string, maxBytes: number, totalBytes: number): string {
  if (Buffer.byteLength(content, 'utf-8') <= maxBytes) return content
  let out = content
  while (Buffer.byteLength(out, 'utf-8') > maxBytes && out.length > 0) {
    out = out.slice(0, Math.floor(out.length * 0.9))
  }
  return (
    out +
    `\n\n[Memory context truncated: total recalled memories exceeded ${totalBytes} byte budget.]`
  ).trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// Topic file scanning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P1-2: header-scan cache, keyed by directory path.
 *
 * Invalidation strategy (two layers, both cheap):
 *   1. Directory mtime — memory files are written via atomic write-then-rename,
 *      and renames into the directory bump its mtime, so create/update/delete
 *      through the runtime are all detected with ONE stat() call.
 *   2. 30 s TTL — covers the one case dir-mtime misses: a file hand-edited
 *      IN PLACE outside the runtime (file mtime changes, dir mtime does not).
 *
 * Race-safety: the cache stores resolved header arrays (never shared mutable
 * state); a concurrent writer simply causes the next call to re-scan.
 */
const SCAN_CACHE_TTL_MS = 30_000
const _scanCache = new Map<string, { dirMtimeMs: number; at: number; headers: TopicFileHeader[] }>()

/** @testonly — drop all cached directory scans. */
export function clearTopicScanCache(): void {
  _scanCache.clear()
}

/**
 * Read all *.md files in the memory directory (excluding MEMORY.md) and
 * extract their frontmatter headers.  Files that cannot be parsed are skipped.
 */
export async function scanTopicFiles(
  memoryDir: string = MEMORY_DIR,
): Promise<TopicFileHeader[]> {
  // P1-2: serve from cache when the directory is unchanged and the TTL is fresh.
  let dirMtimeMs = -1
  try {
    dirMtimeMs = (await stat(memoryDir)).mtimeMs
    const cached = _scanCache.get(memoryDir)
    if (
      cached &&
      cached.dirMtimeMs === dirMtimeMs &&
      Date.now() - cached.at < SCAN_CACHE_TTL_MS
    ) {
      return cached.headers
    }
  } catch {
    // Directory missing/unstatable — fall through; readdir below handles it.
  }

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
      .slice(0, MAX_TOPIC_FILES_TO_SCAN)
      .map(async (entry): Promise<TopicFileHeader | null> => {
        const filePath = join(memoryDir, entry)
        try {
          const [contentPrefix, stats] = await Promise.all([
            readPrefix(filePath, MAX_FRONTMATTER_BYTES),
            stat(filePath),
          ])
          const fm = parseFrontmatter(contentPrefix)
          const rawType = fm['type']
          const parsedType = MEMORY_TYPES.find(t => t === rawType) as MemoryType | undefined

          // Scope & freshness fields
          const rawScope = fm['scope']
          if (rawScope && !MEMORY_SCOPES.has(rawScope)) return null
          // Legacy campaign-specific frontmatter is intentionally unsupported in
          // the generalized memory schema; skipping prevents old files from
          // being treated as global memories.
          if (fm['campaign'] || fm['valid_until'] || fm['confidence']) return null
          const parsedScope = MEMORY_SCOPES.has(rawScope ?? '')
            ? rawScope as MemoryScope
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
            source: fm['source'],
            mtimeMs: stats.mtimeMs,
            // Scope & freshness
            scope:                parsedScope,
            domain:               fm['domain'],
            sourceVerified:       parsedSv,
            requiresRevalidation: parsedRv,
          }
        } catch {
          return null // Unreadable or malformed file — skip silently
        }
      }),
  )

  const headers = results.filter((h): h is TopicFileHeader => h !== null)
  if (dirMtimeMs >= 0) {
    _scanCache.set(memoryDir, { dirMtimeMs, at: Date.now(), headers })
    // Bound: callers only ever use a handful of distinct memory dirs.
    if (_scanCache.size > 8) {
      const oldest = _scanCache.keys().next().value
      if (oldest !== undefined) _scanCache.delete(oldest)
    }
  }
  return headers
}

// ─────────────────────────────────────────────────────────────────────────────
// Always-relevant type set
// ─────────────────────────────────────────────────────────────────────────────

/** These types are loaded on every turn regardless of query. */
const ALWAYS_RELEVANT: ReadonlySet<MemoryType> = new Set(['user', 'feedback'])

/**
 * Maximum number of `feedback` files loaded per turn.
 *
 * `feedback` is always-relevant (no flash filter), so all matching files are
 * loaded unconditionally.  As a session ages, feedback files accumulate and
 * silently inflate per-turn token cost.  Capping at the most recent N entries
 * prevents long-cycle token growth while keeping the highest-signal feedback
 * (most recent corrections) always in context.
 *
 * `user` files are not capped — typically 1-2 files, and user profile is fully
 * stable context that should always be present.
 */
const MAX_FEEDBACK_FILES = 5

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
  const targetText = `${header.name} ${header.description} ${header.domain ?? ''} ${header.source ?? ''}`.toLowerCase()
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
// Flash model selection (preferred)
// ─────────────────────────────────────────────────────────────────────────────

// flashModel is now passed in via opts.client — kept as fallback for callers
// that don't provide a flashModel string.
const RELEVANCE_MODEL_FALLBACK = 'deepseek-v4-flash'

/**
 * Flash relevance-call timeout. Default 3 s; override with
 * META_AGENT_MEMORY_RECALL_TIMEOUT_MS (clamped 500 ms..120 s).
 * Read lazily so tests / startup overrides both work.
 */
const DEFAULT_RECALL_TIMEOUT_MS = 3_000
export function getMemoryRecallTimeoutMs(): number {
  return getRecallTimeoutMs()
}
function getRecallTimeoutMs(): number {
  const raw = process.env['META_AGENT_MEMORY_RECALL_TIMEOUT_MS']
  if (raw === undefined) return DEFAULT_RECALL_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_RECALL_TIMEOUT_MS
  return Math.min(120_000, Math.max(500, parsed))
}

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

async function selectByFlashModel(
  query: string,
  candidates: TopicFileHeader[],
  client: Anthropic,
  flashModel: string = RELEVANCE_MODEL_FALLBACK,
): Promise<string[]> {
  if (candidates.length === 0) return []

  const manifest = candidates
    .map(h => `${h.filename}: [${h.type}] ${h.name} — ${h.description}`)
    .join('\n')

  try {
    // Timeout: this is a pre-turn side-call; a hung flash model request would
    // stall every submit() for up to 600 s (SDK default).  On timeout the
    // catch block falls through to keyword-based selection (Fix #5).
    // Default 3 s; env-tunable because slow providers (first token 15–30 s)
    // may want a longer window — especially now that prefetching overlaps this
    // call with mode detection and session init.
    const msg = await withAbortableTimeout(signal =>
      client.messages.create({
        model: flashModel,
        max_tokens: 256,
        system: RELEVANCE_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Query: ${query}\n\nAvailable memory files:\n${manifest}`,
        }],
      }, { signal }),
      getRecallTimeoutMs(),
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

  // ── Scope filters ────────────────────────────────────────────────────────
  /**
   * Current engineering domain.  Memories with `scope: 'domain'` whose
   * `domain` field does not match are excluded.
   */
  domainScope?: string
  /**
   * Current session mode.  Used to exclude mode-irrelevant memory types:
   *   - 'campaign': includes campaign_lessons (excluded in all other modes)
   *   - 'robotics' / 'agentic': excludes campaign_lessons
   * Prevents cross-mode memory contamination (e.g. battery DOE lessons appearing
   * in a robotics session).  Note: robot_lessons has been removed — all robotics
   * experience is stored in ExperienceStore, not in memory.
   */
  sessionMode?: string
  /**
   * Flash model identifier to use for relevance selection.
   * Defaults to RELEVANCE_MODEL_FALLBACK when omitted.
   * Pass detectProvider(config).flashModel for correct provider routing.
   */
  flashModel?: string
}

// ── Scope/freshness filter predicate ─────────────────────────────────────────

/**
 * Returns true if the header passes all configured scope and freshness filters.
 * "Pass" means: include the file in the recall set.
 */
function _passesFilters(
  header: TopicFileHeader,
  opts: FindRelevantMemoriesOptions,
): boolean {
  // ── Always-relevant types bypass ALL filters ───────────────────────────────
  // user + feedback memories encode the current user's preferences and session
  // feedback — they are session-scoped by definition and must never be silently
  // dropped due to a scope mismatch.
  if (header.type && ALWAYS_RELEVANT.has(header.type)) return true

  // ── Scope filtering ────────────────────────────────────────────────────────

  const scope = header.scope ?? 'global'

  if (scope === 'domain' && opts.domainScope) {
    const tag = header.domain ?? ''
    if (tag && tag !== opts.domainScope) return false
  }

  // ── Session-mode filtering ────────────────────────────────────────────────
  // Memory now only contains 'user' and 'feedback' types, both of which are
  // always relevant regardless of mode. No cross-mode filtering needed.

  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-1: single-flight prefetch
//
// The memory recall (flash side-call + file loads) sits on the critical path
// between the user pressing Enter and the first main-model token. Callers that
// know the query EARLY (SessionRouter.submit, before mode detection and
// backend init) can start the recall immediately; when the D1b prompt section
// later calls findRelevantMemories() with the same query, it consumes the
// in-flight promise instead of starting over — overlapping recall latency
// with mode detection / session construction.
//
// Race-safety contract:
//   - Single-flight: a second prefetch for the same (query, memoryDir) is a
//     no-op while one is pending/unconsumed.
//   - Consume-once: findRelevantMemories() DELETES the entry before awaiting,
//     so a memory write later in the same turn can never be masked by a stale
//     cached recall on the next turn.
//   - Compatibility check: the consumer's options must match the prefetch's
//     options on every field that influences the result (memoryDir,
//     domainScope, maxCandidates, flashModel, client presence). On mismatch
//     the prefetched value is discarded and a fresh recall runs — correctness
//     never depends on the prefetch.  NOTE: sessionMode/mode is intentionally
//     EXCLUDED from this check — it does not affect recall output today
//     (see _passesFilters). If that ever changes, add it to _compatOf().
//   - Failure isolation: a rejected prefetch promise is observed immediately
//     (no unhandledRejection) and the consumer falls back to a fresh recall.
// ─────────────────────────────────────────────────────────────────────────────

interface PrefetchEntry {
  compat: string
  promise: Promise<RelevantMemory[]>
  createdAt: number
}

const PREFETCH_TTL_MS = 60_000
const PREFETCH_MAX_ENTRIES = 8
const _prefetchCache = new Map<string, PrefetchEntry>()

function _prefetchKey(opts: FindRelevantMemoriesOptions): string {
  return `${opts.query.trim()} ${opts.memoryDir ?? MEMORY_DIR}`
}

/** Serialise every option that influences the recall RESULT (see contract above). */
function _compatOf(opts: FindRelevantMemoriesOptions): string {
  return JSON.stringify({
    domainScope: opts.domainScope ?? null,
    maxCandidates: opts.maxCandidates ?? 5,
    flashModel: opts.flashModel ?? null,
    hasClient: Boolean(opts.client),
  })
}

/**
 * Start a memory recall in the background for `opts.query`. Fire-and-forget;
 * never throws. The result is picked up by the next findRelevantMemories()
 * call with a matching query (see contract above).
 */
export function prefetchRelevantMemories(opts: FindRelevantMemoriesOptions): void {
  try {
    if (!opts.query.trim()) return
    const key = _prefetchKey(opts)
    if (_prefetchCache.has(key)) return  // single-flight
    const promise = _findRelevantMemoriesFresh(opts)
    // Observe rejection so an unconsumed failed prefetch never surfaces as an
    // unhandledRejection (the CLI treats those as fatal).
    promise.catch(() => undefined)
    _prefetchCache.set(key, { compat: _compatOf(opts), promise, createdAt: Date.now() })
    // Bound the cache: evict oldest entries beyond the cap.
    while (_prefetchCache.size > PREFETCH_MAX_ENTRIES) {
      const oldest = _prefetchCache.keys().next().value
      if (oldest === undefined) break
      _prefetchCache.delete(oldest)
    }
  } catch {
    // Prefetch is best-effort by definition.
  }
}

/** @testonly — drop all prefetched entries. */
export function clearMemoryPrefetchCache(): void {
  _prefetchCache.clear()
}

/**
 * Find and load the memory files most relevant to the current query.
 *
 * Always loads: user + feedback topic files (small, always applicable).
 * Loads from candidates: domain_knowledge, campaign_lessons, reference files
 *   selected by flash model side-call (when client provided) or keyword match.
 *
 * Applies scope and mode filters before selection so out-of-scope memories
 * cannot pollute a long-running task's context.
 *
 * Consumes a matching prefetchRelevantMemories() result when one is in flight
 * (P0-1); otherwise computes fresh.
 *
 * Returns an array of { header, content } objects ready to inject into the
 * system prompt.  Empty array when no memory files exist yet.
 */
export async function findRelevantMemories(
  opts: FindRelevantMemoriesOptions,
): Promise<RelevantMemory[]> {
  const key = _prefetchKey(opts)
  const entry = _prefetchCache.get(key)
  if (entry) {
    // Consume-once: remove BEFORE awaiting so concurrent consumers and
    // subsequent turns always trigger a fresh recall.
    _prefetchCache.delete(key)
    if (
      Date.now() - entry.createdAt < PREFETCH_TTL_MS &&
      entry.compat === _compatOf(opts)
    ) {
      try {
        return await entry.promise
      } catch {
        // Prefetch failed (network, timeout edge…) — fall through to fresh.
      }
    }
  }
  return _findRelevantMemoriesFresh(opts)
}

async function _findRelevantMemoriesFresh(
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

  // Apply scope and mode filters before partitioning.
  const filteredHeaders = allHeaders.filter(h => _passesFilters(h, opts))

  // Partition filtered headers: always-relevant vs. query-dependent candidates.
  // user + feedback bypass scope filters (already handled in _passesFilters).
  const alwaysHeadersRaw = filteredHeaders.filter(h => h.type && ALWAYS_RELEVANT.has(h.type))
  const candidateHeaders = filteredHeaders.filter(h => !ALWAYS_RELEVANT.has(h.type as MemoryType))

  // Apply per-type caps to always-relevant headers to prevent silent token growth.
  // `feedback` is capped at MAX_FEEDBACK_FILES most-recent entries (sorted by mtime desc).
  // `user` is uncapped — typically 1-2 files and essential for calibration.
  const alwaysHeaders = alwaysHeadersRaw.reduce<TopicFileHeader[]>((acc, h) => {
    if (h.type === 'feedback') {
      const existing = acc.filter(x => x.type === 'feedback')
      if (existing.length >= MAX_FEEDBACK_FILES) {
        // Already have the max; keep only if this file is newer than the oldest one
        const oldestIdx = existing.reduce(
          (minIdx, x, i, arr) => x.mtimeMs < arr[minIdx].mtimeMs ? i : minIdx,
          0,
        )
        const oldest = existing[oldestIdx]
        if (h.mtimeMs > oldest.mtimeMs) {
          // Replace oldest with this newer file
          return acc.map(x => x === oldest ? h : x)
        }
        return acc   // this file is older than all we already have — skip
      }
    }
    acc.push(h)
    return acc
  }, [])

  // Select candidates
  let selectedFilenames: string[]
  if (candidateHeaders.length <= maxCandidates) {
    // P0-2: small memory library — every candidate fits within the injection
    // limit anyway, so the flash relevance call cannot reduce the set further.
    // Skip the side-call entirely (saves an LLM round-trip on the critical
    // path for the common small-library case). The total-byte budget below
    // still bounds prompt growth.
    selectedFilenames = candidateHeaders.map(h => h.filename)
  } else if (client && query.trim()) {
    // Preferred: flash model side-call
    selectedFilenames = await selectByFlashModel(query, candidateHeaders, client, opts.flashModel)
    // Fallback to keyword match if flash model returned nothing (handles empty query / network failure)
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
      return { header, content: truncateMemoryContent(content) }
    }),
  )

  // Collect fulfilled results under a total byte budget; silently skip files
  // that disappeared between scan and load (rejected promise = file gone or
  // permission error). This prevents a few large always-relevant memories from
  // silently dominating every turn's prompt.
  const memories: RelevantMemory[] = []
  let usedBytes = 0
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      const bytes = Buffer.byteLength(outcome.value.content, 'utf-8')
      const remaining = MAX_MEMORY_CONTEXT_BYTES - usedBytes
      if (remaining <= 1024) continue
      if (bytes > remaining) {
        memories.push({
          ...outcome.value,
          content: truncateToBytes(outcome.value.content, remaining, MAX_MEMORY_CONTEXT_BYTES),
        })
        break
      }
      memories.push(outcome.value)
      usedBytes += bytes
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
