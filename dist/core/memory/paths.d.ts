/**
 * Meta-Agent Memory — path constants
 *
 * Single global memory directory: ~/.claude/meta-agent/memory/
 *
 * Memory is global and intentionally limited to user profile / feedback entries.
 * Engineering knowledge lives in ExperienceStore, provenance, project docs, or
 * AGENT.md rather than in memory.
 */
/** Root directory for all meta-agent memory files. Created on first use. */
export declare const MEMORY_DIR: string;
/** Filename of the index file that is always loaded into the system prompt. */
export declare const MEMORY_ENTRYPOINT_NAME = "MEMORY.md";
/** Full path to the MEMORY.md index file. */
export declare function getMemoryEntrypoint(): string;
//# sourceMappingURL=paths.d.ts.map