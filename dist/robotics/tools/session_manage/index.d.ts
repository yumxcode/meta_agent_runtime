/**
 * Session management tools — list, star, tag.
 *
 *   session_list  — list all persisted sessions with star/tag/idle info
 *   session_star  — star or unstar a session (starred sessions skip auto-purge)
 *   session_tag   — set the tags for a session
 */
import type { MetaAgentTool } from '../../../core/types.js';
export declare function createSessionListTool(): MetaAgentTool;
export declare function createSessionStarTool(): MetaAgentTool;
export declare function createSessionTagTool(): MetaAgentTool;
//# sourceMappingURL=index.d.ts.map