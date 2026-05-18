/**
 * Tool loader utilities.
 *
 * Convention: every tool lives in its own folder under src/tools/<name>/.
 * The folder MUST contain a `prompt.md` file that is the authoritative
 * base description string for the tool.
 *
 * Two description styles are supported — matching CC's own evolution:
 *
 *   1. Static (simple tools):
 *        description: await loadToolPrompt(import.meta.url)
 *
 *   2. Dynamic (tools that cross-reference siblings, e.g. BashTool):
 *        description: dynamicDescription(import.meta.url, (base, ctx) => {
 *          const hints: string[] = []
 *          if (ctx.toolNames.has('grep')) hints.push('- Search: use `grep` tool')
 *          return hints.length ? `${base}\n\n${hints.join('\n')}` : base
 *        })
 *
 * Dynamic descriptions receive a ToolDescriptionContext so they can inspect
 * sibling tools and session state — identical to CC's async `tool.prompt(opts)`.
 * The MetaAgentSession resolves them lazily and caches the result until the
 * tool registry changes (mirroring CC's per-session toolSchemaCache).
 */

import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import type { ToolDescription, ToolDescriptionContext } from '../core/types.js'

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

/**
 * Create a dynamic ToolDescription function that:
 *   1. Reads prompt.md once (lazy, cached after first call)
 *   2. Calls `enhance(baseText, ctx)` at resolve time to append context-aware
 *      guidance (e.g. cross-tool hints that depend on which sibling tools exist)
 *
 * The returned function is suitable for `MetaAgentTool.description` and will
 * be resolved by MetaAgentSession.buildApiToolsAsync() with full ToolDescriptionContext.
 *
 * @param moduleUrl  Pass `import.meta.url` from the tool's index.ts.
 * @param enhance    Pure function: (baseText, ctx) => finalDescriptionString.
 *                   Called synchronously inside the async wrapper — keep it fast.
 *
 * @example
 *   // In bash/index.ts
 *   description: dynamicDescription(import.meta.url, (base, ctx) => {
 *     const hints: string[] = []
 *     if (ctx.toolNames.has('grep'))      hints.push('- Search contents: use `grep` tool (NOT rg/grep commands)')
 *     if (ctx.toolNames.has('glob'))      hints.push('- Find files: use `glob` tool (NOT find/ls)')
 *     if (ctx.toolNames.has('read_file')) hints.push('- Read files: use `read_file` tool (NOT cat/head/tail)')
 *     if (ctx.toolNames.has('edit_file')) hints.push('- Edit files: use `edit_file` tool (NOT sed/awk)')
 *     return hints.length
 *       ? `${base}\n\nPrefer these tools over shell equivalents:\n${hints.join('\n')}`
 *       : base
 *   })
 */
export function dynamicDescription(
  moduleUrl: string,
  enhance: (base: string, ctx: ToolDescriptionContext) => string,
): ToolDescription {
  let cachedBase: string | null = null
  return async (ctx: ToolDescriptionContext): Promise<string> => {
    if (cachedBase === null) {
      cachedBase = await loadToolPrompt(moduleUrl)
    }
    return enhance(cachedBase, ctx)
  }
}
