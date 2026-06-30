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
import { dynamicDescription } from '../../util.js'

export function createMemoryDeleteTool(): MetaAgentTool {
  return createDeleteTool({
    name: 'memory_delete',
    mechanism: 'memory',
    reviewCommand: '/memory delete review',
    idField: 'filename',
    idDescription: 'Topic filename of the memory to delete (e.g. "user_role.md"), as shown in the MEMORY.md index.',
    description: dynamicDescription(import.meta.url, base => base),
    async resolve(filename) {
      const entries = await listMemoryEntries()
      const match = entries.find(e => e.filename === filename)
      return match ? `${match.name}${match.type ? ` [${match.type}]` : ''}` : null
    },
  })
}
