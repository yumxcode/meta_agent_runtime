import { readdir, readFile, stat } from 'fs/promises'
import { join, resolve } from 'path'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

const SKILLS_SUBDIR = join('.claude', 'skills')

/**
 * Resolve the skills directory relative to a given working directory.
 * Falls back to process.cwd() when cwd is not supplied.
 */
function skillsDir(cwd?: string): string {
  return join(resolve(cwd ?? process.cwd()), SKILLS_SUBDIR)
}

/**
 * List all skill names available in a skills directory.
 * Supports two layouts:
 *   1. <skills>/<name>.md            — flat file skill
 *   2. <skills>/<name>/SKILL.md      — directory-style skill
 */
async function listSkillNames(dir: string): Promise<string[]> {
  const names: string[] = []
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
        names.push(entry.name.replace(/\.md$/, ''))
      } else if (entry.isDirectory()) {
        const nested = join(dir, entry.name, 'SKILL.md')
        try {
          if ((await stat(nested)).isFile()) names.push(entry.name)
        } catch { /* skip */ }
      }
    }
  } catch {
    return []
  }
  return names.sort()
}

/**
 * Read a skill by name.  Returns the file contents or null if not found.
 */
async function readSkill(dir: string, name: string): Promise<string | null> {
  // Try flat file first
  const flat = join(dir, `${name}.md`)
  try {
    if ((await stat(flat)).isFile()) return readFile(flat, 'utf-8')
  } catch {
    // Try directory style below.
  }
  // Try directory style
  const nested = join(dir, name, 'SKILL.md')
  try {
    if ((await stat(nested)).isFile()) return readFile(nested, 'utf-8')
  } catch {
    return null
  }
  return null
}

export async function createSkillTool(cwd?: string): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
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
    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const action = String(input['action'] ?? '').trim()
      const name = input['name'] ? String(input['name']).trim() : undefined
      const dir = skillsDir(cwd)

      if (action === 'list') {
        const names = await listSkillNames(dir)
        if (names.length === 0) {
          return {
            content: `No skills found in ${dir}\n\nCreate .md files in .claude/skills/ to define skills.`,
            isError: false,
          }
        }
        return { content: `Available skills:\n${names.map(n => `  • ${n}`).join('\n')}`, isError: false }
      }

      if (action === 'load') {
        if (!name) return { content: 'Error: name is required for action="load"', isError: true }
        const contents = await readSkill(dir, name)
        if (contents === null) {
          const available = await listSkillNames(dir)
          const hint = available.length > 0
            ? `Available skills: ${available.join(', ')}`
            : `No skills found in ${dir}`
          return {
            content: `Error: skill "${name}" not found. ${hint}`,
            isError: true,
          }
        }
        return { content: contents, isError: false }
      }

      return { content: `Error: unknown action "${action}". Use "list" or "load".`, isError: true }
    },
  }
}
