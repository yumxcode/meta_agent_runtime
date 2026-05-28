export function createPhysicalAnchorSearchTool(store) {
    return {
        name: 'physical_anchor_search',
        isConcurrencySafe: true,
        description: 'Search physical anchors: hardware facts, physics mechanisms, measured limits, datasheet constraints, and observed device quirks.',
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
        async call(input) {
            try {
                const anchors = await store.search({
                    domain: input['domain'],
                    scope: input['scope'],
                    robot: input['robot'],
                    tags: input['tags'],
                    keyword: input['keyword'],
                    limit: input['limit'],
                });
                if (anchors.length === 0) {
                    return { content: 'No physical anchors found matching the query.', isError: false };
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
                ].join('\n'));
                return { content: `Found ${anchors.length} physical anchor(s):\n\n${lines.join('\n')}`, isError: false };
            }
            catch (err) {
                return { content: `physical_anchor_search failed: ${String(err)}`, isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map