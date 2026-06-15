import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { ExperienceStore } from '../../ExperienceStore.js'
import { validateExperienceInput, type ExperiencePendingStore } from '../../ExperiencePendingStore.js'
import { validatePhysicalAnchorInput, type PhysicalAnchorPendingStore } from '../../PhysicalAnchorPendingStore.js'
import type { PhysicalAnchorStore } from '../../PhysicalAnchorStore.js'
import type { FlashClient } from '../../../core/flash/FlashClient.js'

const MAX_ANCHORS_PER_EXPERIENCE = 2

// ─────────────────────────────────────────────────────────────────────────────
// Flash prompt: combined distillation — one call yields the abstract principle
// (always) AND, strictly, any physical anchor worth preserving (default none).
// ─────────────────────────────────────────────────────────────────────────────

const EXPERIENCE_DISTILL_SYSTEM = `\
You distill one completed robotics experience into reusable knowledge. Return JSON only:
{"abstract_principle": "<one line>", "anchors": [ <0-2 anchors> ]}

abstract_principle — ALWAYS produce one concise, domain-bounded, mechanistic line (the single
most transferable lesson). 1-2 sentences. Capture the root cause/success mechanism, not the
surface symptom.

anchors — DEFAULT to []. Most experiences yield no anchor. Do NOT extract for the sake of it.
An anchor is a CONCRETE device/physics fact an LLM would otherwise ignore or get wrong — a
measured limit, hardware behavior, datasheet/spec value, or reproducible quirk. It is NOT a
transferable mechanism (that is abstract_principle) and NOT a task step.
Add an anchor ONLY when ALL hold:
  - a concrete, specific physical/device fact grounded in THIS experiment's evidence
    (a measurement, observation, or cited spec);
  - it would change future planning or debugging;
  - it is NOT already in the "Known anchors" list below (do not duplicate).
Omit anything vague, speculative, one-off, or common knowledge. Max 2 anchors.
Each anchor: {"title","domain","scope":"global|robot|code","fact","mechanism","implication","confidence_tier":"observed|reproduced|derived|reported|hypothesis","evidence_refs":[]}

Example — anchor: "Go2 actuator latency ≈ 8 ms under load"; principle: "latency must be bounded
relative to control-loop frequency". The first is a concrete fact, the second a rule.`

function hashForCache(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = (h * 33) ^ text.charCodeAt(i)
  }
  return (h >>> 0).toString(36)
}

interface Distillation {
  abstractPrinciple?: string
  anchors: Array<Record<string, unknown>>
}

/**
 * Parse the combined-distillation JSON. Tolerant of code fences and of a bare
 * principle line (legacy/degraded responses): if no JSON object is found but
 * text is present, treat the whole text as the abstract principle with no anchors.
 */
