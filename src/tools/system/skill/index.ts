import { readdir, readFile, stat } from 'fs/promises'
import { join, resolve } from 'path'
import type { AgentMode } from '../../../core/dynamicPrompt.js'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { META_AGENT_HOME } from '../../../core/metaAgentHome.js'

// ── Skill directory resolution ────────────────────────────────────────────────
//
// Priority (first-match wins for individual skills; all dirs are listed together):
//   1. <projectDir>/.meta-agent/skills/         — project-scoped (any mode)
//   2. ~/.meta-agent/skills/<mode>/             — user global, mode-specific
//   3. ~/.meta-agent/skills/                    — user global, all modes

function skillDirs(cwd: string, mode: AgentMode): string[] {
  const projectLocal = join(resolve(cwd), '.meta-agent', 'skills')
  const userMode     = join(META_AGENT_HOME, 'skills', mode)
  const userGlobal   = join(META_AGENT_HOME, 'skills')
  return [projectLocal, userMode, userGlobal]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Supported skill layouts:
 *   <dir>/<name>.md          — flat file
 *   <dir>/<name>/SKILL.md   — directory-style
 */
async function listSkillsInDir(dir: string): Promise<string[]> {
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
  } catch { /* dir missing or unreadable */ }
  return names
}

/**
 * List all unique skill names across all skill directories.
 * Earlier directories take precedence (de-duplication preserves first occurrence).
 */
export async function listAllSkillNames(cwd: string, mode: AgentMode): Promise<string[]> {
  const dirs = skillDirs(cwd, mode)
  const seen = new Set<string>()
  for (const dir of dirs) {
    for (const name of await listSkillsInDir(dir)) {
      seen.add(name)
    }
  }
  return [...seen].sort()
}

/**
 * Read a skill by name. Searches directories in priority order; returns the
 * contents of the first match, or null if not found anywhere.
 */
export async function readSkill(name: string, cwd: string, mode: AgentMode): Promise<string | null> {
  for (const dir of skillDirs(cwd, mode)) {
    // Flat file
    const flat = join(dir, `${name}.md`)
    try {
      if ((await stat(flat)).isFile()) return readFile(flat, 'utf-8')
    } catch { /* try next */ }
    // Directory style
    const nested = join(dir, name, 'SKILL.md')
    try {
      if ((await stat(nested)).isFile()) return readFile(nested, 'utf-8')
    } catch { /* try next dir */ }
  }
  return null
}

/**
 * Extract a short description from skill content.
 * Tries YAML frontmatter `description:` first, then the first non-heading
 * non-empty line, truncated to 80 chars.
 */
export function extractSkillDescription(content: string): string {
  // YAML frontmatter: ---\ndescription: ...\n---
  const fmMatch = content.match(/^---\s*\n(?:[\s\S]*?\n)?description:\s*(.+?)\s*\n/m)
  if (fmMatch) return fmMatch[1]!.trim().slice(0, 80)
  // First non-heading, non-empty, non-frontmatter line
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---') continue
    return trimmed.slice(0, 80)
  }
  return ''
}

// ── Tool factory ──────────────────────────────────────────────────────────────

export async function createSkillTool(cwd?: string, mode: AgentMode = 'agentic'): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  const effectiveCwd = cwd ?? process.cwd()

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

      if (action === 'list') {
        const names = await listAllSkillNames(effectiveCwd, mode)
        if (names.length === 0) {
          return {
            content:
              `No skills found.\n\n` +
              `Add skill files to:\n` +
              `  ~/.meta-agent/skills/${mode}/      (user global, ${mode} mode)\n` +
              `  <projectDir>/.meta-agent/skills/   (project-scoped)`,
            isError: false,
          }
        }
        return { content: `Available skills:\n${names.map(n => `  • ${n}`).join('\n')}`, isError: false }
      }

      if (action === 'load') {
        if (!name) return { content: 'Error: name is required for action="load"', isError: true }
        const contents = await readSkill(name, effectiveCwd, mode)
        if (contents === null) {
          const available = await listAllSkillNames(effectiveCwd, mode)
          const hint = available.length > 0
            ? `Available: ${available.join(', ')}`
            : `No skills found in skill directories.`
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
