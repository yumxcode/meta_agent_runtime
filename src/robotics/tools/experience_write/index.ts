import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { ExperienceStore } from '../../ExperienceStore.js'
import type { ExperiencePendingStore } from '../../ExperiencePendingStore.js'
import type { RoboticsDomain } from '../../types.js'

/**
 * @param store        The shared cross-session ExperienceStore (NOT written to directly).
 * @param pendingStore Session-scoped buffer — experiences queue here until the
 *                     user reviews and approves them via `/experience review`.
 *                     This prevents premature or low-quality entries from
 *                     polluting the shared knowledge base.
 */
export function createExperienceWriteTool(
  store: ExperienceStore,
  pendingStore: ExperiencePendingStore,
): MetaAgentTool {
  return {
    name: 'experience_write',
    description:
      'Propose a new experience entry to the robotics knowledge base. ' +
      'The entry is queued for human review — it will NOT be committed until the user approves it ' +
      'via the `/experience review` command. ' +
      'Call this when an experiment or task reaches a clear conclusion (success OR failure). ' +
      'Do NOT call mid-task or speculatively — wait until you have actionable findings. ' +
      'Failure experiences are especially valuable: always document root cause and workarounds.',
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
      },
    },
    async call(input): Promise<ToolResult> {
      try {
        // Queue in pending buffer — NOT committed to shared store yet.
        // The user must review and approve via `/experience review`.
        const pendingId = pendingStore.add(input as Record<string, unknown>)
        const title = String(input['title'] ?? '(untitled)')
        const success = Boolean(input['success'])
        return {
          content:
            `⏸  经验已加入待审队列 (pending ID: ${pendingId})\n` +
            `标题: ${title}\n` +
            `结果: ${success ? '✅ 成功' : '❌ 失败'}\n\n` +
            `此条经验不会自动写入共享知识库。\n` +
            `请在对话结束后运行 /experience review 进行审核，` +
            `由你决定是否提交、编辑或丢弃。`,
          isError: false,
        }
      } catch (err) {
        return { content: `experience_write failed: ${String(err)}`, isError: true }
      }
      // `store` is passed in but only used by ExperiencePendingStore.commit() —
      // see the `/experience review` REPL command in cli/index.ts.
      void store
    },
  }
}
