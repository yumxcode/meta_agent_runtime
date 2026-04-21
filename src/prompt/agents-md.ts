/**
 * AGENTS.md loader — project and user-level agent instructions.
 *
 * Mirrors the CLAUDE.md hierarchy used by Claude Code:
 *
 *   1. ~/.hermes/AGENTS.md          — user-level global instructions
 *   2. Walk up from cwd to root     — project-level, outermost first
 *   3. workDir/AGENTS.md            — working-directory override (if different from cwd)
 *
 * Files are concatenated outermost → innermost so that narrower (closer-to-cwd)
 * instructions have highest recency weight in the prompt.
 */

import fs   from 'fs/promises';
import path from 'path';
import os   from 'os';

import { scanContent, stripYamlFrontmatter } from './injection-guard.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentsMdResult {
  /** Merged content of all discovered AGENTS.md files. Empty string if none found. */
  content: string;
  /** Absolute paths of files that were loaded (outermost → innermost). */
  sources: string[];
}

export interface AgentsMdOptions {
  /** Working directory — hierarchy search starts here. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Project working directory. Checked in addition to cwd when it differs.
   * Useful when the agent is configured to operate in a specific project root.
   */
  workDir?: string;
  /**
   * Set false to skip the user-level ~/.hermes/AGENTS.md.
   * Useful in sandboxed / headless environments.
   * @default true
   */
  includeGlobal?: boolean;
  /**
   * Set false to disable the cwd walk-up entirely.
   * @default true
   */
  includeHierarchy?: boolean;
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

/**
 * Load and merge AGENTS.md files from the full hierarchy.
 * Returns `{ content: '', sources: [] }` if no files were found — never throws.
 */
export async function loadAgentsMd(opts: AgentsMdOptions = {}): Promise<AgentsMdResult> {
  const {
    cwd = process.cwd(),
    workDir,
    includeGlobal = true,
    includeHierarchy = true,
  } = opts;

  const sections: Array<{ source: string; content: string }> = [];

  // -------------------------------------------------------------------------
  // 1. User-level global (~/.hermes/AGENTS.md)
  // -------------------------------------------------------------------------
  if (includeGlobal) {
    const globalPath = path.join(os.homedir(), '.hermes', 'AGENTS.md');
    const globalContent = await _readIfExists(globalPath);
    if (globalContent !== null) {
      sections.push({ source: globalPath, content: globalContent });
    }
  }

  // -------------------------------------------------------------------------
  // 2. Hierarchy walk: cwd → parent → … → home or filesystem root.
  //    Results are returned outermost-first so innermost overrides outer.
  // -------------------------------------------------------------------------
  if (includeHierarchy) {
    const hierarchy = await _walkHierarchy(cwd);
    for (const entry of hierarchy) sections.push(entry);
  }

  // -------------------------------------------------------------------------
  // 3. workDir (if specified and different from cwd — not already loaded above)
  // -------------------------------------------------------------------------
  if (workDir && path.resolve(workDir) !== path.resolve(cwd)) {
    const workDirFile = path.join(workDir, 'AGENTS.md');
    if (!sections.some((s) => s.source === workDirFile)) {
      const workContent = await _readIfExists(workDirFile);
      if (workContent !== null) {
        sections.push({ source: workDirFile, content: workContent });
      }
    }
  }

  const sources  = sections.map((s) => s.source);
  const content  = sections.map((s) => s.content.trim()).join('\n\n---\n\n');

  return { content, sources };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk up from `startDir` collecting AGENTS.md files, outermost first.
 * Stops at the user home directory or filesystem root.
 */
async function _walkHierarchy(
  startDir: string,
): Promise<Array<{ source: string; content: string }>> {
  const results: Array<{ source: string; content: string }> = [];
  const home = os.homedir();
  const root = path.parse(startDir).root;

  let dir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(dir, 'AGENTS.md');
    const content = await _readIfExists(candidate);
    if (content !== null) {
      // Prepend so that the outermost (highest-level) entry comes first
      results.unshift({ source: candidate, content });
    }

    if (dir === home || dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // Reached fs root
    dir = parent;
  }

  return results;
}

/**
 * Read a file, apply injection scanning and frontmatter stripping.
 * Returns null if the file does not exist.
 * Returns a [BLOCKED: ...] notice if threats are detected (never returns raw
 * malicious content — the notice is safe to inject as prose).
 */
async function _readIfExists(filePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  const stripped = stripYamlFrontmatter(raw);
  const { content } = scanContent(stripped, filePath);
  return content;
}
