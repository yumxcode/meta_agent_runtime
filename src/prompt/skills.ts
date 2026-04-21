/**
 * Skills — reusable operation procedures injected into the system prompt.
 *
 * A Skill is a named Markdown file that describes a repeatable procedure:
 * "how to run tests in this project", "how to write a commit message",
 * "how to search the codebase efficiently", etc.
 *
 * Discovery search order (first-found wins for each name):
 *   1. ~/.hermes/skills/           (user-level, always checked)
 *   2. {workDir}/.hermes/skills/   (project-level)
 *   3. {cwd}/.hermes/skills/       (cwd if different from workDir)
 *   4. config.extraDirs            (custom dirs, in order)
 *
 * Loading modes:
 *   • config.include = ['git', 'test'] — only these named skills are loaded
 *   • config.autoDiscover = true       — ALL skills in search dirs are loaded
 *     (capped at config.maxAutoSkills, default 10, to prevent prompt bloat)
 *
 * Skills can also be matched on keywords from the task input
 * (config.keywords → skill names that contain those words in description/name).
 */

import fs   from 'fs/promises';
import path from 'path';
import os   from 'os';

import { scanContent, stripYamlFrontmatter } from './injection-guard.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Skill {
  /** Derived from the filename without extension, e.g. "git-workflow". */
  name: string;
  /** First H1 heading in the file, if present. */
  title?: string;
  /** Full Markdown content of the skill file. */
  content: string;
  /** Absolute path the skill was loaded from. */
  source: string;
}

export interface SkillsConfig {
  /**
   * Explicit list of skill names to load (without extension).
   * Looked up in search dirs in order; silently skipped when not found.
   *
   * Prefer explicit listing over auto-discovery — it makes which skills are
   * active visible in config, avoids accidentally loading malicious files
   * dropped into ~/.hermes/skills/, and keeps the prompt surface predictable.
   */
  include: string[];
  /**
   * Additional directories to search beyond the standard ones
   * (~/.hermes/skills/ and {workDir}/.hermes/skills/).
   */
  extraDirs?: string[];
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load skills according to the given config.
 * Returns an empty array when no config is provided or include list is empty.
 */
export async function loadSkills(opts: {
  config?: SkillsConfig;
  workDir?: string;
  cwd?: string;
}): Promise<Skill[]> {
  const { config, workDir, cwd = process.cwd() } = opts;
  if (!config || config.include.length === 0) return [];

  const searchDirs = _buildSearchDirs(workDir, cwd, config.extraDirs);
  const catalog    = await _discoverAll(searchDirs);

  // Resolve each name against the catalog in declaration order.
  // First search-dir match wins; silently skip names not found.
  const result: Skill[] = [];
  for (const name of config.include) {
    const found = catalog.find((s) => s.name === name);
    if (found) result.push(found);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Render a list of loaded skills as a single Markdown section.
 * Returns an empty string when the list is empty.
 */
export function formatSkills(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const chunks: string[] = ['## Available Skills', ''];
  for (const skill of skills) {
    const heading = skill.title ?? skill.name;
    chunks.push(`### ${heading}`, '');
    chunks.push(skill.content.trim());
    chunks.push('');
  }
  return chunks.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _buildSearchDirs(
  workDir: string | undefined,
  cwd: string,
  extraDirs: string[] | undefined,
): string[] {
  const dirs: string[] = [
    path.join(os.homedir(), '.hermes', 'skills'),
  ];
  if (workDir) {
    dirs.push(path.join(workDir, '.hermes', 'skills'));
  }
  if (cwd && cwd !== workDir) {
    dirs.push(path.join(cwd, '.hermes', 'skills'));
  }
  if (extraDirs) dirs.push(...extraDirs);
  return [...new Set(dirs)];
}

/**
 * Scan all search dirs and collect skills, deduplicating by name (first dir
 * that provides a given name wins — matches the search-order priority).
 */
async function _discoverAll(dirs: string[]): Promise<Skill[]> {
  const seen  = new Set<string>();
  const skills: Skill[] = [];

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.md') && !entry.endsWith('.txt')) continue;
      const name = entry.replace(/\.(md|txt)$/, '');
      if (seen.has(name)) continue;

      try {
        const source  = path.join(dir, entry);
        const raw     = await fs.readFile(source, 'utf-8');
        const stripped = stripYamlFrontmatter(raw);
        const { content } = scanContent(stripped, source);
        const titleMatch = content.match(/^#\s+(.+)/m);
        skills.push({
          name,
          title: titleMatch?.[1]?.trim(),
          content,
          source,
        });
        seen.add(name);
      } catch { /* skip unreadable file */ }
    }
  }

  return skills;
}
