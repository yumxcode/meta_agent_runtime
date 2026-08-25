import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { PhysicalAnchorStore } from '../../PhysicalAnchorStore.js'
import type { RoboticsDomain } from '../../types.js'
import { physicalAnchorContentHash } from '../../../infra/knowledge/contentHash.js'
import { buildExplicitToolInjectionItems } from '../../../evolution/InjectionProvenance.js'

export function createPhysicalAnchorSearchTool(store: PhysicalAnchorStore): MetaAgentTool {
  return {
    name: 'physical_anchor_search',
    isConcurrencySafe: true,
    description:
      'Search physical anchors: hardware facts, physics mechanisms, measured limits, datasheet constraints, and observed device quirks.',
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
        scope: {
          type: 'string',
          enum: ['global', 'robot', 'code'],
          description: 'Filter by applicability scope',
        },
        robot: { type: 'string', description: 'Filter by robot/platform' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (AND semantics)' },
        keyword: { type: 'string', description: 'Search title, fact, mechanism, implication, and source' },
        limit: { type: 'number', description: 'Max results to return (default 10, max 20)' },
      },
    },
    async call(input): Promise<ToolResult> {
      try {
        const anchors = await store.search({
          domain: input['domain'] as RoboticsDomain | undefined,
          scope: input['scope'] as any,
          robot: input['robot'] as string | undefined,
          tags: input['tags'] as string[] | undefined,
          keyword: input['keyword'] as string | undefined,
          limit: input['limit'] as number | undefined,
        })
        if (anchors.length === 0) {
          return {
            content: 'No physical anchors found matching the query.',
            isError: false,
            trajectoryItems: [{ type: 'knowledge', kind: 'anchor', action: 'recalled', entryIds: [], query: JSON.stringify(input), operation: 'recall' }],
          }
        }
        const lines = anchors.map(anchor => [
          `### [${anchor.id}] ${anchor.title}`,
          `**Domain**: ${anchor.domain} | **Scope**: ${anchor.scope} | **Confidence**: ${anchor.confidenceTier}`,
          ...(anchor.robot ? [`**Robot**: ${anchor.robot}`] : []),
          ...(anchor.tags.length ? [`**Tags**: ${anchor.tags.join(', ')}`] : []),
          `**Fact**: ${anchor.fact}`,
          ...(anchor.mechanism ? [`**Mechanism**: ${anchor.mechanism}`] : []),
          `**Implication**: ${anchor.implication}`,
          ...(anchor.evidenceRefs.length ? [`**Evidence refs**: ${anchor.evidenceRefs.slice(0, 4).join('; ')}`] : []),
          `> Use \`physical_anchor_load id="${anchor.id}"\` for the full anchor.`,
          '',
        ].join('\n'))
        const content = `Found ${anchors.length} physical anchor(s):\n\n${lines.join('\n')}`
        return {
          content,
          isError: false,
          trajectoryItems: [
            {
              type: 'knowledge', kind: 'anchor', action: 'recalled',
              entryIds: anchors.map(anchor => anchor.id), query: JSON.stringify(input), operation: 'recall',
            },
            // Fact, mechanism and implication are printed in full per hit.
            ...buildExplicitToolInjectionItems({
              kind: 'anchor',
              tool: 'physical_anchor_search',
              toolInput: input,
              entries: anchors.map(anchor => ({
                entryId: anchor.id,
                contentHash: physicalAnchorContentHash(anchor),
              })),
              content,
            }),
          ],
        }
      } catch (err) {
        return { content: `physical_anchor_search failed: ${String(err)}`, isError: true }
      }
    },
  }
}