function parseDistillation(raw: string | null): Distillation {
  if (!raw?.trim()) return { anchors: [] }
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return { abstractPrinciple: cleaned.slice(0, 400), anchors: [] }
    const parsed = JSON.parse(match[0]) as unknown
    if (!parsed || typeof parsed !== 'object') return { anchors: [] }
    const obj = parsed as Record<string, unknown>
    const ap = typeof obj['abstract_principle'] === 'string' ? obj['abstract_principle'].trim() : undefined
    const anchors = Array.isArray(obj['anchors'])
      ? obj['anchors'].filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object' && !Array.isArray(a))
      : []
    return { abstractPrinciple: ap || undefined, anchors }
  } catch {
    return { anchors: [] }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param store        The shared cross-session ExperienceStore (NOT written to directly).
 * @param pendingStore Session-scoped buffer — experiences queue here until the
 *                     user reviews and approves them via `/experience review`.
 * @param flash        Optional FlashClient for abstract principle extraction.
 *                     If provided, a 3s flash call extracts the same-domain
 *                     principle at write time.
 */
export function createExperienceWriteTool(
  _store: ExperienceStore,
  pendingStore: ExperiencePendingStore,
  flash?: FlashClient,
  anchorStore?: PhysicalAnchorStore,
  anchorPendingStore?: PhysicalAnchorPendingStore,
): MetaAgentTool {
  return {
    name: 'experience_write',
    description:
      'Propose a new experience entry to the robotics knowledge base. ' +
      'The entry is queued for human review — it will NOT be committed until the user approves it ' +
      'via the `/experience review` command. ' +
      'Call this when an experiment or task reaches a clear conclusion (success OR failure). ' +
      'Do NOT call mid-task or speculatively — wait until you have actionable findings. ' +
      'Failure experiences are especially valuable: always document root cause, invalidated assumptions, and workarounds.',
    inputSchema: {
      type: 'object',
      required: ['domain', 'title', 'problem', 'solution', 'success', 'outcome_summary'],
      properties: {
        domain: {
          type: 'string',
          enum: [
            'motion_planning', 'perception', 'manipulation', 'locomotion',
            'navigation', 'simulation', 'hardware_interface', 'deployment',
            'calibration', 'general',
          ],
          description: 'Primary robotics domain for this experience',
        },
        title: {
          type: 'string',
          description: 'One-line title (≤ 80 chars)',
        },
        problem: {
          type: 'string',
          description: 'What problem was being solved (≤ 500 chars)',
        },
        solution: {
          type: 'string',
          description: 'Key solution steps or insights discovered (≤ 800 chars)',
        },
        success: {
          type: 'boolean',
          description: 'Did the approach succeed?',
        },
        outcome_summary: {
          type: 'string',
          description: 'One-line outcome summary shown in the index (≤ 200 chars)',
        },
        algorithm: {
          type: 'string',
          description: 'Algorithm name if applicable (e.g. "MPC", "RL-PPO", "A-Star")',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lowercase search tags (e.g. ["ros2", "tuning", "slope-terrain"])',
        },
        robot: {
          type: 'string',
          description: 'Robot platform / project name',
        },
        difficulty: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Subjective difficulty level',
        },
        failure_reason: {
          type: 'string',
          description: 'Root cause of failure (if success=false)',
        },
        workarounds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Workarounds or partial solutions discovered',
        },
        metrics: {
          type: 'object',
          description: 'Quantitative results (e.g. {"success_rate": 0.92, "fps": 30})',
        },
        related_papers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Related arXiv IDs or DOIs',
        },
        source_task_id: {
          type: 'string',
          description: 'Sub-agent task ID that produced this experience',
        },
        full_report: {
          type: 'string',
          description: 'Optional full Markdown report (not shown in index; loaded on demand)',
        },
        confidence_tier: {
          type: 'string',
          enum: ['observed', 'reproduced', 'derived', 'reported', 'hypothesis'],
          description: 'Evidence strength. Defaults to observed because experience_write should be used after completed work.',
        },
        evidence_refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Supporting logs, commits, reports, papers, datasheets, or tool outputs',
        },
        observation_count: {
          type: 'number',
          description: 'Independent observations supporting this lesson (default 1)',
        },
        contradiction_count: {
          type: 'number',
          description: 'Later observations contradicting this lesson (default 0)',
        },
        invalidated_assumptions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Prior assumptions shown false by this experience, especially for failures',
        },
        last_verified_at: {
          type: 'number',
          description: 'Unix timestamp in ms when this lesson was last verified',
        },
        principle_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Committed principle IDs (pr_…) this experience applied or tested. ' +
            'Usually empty — set ONLY when a known principle genuinely informed this work, ' +
            'so its outcome can reinforce or challenge that principle. Do not invent IDs.',
        },
        anchor_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Physical anchor IDs (pa_…) this experiment validated or relied on. ' +
            'Usually empty — set ONLY when the experiment genuinely bore on a known physical fact, ' +
            'so its outcome can corroborate or contradict that anchor. Do not invent IDs.',
        },
      },
    },
    async call(input): Promise<ToolResult> {
      try {
        const normalized = validateExperienceInput(input as Record<string, unknown>)
        if (!normalized.ok) {
          return {
            content:
              'experience_write rejected invalid input. Required fields: ' +
              'domain, title, problem, solution, success(boolean), outcome_summary.',
            isError: true,
          }
        }
        const title = normalized.value.title
        const success = normalized.value.success

        // ── Combined distillation via flash (one call) ────────────────────
        // Always yields the abstract principle; strictly yields 0-2 physical
        // anchor candidates. On timeout/error we proceed without either — the
        // experience entry is still useful.
        let abstractPrinciple: string | undefined
        let anchorTitles: string[] = []
        if (flash) {
          // Dedup context: known anchors in this domain so flash won't re-propose.
          let knownAnchors = ''
          if (anchorStore) {
            const existing = await anchorStore
              .search({ domain: normalized.value.domain, robot: normalized.value.robot, limit: 10 })
              .catch(() => [])
            knownAnchors = existing.map(a => `- ${a.title}: ${a.fact.slice(0, 120)}`).join('\n')
          }
          const userContext = [
            `Title: ${title}`,
            `Domain: ${normalized.value.domain}`,
            normalized.value.robot ? `Robot: ${normalized.value.robot}` : '',
            `Outcome: ${success ? 'success' : 'failure'}`,
            `Problem: ${normalized.value.problem.slice(0, 300)}`,
            `Solution: ${normalized.value.solution.slice(0, 400)}`,
            normalized.value.failureReason ? `Failure reason: ${normalized.value.failureReason.slice(0, 200)}` : '',
            '',
            `Known anchors (do not duplicate):\n${knownAnchors || '(none)'}`,
          ].filter(Boolean).join('\n')

          const raw = await flash.query({
            system: EXPERIENCE_DISTILL_SYSTEM,
            user: userContext,
            maxTokens: 600,
            timeoutMs: 30_000,
            cacheKey: `distill:${hashForCache(userContext)}`,
          })
          const distilled = parseDistillation(raw)
          if (distilled.abstractPrinciple) abstractPrinciple = distilled.abstractPrinciple.slice(0, 400)

          // Queue any strict anchor candidates (cap 2) for /anchor review.
          if (anchorPendingStore && distilled.anchors.length > 0) {
            for (const anchor of distilled.anchors.slice(0, MAX_ANCHORS_PER_EXPERIENCE)) {
              const candidate: Record<string, unknown> = {
                domain: anchor['domain'] ?? normalized.value.domain,
                scope: anchor['scope'] ?? 'code',
                title: anchor['title'],
                fact: anchor['fact'],
                mechanism: anchor['mechanism'],
                implication: anchor['implication'],
                confidence_tier: anchor['confidence_tier'] ?? 'observed',
                evidence_refs: anchor['evidence_refs'],
                ...(normalized.value.robot ? { robot: normalized.value.robot } : {}),
              }
              if (!validatePhysicalAnchorInput(candidate).ok) continue
              try {
                anchorPendingStore.add(candidate)
                anchorTitles.push(String(anchor['title']))
              } catch {
                // Queue full or invalid — skip this anchor, keep the experience.
              }
            }
          }
        }

        // ── Queue in pending buffer ───────────────────────────────────────
        const enrichedInput: Record<string, unknown> = {
          ...input as Record<string, unknown>,
          ...(abstractPrinciple ? { abstract_principle: abstractPrinciple } : {}),
        }
        const pendingId = pendingStore.add(enrichedInput)

        return {
          content:
            `⏸  经验已加入待审队列 (pending ID: ${pendingId})\n` +
            `标题: ${title}\n` +
            `结果: ${success ? '✅ 成功' : '❌ 失败'}\n` +
            (abstractPrinciple ? `原理: ${abstractPrinciple}\n` : '') +
            (anchorTitles.length
              ? `物理锚点候选: ${anchorTitles.join('; ')}（已入 /anchor review 队列）\n`
              : '') +
            `\n此条经验不会自动写入共享知识库。\n` +
            `请在对话结束后运行 /experience review 进行审核，` +
            `由你决定是否提交、编辑或丢弃。`,
          isError: false,
        }
      } catch (err) {
        return { content: `experience_write failed: ${String(err)}`, isError: true }
      }
    },
  }
}
