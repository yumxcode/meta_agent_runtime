/**
 * Post-session memory writer.
 *
 * Runs a small flash model side-call at session shutdown to decide whether the
 * conversation contains public, mode-wide memories worth persisting.  The model
 * returns structured proposals only; this module performs all filesystem writes
 * so frontmatter stays constrained and mode boundaries are enforced.
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { buildAnthropicAuth } from '../../kernel/api/AnthropicClient.js'
import { getModelProtocol } from '../../providers/registry.js'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { ConversationMessage, ContentBlock } from '../types.js'
import type { AgentMode } from '../dynamicPrompt.js'
import { ensureMemoryDirExists, loadMemoryIndex } from './memdir.js'
import { MEMORY_DIR, MEMORY_ENTRYPOINT_NAME } from './paths.js'
import { allowedTypesForMode, normalizeMemoryProposal, type RawMemoryProposal } from './memoryProposal.js'
import { ensureMemoryPendingLoaded, getMemoryPendingStore, type MemoryPendingStore } from './MemoryPendingStore.js'

/**
 * Default model for the post-session memory writer side-call.
 * Callers can override via RunMemoryWriterOptions.model.
 *
 * Falls back to DeepSeek flash if no model is specified — it is inexpensive
 * and well-suited for the structured-JSON extraction task.  If the caller uses
 * a pure-Anthropic configuration they should pass `model: resolvedConfig.flashModel`
 * so the writer uses the same provider as the rest of the session.
 */
const DEFAULT_MEMORY_WRITER_MODEL = 'deepseek-v4-flash'
const MAX_TRANSCRIPT_CHARS = 32_000
const MAX_EXISTING_INDEX_CHARS = 8_000
const MAX_MEMORIES_PER_RUN = 3

export type MemoryWriteResult = {
  attempted: boolean
  /** Pending IDs queued for review (NOT written to disk directly). */
  queued: string[]
  skipped: string[]
}

