import type { MetaAgentTool } from '../../../core/types.js';
import type { ExperienceStore } from '../../ExperienceStore.js';
import { type ExperiencePendingStore } from '../../ExperiencePendingStore.js';
import type { FlashClient } from '../../../core/flash/FlashClient.js';
/**
 * @param store        The shared cross-session ExperienceStore (NOT written to directly).
 * @param pendingStore Session-scoped buffer — experiences queue here until the
 *                     user reviews and approves them via `/experience review`.
 * @param flash        Optional FlashClient for abstract principle extraction.
 *                     If provided, a 3s flash call extracts the same-domain
 *                     principle at write time.
 */
export declare function createExperienceWriteTool(_store: ExperienceStore, pendingStore: ExperiencePendingStore, flash?: FlashClient): MetaAgentTool;
//# sourceMappingURL=index.d.ts.map