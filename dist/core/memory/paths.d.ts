/**
 * Meta-Agent Memory — path constants
 *
 * Single global memory directory: ~/.claude/meta-agent/memory/
 *
 * Unlike Claude Code (per-project paths), meta-agent memory is global because
 * domain_knowledge, campaign_lessons, and robot_lessons must be shared across
 * engineering projects and sessions.
 * Per-project isolation can be added later via a subdirectory overlay if needed.
 */
/** Root directory for all meta-agent memory files. Created on first use. */
export declare const MEMORY_DIR: string;
/** Filename of the index file that is always loaded into the system prompt. */
export declare const MEMORY_ENTRYPOINT_NAME = "MEMORY.md";
/** Full path to the MEMORY.md index file. */
export declare function getMemoryEntrypoint(): string;
//# sourceMappingURL=paths.d.ts.map