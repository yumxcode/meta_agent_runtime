import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { loadToolPrompt } from '../../util.js';
const SKILLS_SUBDIR = join('.claude', 'skills');
/**
 * Resolve the skills directory relative to a given working directory.
 * Falls back to process.cwd() when cwd is not supplied.
 */
function skillsDir(cwd) {
    return join(resolve(cwd ?? process.cwd()), SKILLS_SUBDIR);
}
/**
 * List all skill names available in a skills directory.
 * Supports two layouts:
 *   1. <skills>/<name>.md            — flat file skill
 *   2. <skills>/<name>/SKILL.md      — directory-style skill
 */
function listSkillNames(dir) {
    if (!existsSync(dir))
        return [];
    const names = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
            names.push(entry.name.replace(/\.md$/, ''));
        }
        else if (entry.isDirectory()) {
            const nested = join(dir, entry.name, 'SKILL.md');
            if (existsSync(nested))
                names.push(entry.name);
        }
    }
    return names.sort();
}
/**
 * Read a skill by name.  Returns the file contents or null if not found.
 */
function readSkill(dir, name) {
    // Try flat file first
    const flat = join(dir, `${name}.md`);
    if (existsSync(flat) && statSync(flat).isFile()) {
        return readFileSync(flat, 'utf-8');
    }
    // Try directory style
    const nested = join(dir, name, 'SKILL.md');
    if (existsSync(nested) && statSync(nested).isFile()) {
        return readFileSync(nested, 'utf-8');
    }
    return null;
}
export async function createSkillTool(cwd) {
    const description = await loadToolPrompt(import.meta.url);
    return {
        name: 'skill',
        description,
        isConcurrencySafe: true,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['list', 'load'],
                    description: '"list" to see available skills; "load" to read one.',
                },
                name: {
                    type: 'string',
                    description: 'Skill name (required for action="load"). Case-sensitive.',
                },
            },
            required: ['action'],
        },
        async call(input, _ctx) {
            const action = String(input['action'] ?? '').trim();
            const name = input['name'] ? String(input['name']).trim() : undefined;
            const dir = skillsDir(cwd);
            if (action === 'list') {
                const names = listSkillNames(dir);
                if (names.length === 0) {
                    return {
                        content: `No skills found in ${dir}\n\nCreate .md files in .claude/skills/ to define skills.`,
                        isError: false,
                    };
                }
                return { content: `Available skills:\n${names.map(n => `  • ${n}`).join('\n')}`, isError: false };
            }
            if (action === 'load') {
                if (!name)
                    return { content: 'Error: name is required for action="load"', isError: true };
                const contents = readSkill(dir, name);
                if (contents === null) {
                    const available = listSkillNames(dir);
                    const hint = available.length > 0
                        ? `Available skills: ${available.join(', ')}`
                        : `No skills found in ${dir}`;
                    return {
                        content: `Error: skill "${name}" not found. ${hint}`,
                        isError: true,
                    };
                }
                return { content: contents, isError: false };
            }
            return { content: `Error: unknown action "${action}". Use "list" or "load".`, isError: true };
        },
    };
}
//# sourceMappingURL=index.js.map