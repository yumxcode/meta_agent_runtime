import { isPhysicalAnchorId } from '../../PhysicalAnchorStore.js';
export function createPhysicalAnchorLoadTool(store) {
    return {
        name: 'physical_anchor_load',
        isConcurrencySafe: true,
        description: 'Load a physical anchor by ID, including evidence references and invalidated assumptions.',
        inputSchema: {
            type: 'object',
            required: ['id'],
            properties: {
                id: { type: 'string', description: 'Physical anchor ID (format: pa_<timestamp>_<uuid8>)' },
            },
        },
        async call(input) {
            const id = String(input['id'] ?? '');
            if (!id)
                return { content: 'id is required', isError: true };
            if (!isPhysicalAnchorId(id))
                return { content: `Invalid physical anchor id: ${id}`, isError: true };
            try {
                const anchor = await store.load(id);
                if (!anchor)
                    return { content: `Physical anchor not found: ${id}`, isError: true };
                const lines = [
                    `# ${anchor.title}`,
                    `**ID**: ${anchor.id}`,
                    `**Domain**: ${anchor.domain} | **Scope**: ${anchor.scope} | **Confidence**: ${anchor.confidenceTier}`,
                    ...(anchor.robot ? [`**Robot**: ${anchor.robot}`] : []),
                    ...(anchor.source ? [`**Source**: ${anchor.source}`] : []),
                    ...(anchor.tags.length ? [`**Tags**: ${anchor.tags.join(', ')}`] : []),
                    `**Created**: ${new Date(anchor.createdAt).toISOString()}`,
                    ...(anchor.lastVerifiedAt ? [`**Last verified**: ${new Date(anchor.lastVerifiedAt).toISOString()}`] : []),
                    '',
                    '## Fact',
                    anchor.fact,
                    '',
                    ...(anchor.mechanism ? ['## Mechanism', anchor.mechanism, ''] : []),
                    '## Implication',
                    anchor.implication,
                    '',
                    ...(anchor.evidenceRefs.length ? ['## Evidence References', ...anchor.evidenceRefs.map(ref => `- ${ref}`), ''] : []),
                    ...(anchor.invalidates?.length ? ['## Invalidates', ...anchor.invalidates.map(item => `- ${item}`), ''] : []),
                ];
                return { content: lines.join('\n'), isError: false };
            }
            catch (err) {
                return { content: `physical_anchor_load failed: ${String(err)}`, isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map