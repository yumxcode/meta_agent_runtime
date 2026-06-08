/**
 * experience_delete — propose deletion of a committed experience entry.
 *
 * The deletion is queued (PendingDeletionStore) and only applied after the user
 * approves it via `/experience delete review`. The AI can never delete directly.
 */

import type { MetaAgentTool } from '../../../core/types.js'
import { createDeleteTool } from '../../../core/deletion/deleteToolFactory.js'
import type { ExperienceStore } from '../../ExperienceStore.js'

export function createExperienceDeleteTool(store: ExperienceStore): MetaAgentTool {
  return createDeleteTool({
    name: 'experience_delete',
    mechanism: 'experience',
    reviewCommand: '/experience delete review',
    idDescription: 'ID of the experience to delete (e.g. "exp_..."), as returned by experience_search / experience_load.',
    description:
      'Propose deletion of a committed experience entry from the shared knowledge base. ' +
      'The entry is NOT deleted immediately — it is queued for the user to approve via `/experience delete review`. ' +
      'Use when an experience is wrong, superseded, or duplicated. Identify it by its exp_ ID.',
    async resolve(id) {
      const entry = await store.load(id)
      return entry ? entry.title : null
    },
  })
}
