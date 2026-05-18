import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { WorkflowDefinition } from './types.js'
import { WorkflowParser } from './WorkflowParser.js'

export class WorkflowLoader {
  static load(mode: string, projectDir: string): WorkflowDefinition | null {
    const path = WorkflowLoader.discover(mode, projectDir)
    if (!path) return null
    try {
      const raw = readFileSync(path, 'utf-8')
      return WorkflowParser.parse(raw, path)
    } catch { return null }
  }

  static discover(mode: string, projectDir: string): string | null {
    const templatesDir = join(dirname(fileURLToPath(import.meta.url)), 'templates')
    const candidates = [
      join(projectDir, '.meta-agent', 'AGENT.md'),
      join(projectDir, '.meta-agent', 'workflows', `${mode}.md`),
      join(homedir(), '.meta-agent', 'workflows', `${mode}.md`),
      join(templatesDir, `${mode}.md`),
    ]
    return candidates.find(p => existsSync(p)) ?? null
  }

  /**
   * Load the raw Markdown content of the project's AGENT.md file.
   *
   * Searches in priority order:
   *   1. <projectDir>/.meta-agent/AGENT.md
   *   2. <projectDir>/AGENT.md
   *   3. ~/.meta-agent/AGENT.md
   *
   * Returns null when no AGENT.md is found or the file cannot be read.
   * Use this instead of reimplementing the discovery cascade in each caller.
   */
  static loadRaw(projectDir: string): string | null {
    const candidates = [
      join(projectDir, '.meta-agent', 'AGENT.md'),
      join(projectDir, 'AGENT.md'),
      join(homedir(), '.meta-agent', 'AGENT.md'),
    ]
    const found = candidates.find(p => existsSync(p))
    if (!found) return null
    try {
      return readFileSync(found, 'utf-8')
    } catch { return null }
  }
}
