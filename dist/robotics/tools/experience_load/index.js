import { isExperienceId } from '../../ExperienceStore.js';
export function createExperienceLoadTool(store) {
    return {
        name: 'experience_load',
        isConcurrencySafe: true,
        description: 'Load the full details of a robotics experience entry by ID, including the complete report. ' +
            'Use this after experience_search returns relevant results and you need the full context.',
        inputSchema: {
            type: 'object',
            required: ['id'],
            properties: {
                id: {
                    type: 'string',
                    description: 'Experience entry ID (format: exp_<timestamp>_<uuid8>)',
                },
            },
        },
        async call(input) {
            const id = String(input['id'] ?? '');
            if (!id)
                return { content: 'id is required', isError: true };
            if (!isExperienceId(id))
                return { content: `Invalid experience id: ${id}`, isError: true };
            try {
                const entry = await store.load(id);
                if (!entry)
                    return { content: `Experience not found: ${id}`, isError: true };
                const lines = [
                    `# ${entry.title}`,
                    `**ID**: ${entry.id}`,
                    `**Domain**: ${entry.domain} | **Difficulty**: ${entry.difficulty}`,
                    `**Confidence**: ${entry.confidenceTier ?? 'observed'} | **Observations**: ${entry.observationCount ?? 1} | **Contradictions**: ${entry.contradictionCount ?? 0}`,
                    ...(entry.algorithm ? [`**Algorithm**: ${entry.algorithm}`] : []),
                    ...(entry.robot ? [`**Robot**: ${entry.robot}`] : []),
                    ...(entry.tags.length ? [`**Tags**: ${entry.tags.join(', ')}`] : []),
                    `**Created**: ${new Date(entry.createdAt).toISOString()}`,
                    '',
                    '## Problem',
                    entry.problem,
                    '',
                    '## Solution',
                    entry.solution,
                    '',
                    `## Outcome: ${entry.outcome.success ? '✅ Success' : '❌ Failure'}`,
                    entry.outcome.summary,
                    ...(entry.outcome.failureReason ? [`\n**Failure reason**: ${entry.outcome.failureReason}`] : []),
                    ...(entry.outcome.workarounds?.length
                        ? ['\n**Workarounds**:', ...entry.outcome.workarounds.map(w => `- ${w}`)]
                        : []),
                    ...(entry.invalidatedAssumptions?.length
                        ? ['\n**Invalidated assumptions**:', ...entry.invalidatedAssumptions.map(a => `- ${a}`)]
                        : []),
                    '',
                    ...(entry.metrics ? ['## Metrics', ...Object.entries(entry.metrics).map(([k, v]) => `- **${k}**: ${v}`), ''] : []),
                    ...(entry.relatedPapers?.length ? ['## Related Papers', ...entry.relatedPapers.map(p => `- ${p}`), ''] : []),
                    ...(entry.evidenceRefs?.length ? ['## Evidence References', ...entry.evidenceRefs.map(ref => `- ${ref}`), ''] : []),
                    ...(entry.sourceTaskId ? [`**Source task**: ${entry.sourceTaskId}`, ''] : []),
                    ...(entry.fullReport ? ['---', '## Full Report', entry.fullReport] : []),
                ];
                return { content: lines.join('\n'), isError: false };
            }
            catch (err) {
                return { content: `experience_load failed: ${String(err)}`, isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map