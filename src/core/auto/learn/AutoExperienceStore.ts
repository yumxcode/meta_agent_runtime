/**
 * AutoExperienceStore — the "Learn" persistence for auto mode.
 *
 * Reuses the robotics ExperienceStore machinery (JSON-per-entry + index +
 * recency ranking) rather than forking it, but points it at an auto-scoped
 * directory and tags every entry with domain 'general' so auto/code lessons and
 * robotics lessons never bleed into each other's recall.
 *
 * Two halves of the learn loop live here:
 *   • WRITE  — the drift agent calls `experience_write` (direct, NOT queued for
 *              human review — auto is unattended) to persist a lesson grounded
 *              in a concrete failure signal.
 *   • RECALL — `renderRecentExperiences` produces a compact prompt block the
 *              main agent sees, so prior pitfalls inform the next attempt.
 *
 * The store is unconditionally local I/O (no model calls), so recall on every
 * turn is cheap and write is synchronous-ish.
 */
import { join } from 'path'
import { ExperienceStore } from '../../../robotics/ExperienceStore.js'
import type { MetaAgentTool, ToolResult } from '../../types.js'

/** Auto experiences live under the project so they're per-workspace + inspectable. */
export function autoExperienceDir(projectDir: string): string {
  return join(projectDir, '.meta-agent', 'auto', 'experience')
}

export function createAutoExperienceStore(projectDir: string): ExperienceStore {
  return new ExperienceStore(autoExperienceDir(projectDir))
}

/** How many recent experiences to surface to the main agent each turn. */
const RECALL_LIMIT = 8

/**
 * Render the most relevant recent experiences as a system-prompt block, or null
 * when the store is empty. Failures are surfaced first (pitfalls to avoid carry
 * the most signal), then successes, capped at RECALL_LIMIT.
 */
export async function renderRecentExperiences(
  store: ExperienceStore,
  limit: number = RECALL_LIMIT,
): Promise<string | null> {
  let entries
  try {
    entries = await store.search({ limit: 20 })   // store caps at 20
  } catch {
    return null
  }
  if (!entries.length) return null

  // Failures first (avoid-pitfall lessons), then successes; newest within each.
  const ranked = [...entries].sort((a, b) => {
    const af = a.outcome.success ? 1 : 0
    const bf = b.outcome.success ? 1 : 0
    if (af !== bf) return af - bf
    return b.createdAt - a.createdAt
  }).slice(0, limit)

  const lines = ranked.map(e => {
    const tag = e.outcome.success ? '✓成功' : '✗失败'
    const principle = e.abstractPrinciple ?? e.outcome.summary
    const cause = !e.outcome.success && e.outcome.failureReason ? `（根因：${e.outcome.failureReason}）` : ''
    return `- [${tag}] ${e.title}：${principle}${cause}`
  })

  return (
    '[过往经验·参考] 以下是本工作区累积的经验教训（失败优先，用于避免重复踩坑）。' +
    '仅作参考，与当前实际情况冲突时以实际为准：\n' +
    lines.join('\n')
  )
}

/** Inputs accepted by the direct auto experience write. */
interface AutoExperienceInput {
  title: string
  problem: string
  solution: string
  success: boolean
  outcome_summary: string
  /** Where the lesson came from — the soft-but-required provenance (see rubric). */
  error_source?: string
  abstract_principle?: string
  failure_reason?: string
  workarounds?: string[]
  evidence?: string[]
  tags?: string[]
}

/** Persist an auto experience directly (no pending-review queue). Returns the id. */
export async function writeAutoExperience(
  store: ExperienceStore,
  input: AutoExperienceInput,
  sourceSessionId?: string,
): Promise<string> {
  // Fold the provenance note into evidenceRefs so it's always retained.
  const evidenceRefs = [
    ...(input.error_source ? [`source: ${input.error_source}`] : []),
    ...(input.evidence ?? []),
  ]
  return store.write({
    domain: 'general',
    tags: input.tags ?? [],
    difficulty: 'medium',
    title: input.title.slice(0, 80),
    problem: input.problem.slice(0, 500),
    solution: input.solution.slice(0, 800),
    outcome: {
      success: input.success,
      summary: input.outcome_summary.slice(0, 200),
      failureReason: input.failure_reason,
      workarounds: input.workarounds,
    },
    abstractPrinciple: input.abstract_principle,
    confidenceTier: 'observed',
    evidenceRefs: evidenceRefs.length ? evidenceRefs : undefined,
    sourceSessionId,
  })
}

