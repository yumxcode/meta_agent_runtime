/**
 * memory_delete — LLM-callable interface for proposing deletion of a committed
 * memory entry. Global system tool, available in all modes.
 *
 * The deletion is NEVER applied here; it is queued in the per-mechanism
 * PendingDeletionStore and the user approves it via `/memory delete review`.
 */

import type { MetaAgentTool } from '../../../core/types.js'
import { createDeleteTool } from '../../../core/deletion/deleteToolFactory.js'
import { listMemoryEntries } from '../../../core/memory/memoryDelete.js'

export function createMemoryDeleteTool(): MetaAgentTool {
  return createDeleteTool({
    name: 'memory_delete',
    mechanism: 'memory',
    reviewCommand: '/memory delete review',
    idField: 'filename',
    idDescription: 'Topic filename of the memory to delete (e.g. "user_role.md"), as shown in the MEMORY.md index.',
    description:
      'Propose deletion of a committed memory entry (user profile / feedback). ' +
      'The memory is NOT deleted immediately — it is queued for the user to approve via `/memory delete review`. ' +
      'Use only when a memory is clearly wrong, obsolete, or was the user explicitly asking to forget it. ' +
      'Identify the target by its topic filename from the MEMORY.md index.',
    async resolve(filename) {
      const entries = await listMemoryEntries()
      const match = entries.find(e => e.filename === filename)
      return match ? `${match.name}${match.type ? ` [${match.type}]` : ''}` : null
    },
  })
}
