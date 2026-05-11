/**
 * Tool loader utilities.
 *
 * Convention: every tool lives in its own folder under src/tools/<name>/.
 * The folder MUST contain a `prompt.md` file that is the authoritative
 * description string sent to the model via the Anthropic tool schema.
 *
 * This mirrors how CC defines tool descriptions — CC calls `tool.prompt(opts)`
 * to obtain the description; we back that call with a file so descriptions
 * stay readable, diffable, and version-controlled without touching code.
 *
 * Usage (inside a tool's index.ts):
 *
 *   import { loadToolPrompt } from '../util.js'
 *
 *   const description = await loadToolPrompt(import.meta.url)
 *   export const myTool: MetaAgentTool = { name: '...', description, ... }
 *
 * `import.meta.url` resolves to the tool's own index.ts, so `prompt.md`
 * is always looked up relative to the file that calls loadToolPrompt().
 */

import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

/**
 * Read the `prompt.md` file that lives next to the calling module.
 *
 * @param moduleUrl  Pass `import.meta.url` from the tool's index.ts.
 * @returns          The trimmed contents of prompt.md.
 * @throws           If prompt.md is missing or unreadable.
 */
export async function loadToolPrompt(moduleUrl: string): Promise<string> {
  const dir = dirname(fileURLToPath(moduleUrl))
  const promptPath = join(dir, 'prompt.md')
  const raw = await readFile(promptPath, 'utf-8')
  return raw.trim()
}