/**
 * The `experience_write` tool handed ONLY to the drift agent. Unlike the
 * robotics tool (which queues to a human-review buffer), this writes straight to
 * the store — auto runs unattended. The strict "must cite an error source"
 * requirement is a SOFT constraint enforced via the drift rubric (by design),
 * not a hard schema rejection; error_source maps into evidenceRefs when given.
 */
export function createAutoExperienceWriteTool(
  store: ExperienceStore,
  sourceSessionId?: string,
): MetaAgentTool {
  return {
    name: 'experience_write',
    description:
      '将一条经过验证的经验教训写入本工作区的经验库（无人值守，直接落盘）。' +
      '仅在你有明确证据时调用：必须在 error_source 中注明这条经验的来源' +
      '（严重偏离目标的具体表现、verify 拒绝项、或明确的执行失败/退出码）。' +
      '没有确凿来源就不要写，避免污染经验库。',
    inputSchema: {
      type: 'object',
      required: ['title', 'problem', 'solution', 'success', 'outcome_summary', 'error_source'],
      properties: {
        title: { type: 'string', description: '一句话标题（≤80 字）' },
        problem: { type: 'string', description: '当时要解决的问题（≤500 字）' },
        solution: { type: 'string', description: '关键解法/教训（≤800 字）' },
        success: { type: 'boolean', description: '该做法是否成功' },
        outcome_summary: { type: 'string', description: '一句话结论（≤200 字）' },
        error_source: {
          type: 'string',
          description: '【必填】这条经验的确凿来源：偏离目标的具体表现、verify 拒绝项、或失败命令+退出码。',
        },
        abstract_principle: { type: 'string', description: '可复用的抽象原则（1-2 句）' },
        failure_reason: { type: 'string', description: '失败根因（success=false 时）' },
        workarounds: { type: 'array', items: { type: 'string' }, description: '有效的规避/补救做法' },
        evidence: { type: 'array', items: { type: 'string' }, description: '补充证据引用（file:line / 日志 / 命令）' },
        tags: { type: 'array', items: { type: 'string' }, description: '小写检索标签' },
      },
    },
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      const title = String(input['title'] ?? '').trim()
      const errorSource = String(input['error_source'] ?? '').trim()
      if (!title) return { content: 'Error: title is required', isError: true }
      // Soft guard: the rubric demands an error source; we nudge but still record
      // when present. (Absence is allowed by the tool but discouraged by prompt.)
      try {
        const id = await writeAutoExperience(
          store,
          {
            title,
            problem: String(input['problem'] ?? ''),
            solution: String(input['solution'] ?? ''),
            success: Boolean(input['success']),
            outcome_summary: String(input['outcome_summary'] ?? ''),
            error_source: errorSource || undefined,
            abstract_principle: input['abstract_principle'] ? String(input['abstract_principle']) : undefined,
            failure_reason: input['failure_reason'] ? String(input['failure_reason']) : undefined,
            workarounds: Array.isArray(input['workarounds']) ? (input['workarounds'] as unknown[]).map(String) : undefined,
            evidence: Array.isArray(input['evidence']) ? (input['evidence'] as unknown[]).map(String) : undefined,
            tags: Array.isArray(input['tags']) ? (input['tags'] as unknown[]).map(String) : undefined,
          },
          sourceSessionId,
        )
        return { content: `Experience recorded: ${id}`, isError: false }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `Error writing experience: ${msg}`, isError: true }
      }
    },
  }
}
