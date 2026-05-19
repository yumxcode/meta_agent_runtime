import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { loadToolPrompt } from '../../util.js';
const SETTINGS_FILE = join('.claude', 'settings.json');
// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function settingsPath(cwd) {
    return join(resolve(cwd ?? process.cwd()), SETTINGS_FILE);
}
function readSettings(path) {
    if (!existsSync(path))
        return {};
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return {};
    }
}
function writeSettings(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}
/** Resolve a dot-notation key path to nested object access. */
function getNestedValue(obj, key) {
    const parts = key.split('.');
    let cur = obj;
    for (const p of parts) {
        if (cur === null || typeof cur !== 'object')
            return undefined;
        cur = cur[p];
    }
    return cur;
}
function setNestedValue(obj, key, value) {
    const parts = key.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (typeof cur[p] !== 'object' || cur[p] === null)
            cur[p] = {};
        cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
}
function deleteNestedValue(obj, key) {
    const parts = key.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (typeof cur[p] !== 'object' || cur[p] === null)
            return false;
        cur = cur[p];
    }
    const last = parts[parts.length - 1];
    if (!(last in cur))
        return false;
    delete cur[last];
    return true;
}
// ─────────────────────────────────────────────────────────────────────────────
// Tool
// ─────────────────────────────────────────────────────────────────────────────
export async function createConfigTool(cwd) {
    const description = await loadToolPrompt(import.meta.url);
    return {
        name: 'config',
        description,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['get', 'set', 'list', 'delete'],
                    description: 'Operation to perform.',
                },
                key: {
                    type: 'string',
                    description: 'Settings key (dot-notation). Required for get / set / delete.',
                },
                value: {
                    description: 'Value to set (any JSON-serialisable type). Required for action="set".',
                },
            },
            required: ['action'],
        },
        async call(input, _ctx) {
            const action = String(input['action'] ?? '').trim();
            const key = input['key'] ? String(input['key']).trim() : undefined;
            const value = input['value'];
            const path = settingsPath(cwd);
            try {
                if (action === 'list') {
                    const settings = readSettings(path);
                    return {
                        content: Object.keys(settings).length === 0
                            ? `Settings file is empty or does not exist (${path})`
                            : JSON.stringify(settings, null, 2),
                        isError: false,
                    };
                }
                if (action === 'get') {
                    if (!key)
                        return { content: 'Error: key is required for action="get"', isError: true };
                    const settings = readSettings(path);
                    const val = getNestedValue(settings, key);
                    if (val === undefined) {
                        return { content: `Key "${key}" not found in settings.`, isError: false };
                    }
                    return { content: JSON.stringify(val, null, 2), isError: false };
                }
                if (action === 'set') {
                    if (!key)
                        return { content: 'Error: key is required for action="set"', isError: true };
                    if (value === undefined)
                        return { content: 'Error: value is required for action="set"', isError: true };
                    const settings = readSettings(path);
                    setNestedValue(settings, key, value);
                    writeSettings(path, settings);
                    return {
                        content: `Set "${key}" = ${JSON.stringify(value)} in ${path}`,
                        isError: false,
                    };
                }
                if (action === 'delete') {
                    if (!key)
                        return { content: 'Error: key is required for action="delete"', isError: true };
                    const settings = readSettings(path);
                    const found = deleteNestedValue(settings, key);
                    if (!found)
                        return { content: `Key "${key}" not found; nothing deleted.`, isError: false };
                    writeSettings(path, settings);
                    return { content: `Deleted "${key}" from ${path}`, isError: false };
                }
                return { content: `Error: unknown action "${action}". Use get / set / list / delete.`, isError: true };
            }
            catch (err) {
                return {
                    content: `Config error: ${err instanceof Error ? err.message : String(err)}`,
                    isError: true,
                };
            }
        },
    };
}
//# sourceMappingURL=index.js.map