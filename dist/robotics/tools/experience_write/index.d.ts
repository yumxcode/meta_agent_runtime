import type { MetaAgentTool } from '../../../core/types.js';
import type { ExperienceStore } from '../../ExperienceStore.js';
import type { ExperiencePendingStore } from '../../ExperiencePendingStore.js';
/**
 * @param store        The shared cross-session ExperienceStore (NOT written to directly).
 * @param pendingStore Session-scoped buffer — experiences queue here until the
 *                     user reviews and approves them via `/experience review`.
 *                     This prevents premature or low-quality entries from
 *                     polluting the shared knowledge base.
 */
export declare function createExperienceWriteTool(store: ExperienceStore, pendingStore: ExperiencePendingStore): MetaAgentTool;
//# sourceMappingURL=index.d.ts.map