import { isPrincipleId } from '../../PrincipleStore.js';
export function createPrincipleLoadTool(store) {
    return {
        name: 'principle_load',
        isConcurrencySafe: true,
        description: 'Load a reviewed robotics principle by ID, including first-principles support, boundaries, source experiences, physical anchors, and counterexamples.',
        inputSchema: {
            type: 'object',
            required: ['id'],
            properties: {
                id: { type: 'string', description: 'Principle ID (format: pr_<timestamp>_<uuid8>)' },
            },
        },
        async call(input) {
            const id = String(input['id'] ?? '');
            if (!isPrincipleId(id))
                return { content: `Invalid principle id: ${id}`, isError: true };
            const principle = await store.load(id);
            if (!principle)
                return { content: `Principle not found: ${id}`, isError: true };
            const lines = [
                `# ${principle.title}`,
                `**ID**: ${principle.id}`,
                `**Domains**: ${principle.domains.join(', ')} | **Level**: ${principle.abstractionLevel}`,
                `**Confidence**: ${principle.confidenceTier} | **Observations**: ${principle.observationCount} | **Contradictions**: ${principle.contradictionCount}`,
                '',
                '## Statement',
                principle.statement,
                '',
                '## Mechanism',
                principle.mechanism,
                '',
                '## First-Principles Support',
                ...(principle.firstPrinciplesSupport.length ? principle.firstPrinciplesSupport.map(item => `- ${item}`) : ['- (none recorded)']),
                '',
                '## Applicability',
                ...(principle.preconditions.length ? principle.preconditions.map(item => `- Preconditions: ${item}`) : []),
                ...(principle.applicabilityBounds.length ? principle.applicabilityBounds.map(item => `- Bound: ${item}`) : []),
                ...(principle.nonApplicableWhen.length ? principle.nonApplicableWhen.map(item => `- Not applicable: ${item}`) : []),
                '',
                ...(principle.derivedFromExperienceIds.length ? ['## Source Experiences', ...principle.derivedFromExperienceIds.map(id => `- ${id}`), ''] : []),
                ...(principle.anchoredByPhysicalAnchorIds.length ? ['## Physical Anchors', ...principle.anchoredByPhysicalAnchorIds.map(id => `- ${id}`), ''] : []),
                ...(principle.invalidatedAssumptions.length ? ['## Invalidated Assumptions', ...principle.invalidatedAssumptions.map(item => `- ${item}`), ''] : []),
                ...(principle.counterExamples.length ? ['## Counterexamples', ...principle.counterExamples.map(item => `- ${item}`), ''] : []),
                ...(principle.evidenceRefs.length ? ['## Evidence References', ...principle.evidenceRefs.map(ref => `- ${ref}`), ''] : []),
            ];
            return { content: lines.join('\n'), isError: false };
        },
    };
}
//# sourceMappingURL=index.js.map