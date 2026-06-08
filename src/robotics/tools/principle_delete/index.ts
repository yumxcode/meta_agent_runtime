/**
 * principle_delete — propose deletion of a committed principle entry.
 *
 * The deletion is queued (PendingDeletionStore) and only applied after the user
 * approves it via `/principle delete review`. The AI can never delete directly.
 */

import type { MetaAgentTool } from '../../../core/types.js'
import { createDeleteTool } from '../../../core/deletion/deleteToolFactory.js'
import type { PrincipleStore } from '../../PrincipleStore.js'

export function createPrincipleDeleteTool(store: PrincipleStore): MetaAgentTool {
  return createDeleteTool({
    name: 'principle_delete',
    mechanism: 'principle',
    reviewCommand: '/principle delete review',
    idDescription: 'ID of the principle to delete (e.g. "pr_..."), as returned by principle_search / principle_load.',
    description:
      'Propose deletion of a committed principle from the shared knowledge base. ' +
      'The entry is NOT deleted immediately — it is queued for the user to approve via `/principle delete review`. ' +
      'Use when a principle is incorrect, contradicted, or superseded. Identify it by its pr_ ID.',
    async resolve(id) {
      const entry = await store.load(id)
      return entry ? entry.title : null
    },
  })
}