export interface RunMemoryWriterOptions {
  client?: Anthropic | null
  mode: AgentMode | string
  domain?: string
  messages: readonly ConversationMessage[]
  memoryDir?: string
  /**
   * Model to use for the post-session memory writer side-call.
   *
   * Defaults to `DEFAULT_MEMORY_WRITER_MODEL` ('deepseek-v4-flash').
   * Pass `resolvedConfig.flashModel` (e.g. 'claude-haiku-4-5') when the
   * session uses a pure-Anthropic configuration without a DeepSeek API key,
   * otherwise the side-call will fail silently and no memories will be written.
   */
  model?: string
  /** API key/baseURL used when the memory writer must create its own side-call client. */
  apiKey?: string
  baseURL?: string
  /**
   * Pending-review queue the auto-writer enqueues proposals into.
   * Defaults to the process-wide global store.  Proposals are NEVER written to
   * disk here — the user commits them via `/memory review`.
   */
  pendingStore?: MemoryPendingStore
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function textFromBlocks(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool_use') return `[tool_use ${block.name}] ${JSON.stringify(block.input)}`
      if (block.type === 'tool_result') return `[tool_result] ${block.content}`
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function buildTranscript(messages: readonly ConversationMessage[]): string {
  const lines = messages.map((msg, i) => {
    const text = textFromBlocks(msg.content).trim()
    if (!text) return ''
    return `### ${i + 1}. ${msg.role}\n${text}`
  }).filter(Boolean)

  const full = lines.join('\n\n')
  if (full.length <= MAX_TRANSCRIPT_CHARS) return full
  return full.slice(full.length - MAX_TRANSCRIPT_CHARS)
}

function extractJson(raw: string): unknown {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

function buildSystemPrompt(mode: string): string {
  return `You are a post-session memory curator for meta-agent-runtime.

Decide whether the session contains durable public memories worth saving.

Write memories only when they satisfy ALL criteria:
- Useful for future sessions in the same mode, not just this conversation.
- Public/general enough to apply across sessions.
- Specific enough to be searchable and actionable.
- Not already covered by the existing MEMORY.md index.

Mode-specific boundaries:
- campaign: do NOT save simulation/computation results, active campaign state, or project-specific parameters. Those belong to provenance, campaign_context, and campaign config.
- robotics: do NOT save mature engineering experience, workflows, tuning recipes, or reusable technical knowledge. Those belong to ExperienceStore. Save only public preferences, warnings, repeated mistakes, or risk checks.
- direct/agentic: do NOT save mode-specific campaign or robotics lessons.

Allowed memory types for this mode (${mode}): ${[...allowedTypesForMode(mode)].join(', ')}.

Frontmatter must NOT include campaign, valid_until, or confidence.

Return JSON only:
{"memories":[{"filename":"short_slug.md","name":"...","description":"...","type":"...","domain":"optional","source":"optional","source_verified":true,"requires_revalidation":false,"body":"markdown body","index_line":"- [Name](short_slug.md) - short hook"}]}

If nothing is worth saving, return {"memories":[]}.`
}

export async function runPostSessionMemoryWriter(
  opts: RunMemoryWriterOptions,
): Promise<MemoryWriteResult> {
  const {
    client,
    mode,
    domain,
    messages,
    memoryDir = MEMORY_DIR,
    model = DEFAULT_MEMORY_WRITER_MODEL,
    apiKey,
    baseURL,
  } = opts
  // When the caller doesn't supply a store, use the process-wide global one and
  // make sure its persisted entries are loaded — otherwise an empty in-memory
  // array would clobber pending entries already on disk on the next persist.
  const pendingStore = opts.pendingStore ?? getMemoryPendingStore()
  if (!opts.pendingStore) await ensureMemoryPendingLoaded()
  if (messages.length === 0) {
    return { attempted: false, queued: [], skipped: ['no_messages'] }
  }

  if (memoryDir === MEMORY_DIR) await ensureMemoryDirExists()
  else await mkdir(memoryDir, { recursive: true })
  let existingIndex = ''
  try {
    const rawIndex = memoryDir === MEMORY_DIR
      ? await loadMemoryIndex()
      : await readFile(join(memoryDir, MEMORY_ENTRYPOINT_NAME), 'utf-8')
    existingIndex = rawIndex?.slice(0, MAX_EXISTING_INDEX_CHARS) ?? ''
  } catch {
    // MEMORY.md does not exist yet (new workspace) — treat as empty index.
    existingIndex = ''
  }
  const transcript = buildTranscript(messages)
  if (!transcript.trim()) {
    return { attempted: false, queued: [], skipped: ['empty_transcript'] }
  }

  const userContent = [
    `Mode: ${mode}`,
    `Domain: ${domain ?? 'generic'}`,
    '',
    'Existing MEMORY.md index:',
    existingIndex || '(empty)',
    '',
    'Session transcript:',
    transcript,
  ].join('\n')

  const raw = await callMemoryWriterModel({
    client,
    model,
    apiKey,
    baseURL,
    system: buildSystemPrompt(mode),
    user: userContent,
  })
  if (!raw.trim()) {
    return { attempted: true, queued: [], skipped: ['empty_model_response'] }
  }
  const parsed = extractJson(raw)
  const proposals = Array.isArray((parsed as { memories?: unknown } | null)?.memories)
    ? ((parsed as { memories: unknown[] }).memories as RawMemoryProposal[])
    : []

  const queued: string[] = []
  const skipped: string[] = []
  const indexToCheck = existingIndex

  // Snapshot already-pending filenames so the auto-writer doesn't enqueue a
  // near-duplicate of something awaiting review.
  const pendingFilenames = new Set(pendingStore.list().map(p => p.proposal.filename))

  for (const rawProposal of proposals.slice(0, MAX_MEMORIES_PER_RUN)) {
    const proposal = normalizeMemoryProposal(rawProposal, mode, domain)
    if (!proposal) {
      skipped.push('invalid_proposal')
      continue
    }
    // Skip if already committed (present in MEMORY.md index) …
    if (indexToCheck.includes(`](${proposal.filename})`) || indexToCheck.includes(proposal.name)) {
      skipped.push(`duplicate:${proposal.filename}`)
      continue
    }
    // … or if an on-disk file already exists …
    const target = join(memoryDir, proposal.filename)
    try {
      await readFile(target, 'utf-8')
      skipped.push(`exists:${proposal.filename}`)
      continue
    } catch {
      // File does not exist; proceed.
    }
    // … or if an equivalent proposal is already pending review.
    if (pendingFilenames.has(proposal.filename)) {
      skipped.push(`pending:${proposal.filename}`)
      continue
    }

    // Queue for human review instead of writing directly.
    try {
      const pendingId = pendingStore.add(proposal, 'auto')
      pendingFilenames.add(proposal.filename)
      queued.push(pendingId)
    } catch {
      skipped.push('queue_full')
    }
  }

  return { attempted: true, queued, skipped }
}

async function callMemoryWriterModel(opts: {
  client?: Anthropic | null
  model: string
  apiKey?: string
  baseURL?: string
  system: string
  user: string
}): Promise<string> {
  if (getModelProtocol(opts.model, opts.baseURL) === 'openai') {
    const client = new OpenAI({
      apiKey: opts.apiKey ?? process.env['DEEPSEEK_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'],
      baseURL: opts.baseURL ?? 'https://api.deepseek.com',
      maxRetries: 1,
      timeout: 30_000,
    })
    const response = await withTimeout(
      client.chat.completions.create({
        model: opts.model,
        max_tokens: 1800,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      }),
      30_000,
    )
    return response.choices[0]?.message?.content ?? ''
  }

  const anthropicClient = opts.client ?? (
    opts.apiKey
      ? new Anthropic({
          ...buildAnthropicAuth(opts.apiKey, opts.baseURL),
          baseURL: opts.baseURL,
          maxRetries: 1,
        })
      : null
  )
  if (!anthropicClient) return ''
  const response = await withTimeout(
    anthropicClient.messages.create({
      model: opts.model,
      max_tokens: 1800,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
    }),
    30_000,
  )

  return response.content[0]?.type === 'text' ? response.content[0].text : ''
}
