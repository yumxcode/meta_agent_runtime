/**
 * Provenance query tools — 路径②
 *
 * These tools let Claude query the provenance store directly during a session,
 * closing the loop from stored audit trail back into the agent context.
 *
 * Usage:
 *   const tools = await createProvenanceTools(rtx.provenanceTracker)
 *   for (const t of tools) session.registerTool(t)
 */
import { createGetProvenanceTool } from './get_provenance/index.js';
import { createListRecentTool } from './list_recent/index.js';
import { createFindDuplicateTool } from './find_duplicate/index.js';
import { createGetLineageTool } from './get_lineage/index.js';
export { createGetProvenanceTool } from './get_provenance/index.js';
export { createListRecentTool } from './list_recent/index.js';
export { createFindDuplicateTool } from './find_duplicate/index.js';
export { createGetLineageTool } from './get_lineage/index.js';
/**
 * Create all four provenance query tools bound to a specific tracker instance.
 *
 * Returns:
 *   - get_provenance                — fetch full record by ID
 *   - list_recent_results           — list / filter recent records
 *   - find_duplicate_computation    — dedup check before calling an expensive tool
 *   - get_computation_lineage       — trace ancestor chain to root
 */
export async function createProvenanceTools(tracker) {
    return Promise.all([
        createGetProvenanceTool(tracker),
        createListRecentTool(tracker),
        createFindDuplicateTool(tracker),
        createGetLineageTool(tracker),
    ]);
}
//# sourceMappingURL=index.js.map