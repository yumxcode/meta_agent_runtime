/**
 * Meta-Agent Memory — file I/O and prompt assembly
 *
 * Mirrors Claude Code's memdir.ts structure:
 *   - truncateEntrypointContent()   same 200-line / 25 KB caps + warning message
 *   - ensureMemoryDirExists()       mkdir -p, idempotent
 *   - loadMemoryIndex()             reads and truncates MEMORY.md
 *   - buildMemoryGuidanceLines()    static guidance text (taxonomy + write protocol)
 */
/** Maximum lines loaded from MEMORY.md (index). */
export declare const MAX_ENTRYPOINT_LINES = 200;
/** Maximum bytes loaded from MEMORY.md; catches long-line abuse. */
export declare const MAX_ENTRYPOINT_BYTES = 25000;
export type EntrypointTruncation = {
    content: string;
    lineCount: number;
    byteCount: number;
    wasLineTruncated: boolean;
    wasByteTruncated: boolean;
};
/**
 * Truncate MEMORY.md content to the line AND byte caps, appending a warning
 * message that names which cap fired.  Line-truncates first (natural boundary),
 * then byte-truncates at the last newline before the cap so we never cut mid-line.
 *
 * Identical algorithm to CC's truncateEntrypointContent().
 */
export declare function truncateEntrypointContent(raw: string): EntrypointTruncation;
/**
 * Ensure the memory directory exists.  Idempotent — called once per session
 * from the memory section resolver.  The model can write directly with the
 * Write tool without checking for directory existence.
 */
export declare function ensureMemoryDirExists(): Promise<void>;
/**
 * Read MEMORY.md and apply truncation caps.  Returns null when the file does
 * not exist or is empty.
 */
export declare function loadMemoryIndex(): Promise<string | null>;
/**
 * Build the static guidance text block injected into the system prompt.
 * Contains: directory location, taxonomy, what not to save, write protocol,
 * when to access, and the engineering drift caveat.
 *
 * This text never changes within a session and is safe to memoize.
 */
export declare function buildMemoryGuidanceLines(memoryDir?: string): string[];
//# sourceMappingURL=memdir.d.ts.map