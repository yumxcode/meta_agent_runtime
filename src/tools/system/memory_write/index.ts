/**
 * memory_write — LLM-callable interface for proposing user/feedback memories.
 *
 * Global system tool, available in all modes.  The proposal is normalised and
 * queued in the process-wide MemoryPendingStore; it is NEVER written to disk
 * here.  The user commits, edits, or discards proposals via `/memory review`.
 *
 * Memory is strictly limited to `user` and `feedback` types — engineering
 * experience belongs to ExperienceStore (experience_write), not memory.
 */

import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { normalizeMemoryProposal } from '../../../core/memory/memoryProposal.js'
import { ensureMemoryPendingLoaded, getMemoryPendingStore } from '../../../core/memory/MemoryPendingStore.js'

export interface MemoryWriteOptions {
  /** Session mode — used for the mode boundary check. Defaults to 'agentic'. */
  mode?: string
  /** Engineering domain configured for the session, attached to the proposal. */
  domain?: string
}

export async function createMemoryWriteTool(options: MemoryWriteOptions = {}): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  const mode = options.mode ?? 'agentic'
  return {
    name: 'memory_write',
    description,
    inputSchema: {
      type: 'object',
      required: ['name', 'description', 'type', 'body'],
      properties: {
        name: {
          type: 'string',
          description: 'Short, specific, searchable memory name (≤ 160 chars).',
        },
        description: {
          type: 'string',
          description: 'One-line summary used for relevance matching (≤ 240 chars).',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback'],
          description: '`user` = profile/preferences; `feedback` = correction/confirmation about how to work.',
        },
        body: {
          type: 'string',
          description:
            'Markdown body. For feedback use: **规则:** rule. **原因:** why. **适用范围:** when it applies.',
        },
        filename: {
          type: 'string',
          description: 'Optional slug for the topic file (e.g. "user_role.md"). Derived from name when omitted.',
        },
        source: {
          type: 'string',
          description: 'Optional provenance note (where this came from).',
        },
        source_verified: {
          type: 'boolean',
          description: 'Optional: whether the source was verified.',
        },
        requires_revalidation: {
          type: 'boolean',
          description: 'Optional: whether this should be re-checked before relying on it.',
        },
        index_line: {
          type: 'string',
          description: 'Optional MEMORY.md pointer line. Auto-generated from name + description when omitted.',
        },
      },
    },
    async call(input): Promise<ToolResult> {
      try {
        const raw = input as Record<string, unknown>
        const proposal = normalizeMemoryProposal(raw, mode, options.domain)
        if (!proposal) {
          return {
            content:
              'memory_write rejected the proposal. Required fields: name, description, ' +
              'type (must be "user" or "feedback"), body. Engineering experience must use experience_write, not memory.',
            isError: true,
          }
        }

        await ensureMemoryPendingLoaded()
        const pendingStore = getMemoryPendingStore()
        const pendingId = pendingStore.add(proposal, 'tool')
        await pendingStore.flush()

        return {
          content:
            `⏸  记忆已加入待审队列 (pending ID: ${pendingId})\n` +
            `名称: ${proposal.name}\n` +
            `类型: ${proposal.type}\n` +
            `\n此条记忆不会自动写入。请在对话结束后运行 /memory review 审核，` +
            `由你决定是否提交、编辑或丢弃。`,
          isError: false,
        }
      } catch (err) {
        return { content: `memory_write failed: ${String(err)}`, isError: true }
      }
    },
  }
}
