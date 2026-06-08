/**
 * Shared factory for LLM-callable `*_delete` tools.
 *
 * Deletion is destructive and the AI is never allowed to apply it directly.
 * Every tool here only enqueues a pending deletion (PendingDeletionStore) that
 * the user must approve via `/<mechanism> delete review`. The resolve() hook
 * looks up the committed entry so (a) bogus IDs are rejected up front and
 * (b) the review screen can show a meaningful label.
 */

import type { MetaAgentTool, ToolResult } from '../types.js'
import {
  ensurePendingDeletionsLoaded,
  getPendingDeletionStore,
  type DeletionMechanism,
} from './PendingDeletionStore.js'

export interface DeleteToolConfig {
  /** Tool name, e.g. "experience_delete". */
  name: string
  mechanism: DeletionMechanism
  /** Review command shown to the user, e.g. "/experience delete review". */
  reviewCommand: string
  /** Schema field name carrying the target ID. Defaults to "id". */
  idField?: string
  /** Schema description for the ID field. */
  idDescription: string
  /** Full tool description handed to the model. */
  description: string
  /**
   * Resolve the committed entry's display label.
   * Return null when no committed entry matches (nothing will be queued).
   */
  resolve(targetId: string): Promise<string | null>
}

export function createDeleteTool(cfg: DeleteToolConfig): MetaAgentTool {
  const idField = cfg.idField ?? 'id'
  return {
    name: cfg.name,
    description: cfg.description,
    inputSchema: {
      type: 'object',
      required: [idField],
      properties: {
        [idField]: { type: 'string', description: cfg.idDescription },
        reason: {
          type: 'string',
          description: 'Optional short justification for the deletion, shown to the user during review.',
        },
      },
    },
    async call(input): Promise<ToolResult> {
      try {
        const raw = input as Record<string, unknown>
        const targetId = typeof raw[idField] === 'string' ? (raw[idField] as string).trim() : ''
        const reason = typeof raw['reason'] === 'string' ? (raw['reason'] as string) : undefined
        if (!targetId) {
          return { content: `${cfg.name} requires a non-empty ${idField}.`, isError: true }
        }

        const label = await cfg.resolve(targetId)
        if (label === null) {
          return {
            content:
              `${cfg.name}: no committed ${cfg.mechanism} entry found for "${targetId}". Nothing was queued. ` +
              `Verify the ID via the corresponding search/list tool.`,
            isError: true,
          }
        }

        await ensurePendingDeletionsLoaded(cfg.mechanism)
        const store = getPendingDeletionStore(cfg.mechanism)
        const pendingId = store.add({ targetId, label, reason })
        await store.flush()

        return {
          content:
            `⏸  删除请求已加入待审队列 (pending ID: ${pendingId})\n` +
            `目标: ${label} (${targetId})\n` +
            `\n该条目不会被自动删除。请运行 ${cfg.reviewCommand}，由用户确认后才会真正删除。`,
          isError: false,
        }
      } catch (err) {
        return { content: `${cfg.name} failed: ${String(err)}`, isError: true }
      }
    },
  }
}
