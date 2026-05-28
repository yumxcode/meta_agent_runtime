import type { AgentMode } from '../../../core/dynamicPrompt.js';
import type { MetaAgentTool } from '../../../core/types.js';
/**
 * List all unique skill names across all skill directories.
 * Earlier directories take precedence (de-duplication preserves first occurrence).
 */
export declare function listAllSkillNames(cwd: string, mode: AgentMode): Promise<string[]>;
/**
 * Read a skill by name. Searches directories in priority order; returns the
 * contents of the first match, or null if not found anywhere.
 */
export declare function readSkill(name: string, cwd: string, mode: AgentMode): Promise<string | null>;
/**
 * Extract a short description from skill content.
 * Tries YAML frontmatter `description:` first, then the first non-heading
 * non-empty line, truncated to 80 chars.
 */
export declare function extractSkillDescription(content: string): string;
export declare function createSkillTool(cwd?: string, mode?: AgentMode): Promise<MetaAgentTool>;
//# sourceMappingURL=index.d.ts.map