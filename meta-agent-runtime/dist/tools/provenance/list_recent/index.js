import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
async function loadPrompt() {
    const dir = dirname(fileURLToPath(import.meta.url));
    return (await readFile(join(dir, 'prompt.md'), 'utf-8')).trim();
}
export async function createListRecentTool(tracker) {
    const description = await loadPrompt();
    return {
        name: 'list_recent_results',
        description,
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'number',
                    description: 'Maximum number of records to return (default: 10, max: 50)',
                },
                tool_name: {
                    type: 'string',
                    description: 'Filter by tool name',
                },
                fidelity_level: {
                    type: 'number',
                    description: 'Filter by fidelity level (0–4)',
                    enum: [0, 1, 2, 3, 4],
                },
                has_vv_failure: {
                    type: 'boolean',
                    description: 'If true, only return records where at least one V&V check failed',
                },
            },
            required: [],
        },
        async call(input, _ctx) {
            const limit = Math.min(input['limit'] ?? 10, 50);
            const filter = {};
            if (input['tool_name'])
                filter.toolName = input['tool_name'];
            if (input['fidelity_level'] !== undefined) {
                filter.fidelityLevels = [input['fidelity_level']];
            }
            if (input['has_vv_failure'] !== undefined) {
                filter.hasVVFailure = input['has_vv_failure'];
            }
            const records = await tracker.list(filter);
            // Most-recent first, capped at limit
            const recent = records
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, limit);
            if (recent.length === 0) {
                return { content: 'No provenance records found matching the given filter.', isError: false };
            }
            const lines = recent.map(r => {
                const ts = new Date(r.timestamp).toISOString();
                const vvStatus = r.validationResults.some(v => !v.passed) ? '⚠ V&V failed' : '✓ V&V passed';
                return `[${r.id}]  ${ts}  ${r.toolName} (L${r.fidelityLevel})  ${vvStatus}`;
            });
            return {
                content: `Recent computation results (${recent.length} of ${records.length} total):\n\n` +
                    lines.join('\n'),
                isError: false,
            };
        },
    };
}
//# sourceMappingURL=index.js.map