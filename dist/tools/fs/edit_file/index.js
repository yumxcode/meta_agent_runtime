import { readFile, stat, writeFile } from 'fs/promises';
import { loadToolPrompt } from '../../util.js';
import { assertInsideWorkspace } from '../workspaceGuard.js';
const MAX_EDIT_BYTES = 5 * 1024 * 1024;
export async function createEditFileTool() {
    const description = await loadToolPrompt(import.meta.url);
    return {
        name: 'edit_file',
        description,
        permission: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: true, planMode: 'ask' },
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute path to the file to edit' },
                old_string: { type: 'string', description: 'The exact string to replace' },
                new_string: { type: 'string', description: 'The replacement string' },
                replace_all: { type: 'boolean', description: 'Replace all occurrences. Default: false' },
            },
            required: ['file_path', 'old_string', 'new_string'],
        },
        async call(input, _ctx) {
            const filePath = input['file_path'];
            const oldStr = input['old_string'];
            const newStr = input['new_string'];
            const replaceAll = input['replace_all'] === true;
            if (!filePath)
                return { content: 'Error: file_path is required', isError: true };
            const workspaceError = assertInsideWorkspace(filePath, _ctx.workspaceRoot);
            if (workspaceError)
                return { content: workspaceError, isError: true };
            try {
                const fileStat = await stat(filePath);
                if (fileStat.size > MAX_EDIT_BYTES) {
                    return { content: `Error: file is too large to edit safely (${fileStat.size} bytes). Use a targeted patch workflow.`, isError: true };
                }
                const content = await readFile(filePath, 'utf-8');
                const occurrences = content.split(oldStr).length - 1;
                if (occurrences === 0)
                    return { content: `Error: old_string not found in ${filePath}`, isError: true };
                if (!replaceAll && occurrences > 1)
                    return { content: `Error: old_string appears ${occurrences} times. Use replace_all: true or add more context.`, isError: true };
                const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
                await writeFile(filePath, updated, 'utf-8');
                return { content: `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${filePath}`, isError: false };
            }
            catch (err) {
                return { content: `Error editing file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map