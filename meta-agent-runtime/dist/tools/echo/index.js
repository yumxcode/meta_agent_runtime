/**
 * Echo tool — reference implementation of the tool-folder convention.
 *
 * File layout (required for every tool):
 *
 *   src/tools/echo/
 *   ├── prompt.md   ← authoritative description, read at startup
 *   └── index.ts    ← this file: schema + call() implementation
 *
 * Do NOT inline the description as a string literal here.
 * Edit prompt.md instead — it stays readable and diffable.
 */
import { loadToolPrompt } from '../util.js';
export async function createEchoTool() {
    const description = await loadToolPrompt(import.meta.url);
    return {
        name: 'echo',
        description,
        inputSchema: {
            type: 'object',
            properties: {
                text: {
                    type: 'string',
                    description: 'The text to echo back.',
                },
            },
            required: ['text'],
        },
        async call(input, _ctx) {
            const text = typeof input.text === 'string' ? input.text : JSON.stringify(input.text ?? '');
            return { content: text, isError: false };
        },
    };
}
//# sourceMappingURL=index.js.map