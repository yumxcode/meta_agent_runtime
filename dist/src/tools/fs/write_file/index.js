import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { loadToolPrompt } from '../../util.js';
import { assertInsideWorkspace } from '../workspaceGuard.js';
export async function createWriteFileTool() {
    const description = await loadToolPrompt(import.meta.url);
    return {
        name: 'write_file',
        description,
        permission: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: true, planMode: 'ask' },
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute path to the file to write' },
                content: { type: 'string', description: 'Content to write to the file' },
            },
            required: ['file_path', 'content'],
        },
        async call(input, _ctx) {
            const filePath = input['file_path'];
            const content = input['content'];
            if (!filePath)
                return { content: 'Error: file_path is required', isError: true };
            const workspaceError = assertInsideWorkspace(filePath, _ctx.workspaceRoot);
            if (workspaceError)
                return { content: workspaceError, isError: true };
            if (content === undefined || content === null)
                return { content: 'Error: content is required', isError: true };
            try {
                mkdirSync(dirname(filePath), { recursive: true });
                writeFileSync(filePath, content, 'utf-8');
                const lines = content.split('\n').length;
                return { content: `Successfully wrote ${lines} lines to ${filePath}`, isError: false };
            }
            catch (err) {
                return { content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map