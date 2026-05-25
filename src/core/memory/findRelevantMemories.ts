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
 *   - robot_lessons type: only loaded in robotics mode by default
 *   - max 5 candidate files (same as CC)
 */

import { open, readdir, readFile, stat } from 'fs/promises'
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
export type MemoryScope = 'global' | 'domain'

const MEMORY_SCOPES: ReadonlySet<string> = new Set<MemoryScope>([
  'global', 'domain',
])
const MAX_TOPIC_FILES_TO_SCAN = 500
const MAX_FRONTMATTER_BYTES = 64 * 1024
const MAX_MEMORY_CONTENT_BYTES = 100 * 1024

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
// Haiku-based selection (preferred)
// ─────────────────────────────────────────────────────────────────────────────

const RELEVANCE_MODEL = 'deepseek-v4-flash'

const RELEVANCE_SYSTEM_PROMPT = `\
You are selecting engineering memory files that will be useful to an AI assistant as it processes a user query.

You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected" array of filenames (strings) for memories that will CLEARLY help with this specific query (up to 5).

Rules:
- Include only memories you are certain will help. If unsure, exclude.
- For domain_knowledge: include only when the query needs that specific physical constant, material, or standard.
- For campaign_lessons: include only when the query is about a DOE or campaign problem in the same domain.
- For robot_lessons: include only when the query is about a robotics problem or robot-mode failure/warning in the same domain.
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

  // ── Scope filters ────────────────────────────────────────────────────────
  /**
   * Current engineering domain.  Memories with `scope: 'domain'` whose
   * `domain` field does not match are excluded.
   */
  domainScope?: string
  /**
   * Current session mode.  Used to exclude mode-irrelevant memory types:
   *   - 'robotics': excludes campaign_lessons; includes robot_lessons
   *   - 'campaign': excludes robot_lessons; includes campaign_lessons
   *   - 'agentic': excludes both mode-specific lesson types
   * Prevents cross-mode memory contamination (e.g. battery DOE lessons appearing
   * in a humanoid robot session).
   */
  sessionMode?: string
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

  // ── Session-mode filtering: prevent cross-mode contamination ──────────────
  if (header.type === 'campaign_lessons' && opts.sessionMode !== 'campaign') return false
  if (header.type === 'robot_lessons' && opts.sessionMode !== 'robotics') return false

  return true
}

/**
 * Find and load the memory files most relevant to the current query.
 *
 * Always loads: user + feedback topic files (small, always applicable).
 * Loads from candidates: domain_knowledge, campaign_lessons, robot_lessons, reference files
 *   selected by Haiku side-call (when client provided) or keyword match.
 *
 * Applies scope and mode filters before selection so out-of-scope memories
 * cannot pollute a long-running task's context.
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

  // Apply scope and mode filters before partitioning.
  const filteredHeaders = allHeaders.filter(h => _passesFilters(h, opts))

  // Partition filtered headers: always-relevant vs. query-dependent candidates.
  // user + feedback bypass scope filters (already handled in _passesFilters).
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
      return { header, content: truncateMemoryContent(content) }
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
