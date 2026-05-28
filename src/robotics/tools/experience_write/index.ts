import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { ExperienceStore } from '../../ExperienceStore.js'
import { validateExperienceInput, type ExperiencePendingStore } from '../../ExperiencePendingStore.js'
import type { FlashClient } from '../../../core/flash/FlashClient.js'

// ─────────────────────────────────────────────────────────────────────────────
// Flash prompt: extract same-domain abstract principle
// ─────────────────────────────────────────────────────────────────────────────

const PRINCIPLE_SYSTEM = `\
Extract the single most transferable abstract principle from a robotics experiment.

The principle should be:
- Domain-bounded: transferable within the same robotics domain, without forcing cross-domain generalization
- Mechanistic: capture the root cause or success mechanism, not the surface symptom
- Concise: 1-2 sentences maximum

Examples of good principles:
- "Spatial resolution × map size × branching factor determines peak memory; estimate before coding."
- "Algorithm latency must be bounded relative to control loop frequency; otherwise state estimation diverges."
- "Sim-to-real gap is largest for contact-rich or high-frequency tasks; validate with real hardware at first milestone."
- "Gradient-based optimizers diverge when reward scale differs by orders of magnitude across terms; normalize first."

Return only the principle text. No JSON, no explanation, no preamble.`

function hashForCache(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = (h * 33) ^ text.charCodeAt(i)
  }
  return (h >>> 0).toString(36)
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

        // ── Extract abstract principle via flash (3 s timeout) ────────────
        // The principle supports same-domain matching in ExperiencePatternChecker.
        // On timeout or error we proceed without it — the entry is still useful.
        let abstractPrinciple: string | undefined
        if (flash) {
          const userContext = [
            `Title: ${title}`,
            `Domain: ${normalized.value.domain}`,
            `Outcome: ${success ? 'success' : 'failure'}`,
            `Problem: ${normalized.value.problem.slice(0, 300)}`,
            `Solution: ${normalized.value.solution.slice(0, 400)}`,
            normalized.value.failureReason ? `Failure reason: ${normalized.value.failureReason.slice(0, 200)}` : '',
          ].filter(Boolean).join('\n')

          const raw = await flash.query({
            system: PRINCIPLE_SYSTEM,
            user: userContext,
            maxTokens: 120,
            timeoutMs: 3_000,
            cacheKey: `principle:${hashForCache(userContext)}`,
          })
          if (raw?.trim()) abstractPrinciple = raw.trim().slice(0, 400)
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
