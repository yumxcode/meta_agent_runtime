import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
async function loadPrompt() {
    const dir = dirname(fileURLToPath(import.meta.url));
    return (await readFile(join(dir, 'prompt.md'), 'utf-8')).trim();
}
/** Replicates ProvenanceTracker's internal hashRecord() for consistent matching */
function hashInput(input) {
    try {
        return createHash('sha256').update(JSON.stringify(input), 'utf-8').digest('hex');
    }
    catch {
        return createHash('sha256').update(String(input), 'utf-8').digest('hex');
    }
}
export async function createFindDuplicateTool(tracker) {
    const description = await loadPrompt();
    return {
        name: 'find_duplicate_computation',
        description,
        inputSchema: {
            type: 'object',
            properties: {
                tool_name: {
                    type: 'string',
                    description: 'Name of the tool you are about to call',
                },
                input: {
                    type: 'object',
                    description: 'The exact input parameters you would pass to the tool',
                },
            },
            required: ['tool_name', 'input'],
        },
        async call(input, _ctx) {
            const toolName = input['tool_name'];
            const toolInput = input['input'] ?? {};
            // Compute the same hash that ProvenanceTracker.record() uses
            const inputHash = hashInput(toolInput);
            // Find all records with that input hash, then filter by toolName
            const matches = await tracker.findByInputHash(inputHash);
            const toolMatches = matches.filter(r => r.toolName === toolName);
            if (toolMatches.length === 0) {
                return {
                    content: JSON.stringify({ duplicate: false }),
                    isError: false,
                };
            }
            // Most recent match
            const existing = toolMatches[toolMatches.length - 1];
            const summary = await tracker.summary(existing.id);
            return {
                content: JSON.stringify({
                    duplicate: true,
                    provenanceId: existing.id,
                    timestamp: new Date(existing.timestamp).toISOString(),
                    summary,
                }, null, 2),
                isError: false,
            };
        },
    };
}
//# sourceMappingURL=index.js.map