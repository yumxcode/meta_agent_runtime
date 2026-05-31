export function createPrincipleSearchTool(store) {
    return {
        name: 'principle_search',
        isConcurrencySafe: true,
        description: 'Search reviewed robotics principles: transferable mechanisms derived from experiences and physical anchors, including applicability and non-applicability boundaries.',
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
        async call(input) {
            const results = await store.search({
                domain: input['domain'],
                abstractionLevel: input['abstraction_level'],
                keyword: input['keyword'],
                limit: input['limit'],
            });
            if (results.length === 0) {
                return { content: 'No reviewed principles found matching the query.', isError: false };
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
            ].filter(Boolean).join('\n')).join('\n\n');
            return { content: `Found ${results.length} principle(s):\n\n${lines}`, isError: false };
        },
    };
}
//# sourceMappingURL=index.js.map