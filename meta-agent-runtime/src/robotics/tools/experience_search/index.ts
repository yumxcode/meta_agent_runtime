import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { ExperienceStore } from '../../ExperienceStore.js'
import type { RoboticsDomain } from '../../types.js'

export function createExperienceSearchTool(store: ExperienceStore): MetaAgentTool {
  return {
    name: 'experience_search',
    isConcurrencySafe: true,
    description:
      'Search the robotics experience store for past experiment results, algorithm insights, and lessons learned. ' +
      'Use this at the start of any new algorithm development task to check for relevant prior knowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          enum: [
            'motion_planning', 'perception', 'manipulation', 'locomotion',
            'navigation', 'simulation', 'hardware_interface', 'deployment',
            'calibration', 'general',
          ],
          description: 'Filter by robotics domain',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags (AND semantics — all tags must match)',
        },
        algorithm: {
          type: 'string',
          description: 'Filter by algorithm name (e.g. "MPC", "A-Star", "RL-PPO")',
        },
        robot: {
          type: 'string',
          description: 'Filter by robot platform / project name',
        },
        keyword: {
          type: 'string',
          description: 'Full-text keyword search across title, problem, and solution fields',
        },
        success_only: {
          type: 'boolean',
          description: 'When true, only return entries with outcome.success=true',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10, max 20)',
        },
      },
    },
    async call(input): Promise<ToolResult> {
      try {
        const results = await store.search({
          domain: input['domain'] as RoboticsDomain | undefined,
          tags:   (input['tags'] as string[] | undefined),
          algorithm: input['algorithm'] as string | undefined,
          robot:  input['robot'] as string | undefined,
          keyword: input['keyword'] as string | undefined,
          successOnly: input['success_only'] as boolean | undefined,
          limit:  input['limit'] as number | undefined,
        })
        if (results.length === 0) {
          return { content: 'No experiences found matching the query. This appears to be unexplored territory.', isError: false }
        }
        const lines = results.map(e => {
          const status = e.outcome.success ? '✓' : '✗'
          const metrics = e.metrics
            ? ` | ${Object.entries(e.metrics).slice(0, 2).map(([k, v]) => `${k}=${v}`).join(', ')}`
            : ''
          return [
            `### [${e.id}] ${e.title}`,
            `**Domain**: ${e.domain} | **Difficulty**: ${e.difficulty} | **Outcome**: ${status} ${e.outcome.summary}`,
            ...(e.algorithm ? [`**Algorithm**: ${e.algorithm}${metrics}`] : []),
            ...(e.tags.length ? [`**Tags**: ${e.tags.join(', ')}`] : []),
            `**Problem**: ${e.problem}`,
            `**Solution**: ${e.solution}`,
            ...(e.outcome.failureReason ? [`**Failure reason**: ${e.outcome.failureReason}`] : []),
            ...(e.outcome.workarounds?.length ? [`**Workarounds**: ${e.outcome.workarounds.join('; ')}`] : []),
            `> Use \`experience_load id="${e.id}"\` for the full report.`,
            '',
          ].join('\n')
        })
        return {
          content: `Found ${results.length} experience(s):\n\n${lines.join('\n')}`,
          isError: false,
        }
      } catch (err) {
        return { content: `experience_search failed: ${String(err)}`, isError: true }
      }
    },
  }
}
