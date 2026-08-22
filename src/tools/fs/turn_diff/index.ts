import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

export async function createTurnDiffTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'turn_diff',
    abortSupport: 'bounded',
    description,
    // Reading the diff is concurrency-safe; reverting is not. The declaration
    // has to cover the worst case, because `isConcurrencySafe` is consulted
    // before the input is known to the scheduler.
    isConcurrencySafe: false,
    permission: {
      category: 'read',
      requiresWorkspace: true,
      sensitive: false,
      // Plan mode is read-only, and `revert` writes. Asking is the only correct
      // answer for a tool whose action field decides which it is.
      planMode: 'ask',
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['show', 'stat', 'revert'],
          description: 'show (default) | stat | revert',
        },
        context: { type: 'number', description: 'Context lines around each change. Default: 3' },
      },
      required: [],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const tracker = ctx.turnDiff
      if (!tracker) {
        // Saying so plainly beats returning "no changes", which the caller
        // would read as "my edits did not land".
        return {
          content:
            'Turn diff tracking is not enabled for this session, so there is nothing to show. ' +
            'Enable it on the runtime context to use this tool.',
          isError: true,
        }
      }

      const action = (input['action'] as string | undefined) ?? 'show'
      const contextLines =
        typeof input['context'] === 'number' && Number.isFinite(input['context'])
          ? Math.max(0, Math.min(20, input['context']))
          : undefined

      if (action === 'revert') {
        const outcome = await tracker.revert()
        const parts: string[] = []
        if (outcome.restored.length) {
          parts.push(`Restored ${outcome.restored.length} file(s):\n${bullets(outcome.restored)}`)
        }
        if (outcome.removed.length) {
          parts.push(`Removed ${outcome.removed.length} file(s) created this turn:\n${bullets(outcome.removed)}`)
        }
        if (outcome.failed.length) {
          parts.push(
            `Could NOT revert ${outcome.failed.length} file(s) — fix these by hand:\n` +
              outcome.failed.map(f => `  - ${f.path}: ${f.error}`).join('\n'),
          )
        }
        return {
          content: parts.join('\n\n') || 'Nothing to revert — no files were changed this turn.',
          isError: outcome.failed.length > 0,
        }
      }

      if (action === 'stat') {
        const summary = await tracker.summary()
        const changed = summary.entries.filter(e => e.status !== 'unchanged')
        if (changed.length === 0) return { content: 'No file changes in this turn.', isError: false }
        return {
          content:
            `${summary.filesChanged} file(s) changed, +${summary.linesAdded} -${summary.linesRemoved}\n` +
            changed
              .map(e => `  ${e.status.padEnd(8)} ${e.path}  +${e.added} -${e.removed}`)
              .join('\n'),
          isError: false,
        }
      }

      if (action !== 'show') {
        return { content: `Error: unknown action "${action}" (use show | stat | revert)`, isError: true }
      }

      return {
        content: await tracker.render(contextLines !== undefined ? { context: contextLines } : {}),
        isError: false,
      }
    },
  }
}

function bullets(paths: readonly string[]): string {
  return paths.map(p => `  - ${p}`).join('\n')
}
