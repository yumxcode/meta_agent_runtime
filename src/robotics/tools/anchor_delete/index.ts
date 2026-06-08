/**
 * anchor_delete — propose deletion of a committed physical anchor entry.
 *
 * The deletion is queued (PendingDeletionStore) and only applied after the user
 * approves it via `/anchor delete review`. The AI can never delete directly.
 */

import type { MetaAgentTool } from '../../../core/types.js'
import { createDeleteTool } from '../../../core/deletion/deleteToolFactory.js'
import type { PhysicalAnchorStore } from '../../PhysicalAnchorStore.js'

export function createPhysicalAnchorDeleteTool(store: PhysicalAnchorStore): MetaAgentTool {
  return createDeleteTool({
    name: 'anchor_delete',
    mechanism: 'anchor',
    reviewCommand: '/anchor delete review',
    idDescription: 'ID of the physical anchor to delete (e.g. "pa_..."), as returned by physical_anchor_search / physical_anchor_load.',
    description:
      'Propose deletion of a committed physical anchor (device/physical fact) from the shared knowledge base. ' +
      'The entry is NOT deleted immediately — it is queued for the user to approve via `/anchor delete review`. ' +
      'Use when a physical fact is wrong or no longer applies. Identify it by its pa_ ID.',
    async resolve(id) {
      const entry = await store.load(id)
      return entry ? (entry.title ?? entry.id) : null
    },
  })
}
