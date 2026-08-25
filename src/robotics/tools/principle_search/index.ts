import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { RoboticsDomain, PrincipleAbstractionLevel } from '../../types.js'
import type { PrincipleStore } from '../../PrincipleStore.js'
import { principleContentHash } from '../../../infra/knowledge/contentHash.js'
import { buildExplicitToolInjectionItems } from '../../../evolution/InjectionProvenance.js'

export function createPrincipleSearchTool(store: PrincipleStore): MetaAgentTool {
  return {
    name: 'principle_search',
    isConcurrencySafe: true,
    description:
      'Search reviewed robotics principles: transferable mechanisms derived from experiences and physical anchors, including applicability and non-applicability boundaries.',
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
        },
        abstraction_level: {
          type: 'string',
          enum: ['physical', 'system', 'algorithmic', 'statistical', 'operational'],
        },
        keyword: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    async call(input): Promise<ToolResult> {
      const results = await store.search({
        domain: input['domain'] as RoboticsDomain | undefined,
        abstractionLevel: input['abstraction_level'] as PrincipleAbstractionLevel | undefined,
        keyword: input['keyword'] as string | undefined,
        limit: input['limit'] as number | undefined,
      })
      if (results.length === 0) {
        return {
          content: 'No reviewed principles found matching the query.',
          isError: false,
          trajectoryItems: [{ type: 'knowledge', kind: 'principle', action: 'recalled', entryIds: [], query: JSON.stringify(input), operation: 'recall' }],
        }
      }
      const lines = results.map(p => [
        `### [${p.id}] ${p.title}`,
        `**Domains**: ${p.domains.join(', ')} | **Level**: ${p.abstractionLevel} | **Confidence**: ${p.confidenceTier}`,
        `**Statement**: ${p.statement}`,
        `**Mechanism**: ${p.mechanism}`,
        p.firstPrinciplesSupport.length ? `**First-principles support**: ${p.firstPrinciplesSupport.join('; ')}` : '',
        p.applicabilityBounds.length ? `**Bounds**: ${p.applicabilityBounds.join('; ')}` : '',
        p.nonApplicableWhen.length ? `**Not applicable when**: ${p.nonApplicableWhen.join('; ')}` : '',
        `> Use \`principle_load id="${p.id}"\` for full boundaries and evidence.`,
      ].filter(Boolean).join('\n')).join('\n\n')
      const content = `Found ${results.length} principle(s):\n\n${lines}`
      return {
        content,
        isError: false,
        trajectoryItems: [
          {
            type: 'knowledge', kind: 'principle', action: 'recalled',
            entryIds: results.map(result => result.id), query: JSON.stringify(input), operation: 'recall',
          },
          // Statement, mechanism, support and bounds are all printed per hit.
          ...buildExplicitToolInjectionItems({
            kind: 'principle',
            tool: 'principle_search',
            toolInput: input,
            entries: results.map(result => ({
              entryId: result.id,
              contentHash: principleContentHash(result),
            })),
            content,
          }),
        ],
      }
    },
  }
}
