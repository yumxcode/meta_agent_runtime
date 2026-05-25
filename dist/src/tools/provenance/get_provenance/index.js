import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
async function loadPrompt() {
    const dir = dirname(fileURLToPath(import.meta.url));
    return (await readFile(join(dir, 'prompt.md'), 'utf-8')).trim();
}
export async function createGetProvenanceTool(tracker) {
    const description = await loadPrompt();
    return {
        name: 'get_provenance',
        description,
        inputSchema: {
            type: 'object',
            properties: {
                provenance_id: {
                    type: 'string',
                    description: 'The provenance ID to retrieve (format: prov-xxxxxxxxxxxx)',
                },
            },
            required: ['provenance_id'],
        },
        async call(input, _ctx) {
            const id = input['provenance_id'];
            const record = await tracker.get(id);
            if (!record) {
                return {
                    content: `No provenance record found for ID: ${id}`,
                    isError: true,
                };
            }
            const summary = tracker.summary(id);
            return { content: await summary, isError: false };
        },
    };
}
//# sourceMappingURL=index.js.map