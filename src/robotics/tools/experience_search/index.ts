import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { ExperienceStore } from '../../ExperienceStore.js'
import type { RoboticsDomain } from '../../types.js'
import { experienceContentHash } from '../../../infra/knowledge/contentHash.js'
import { buildExplicitToolInjectionItems } from '../../../evolution/InjectionProvenance.js'

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
          return {
            content: 'No experiences found matching the query. This appears to be unexplored territory.',
            isError: false,
            trajectoryItems: [{ type: 'knowledge', kind: 'experience', action: 'recalled', entryIds: [], query: JSON.stringify(input), operation: 'recall' }],
          }
        }
        const lines = results.map(e => {
          const status = e.outcome.success ? '✓' : '✗'
          const metrics = e.metrics
            ? ` | ${Object.entries(e.metrics).slice(0, 2).map(([k, v]) => `${k}=${v}`).join(', ')}`
            : ''
          return [
            `### [${e.id}] ${e.title}`,
            `**Domain**: ${e.domain} | **Difficulty**: ${e.difficulty} | **Outcome**: ${status} ${e.outcome.summary}`,
            `**Confidence**: ${e.confidenceTier ?? 'observed'} | **Observations**: ${e.observationCount ?? 1} | **Contradictions**: ${e.contradictionCount ?? 0}`,
            ...(e.algorithm ? [`**Algorithm**: ${e.algorithm}${metrics}`] : []),
            ...(e.tags.length ? [`**Tags**: ${e.tags.join(', ')}`] : []),
            `**Problem**: ${e.problem}`,
            `**Solution**: ${e.solution}`,
            ...(e.outcome.failureReason ? [`**Failure reason**: ${e.outcome.failureReason}`] : []),
            ...(e.outcome.workarounds?.length ? [`**Workarounds**: ${e.outcome.workarounds.join('; ')}`] : []),
            ...(e.invalidatedAssumptions?.length ? [`**Invalidated assumptions**: ${e.invalidatedAssumptions.join('; ')}`] : []),
            ...(e.principleIds?.length ? [`**Principles**: ${e.principleIds.join('; ')}`] : []),
            ...(e.evidenceRefs?.length ? [`**Evidence refs**: ${e.evidenceRefs.slice(0, 4).join('; ')}`] : []),
            `> Use \`experience_load id="${e.id}"\` for the full report.`,
            '',
          ].join('\n')
        })
        const content = `Found ${results.length} experience(s):\n\n${lines.join('\n')}`
        return {
          content,
          isError: false,
          trajectoryItems: [
            // Unchanged: a query really did run, and this is the record of it.
            {
              type: 'knowledge', kind: 'experience', action: 'recalled',
              entryIds: results.map(entry => entry.id), query: JSON.stringify(input), operation: 'recall',
            },
            // Added: this tool is not an index. It prints problem, solution,
            // failure reason and workarounds for every hit, so the bodies
            // entered context and that is a separate fact from the query.
            ...buildExplicitToolInjectionItems({
              kind: 'experience',
              tool: 'experience_search',
              toolInput: input,
              entries: results.map(entry => ({
                entryId: entry.id,
                contentHash: experienceContentHash(entry),
              })),
              content,
            }),
          ],
        }
      } catch (err) {
        return { content: `experience_search failed: ${String(err)}`, isError: true }
      }
    },
  }
}
