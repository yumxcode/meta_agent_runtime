import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { ExperienceStore } from '../../ExperienceStore.js'
import type { RoboticsDomain } from '../../types.js'

export function createExperienceWriteTool(store: ExperienceStore): MetaAgentTool {
  return {
    name: 'experience_write',
    description:
      'Write a new experience entry to the robotics experience store. ' +
      'Call this when an experiment or task concludes — success or failure — to preserve the lesson for future sessions. ' +
      'Failure experiences are especially valuable: always document what went wrong and any workarounds found.',
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
        const id = await store.write({
          domain: (input['domain'] as RoboticsDomain) ?? 'general',
          title: String(input['title'] ?? ''),
          problem: String(input['problem'] ?? ''),
          solution: String(input['solution'] ?? ''),
          outcome: {
            success: Boolean(input['success']),
            summary: String(input['outcome_summary'] ?? ''),
            failureReason: input['failure_reason'] as string | undefined,
            workarounds: input['workarounds'] as string[] | undefined,
          },
          algorithm: input['algorithm'] as string | undefined,
          tags: (input['tags'] as string[] | undefined) ?? [],
          robot: input['robot'] as string | undefined,
          difficulty: (input['difficulty'] as 'low' | 'medium' | 'high' | undefined) ?? 'medium',
          metrics: input['metrics'] as Record<string, number | string> | undefined,
          relatedPapers: input['related_papers'] as string[] | undefined,
          sourceTaskId: input['source_task_id'] as string | undefined,
          fullReport: input['full_report'] as string | undefined,
        })
        return {
          content: `✅ Experience written with ID: ${id}\nUse \`experience_load id="${id}"\` to retrieve it later.`,
          isError: false,
        }
      } catch (err) {
        return { content: `experience_write failed: ${String(err)}`, isError: true }
      }
    },
  }
}
