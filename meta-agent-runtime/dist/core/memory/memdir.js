/**
 * Meta-Agent Memory — file I/O and prompt assembly
 *
 * Mirrors Claude Code's memdir.ts structure:
 *   - truncateEntrypointContent()   same 200-line / 25 KB caps + warning message
 *   - ensureMemoryDirExists()       mkdir -p, idempotent
 *   - loadMemoryIndex()             reads and truncates MEMORY.md
 *   - buildMemoryGuidanceLines()    static guidance text (taxonomy + write protocol)
 */
import { mkdir, readFile } from 'fs/promises';
import { MEMORY_DIR, MEMORY_ENTRYPOINT_NAME, getMemoryEntrypoint, } from './paths.js';
import { TYPES_SECTION, WHAT_NOT_TO_SAVE_SECTION, WHEN_TO_ACCESS_SECTION, TRUSTING_RECALL_SECTION, DRIFT_CAVEAT, HOW_TO_SAVE_SECTION, } from './types.js';
// ─────────────────────────────────────────────────────────────────────────────
// Truncation constants — identical to CC
// ─────────────────────────────────────────────────────────────────────────────
/** Maximum lines loaded from MEMORY.md (index). */
export const MAX_ENTRYPOINT_LINES = 200;
/** Maximum bytes loaded from MEMORY.md; catches long-line abuse. */
export const MAX_ENTRYPOINT_BYTES = 25_000;
/**
 * Truncate MEMORY.md content to the line AND byte caps, appending a warning
 * message that names which cap fired.  Line-truncates first (natural boundary),
 * then byte-truncates at the last newline before the cap so we never cut mid-line.
 *
 * Identical algorithm to CC's truncateEntrypointContent().
 */
export function truncateEntrypointContent(raw) {
    const trimmed = raw.trim();
    const contentLines = trimmed.split('\n');
    const lineCount = contentLines.length;
    // Use byte length for the cap check — long lines are the failure mode the
    // byte cap targets, so post-line-truncation size would understate the warning.
    const byteCount = Buffer.byteLength(trimmed, 'utf-8');
    const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
    const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;
    if (!wasLineTruncated && !wasByteTruncated) {
        return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated };
    }
    // Step 1: line truncation
    let truncated = wasLineTruncated
        ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
        : trimmed;
    // Step 2: byte truncation — cut at the last newline before the cap
    if (Buffer.byteLength(truncated, 'utf-8') > MAX_ENTRYPOINT_BYTES) {
        const buf = Buffer.from(truncated, 'utf-8');
        const sliced = buf.slice(0, MAX_ENTRYPOINT_BYTES);
        const lastNewline = sliced.lastIndexOf(0x0a /* '\n' */);
        truncated = sliced.slice(0, lastNewline > 0 ? lastNewline : MAX_ENTRYPOINT_BYTES).toString('utf-8');
    }
    const reason = wasLineTruncated && wasByteTruncated
        ? `${lineCount} lines and ${byteCount} bytes`
        : wasLineTruncated
            ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
            : `${byteCount} bytes (limit: ${MAX_ENTRYPOINT_BYTES})`;
    return {
        content: truncated +
            `\n\n> WARNING: ${MEMORY_ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded.` +
            ` Keep index entries to one line under ~150 chars; move detail into topic files.`,
        lineCount,
        byteCount,
        wasLineTruncated,
        wasByteTruncated,
    };
}
// ─────────────────────────────────────────────────────────────────────────────
// Directory management
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Ensure the memory directory exists.  Idempotent — called once per session
 * from the memory section resolver.  The model can write directly with the
 * Write tool without checking for directory existence.
 */
export async function ensureMemoryDirExists() {
    try {
        await mkdir(MEMORY_DIR, { recursive: true });
    }
    catch {
        // mkdir recursive already swallows EEXIST.
        // Real permission errors (EACCES, EPERM) surface on first model Write call.
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// MEMORY.md loading
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Read MEMORY.md and apply truncation caps.  Returns null when the file does
 * not exist or is empty.
 */
export async function loadMemoryIndex() {
    try {
        const raw = await readFile(getMemoryEntrypoint(), 'utf-8');
        if (!raw.trim())
            return null;
        return truncateEntrypointContent(raw).content;
    }
    catch {
        // File not yet created — normal on first run
        return null;
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Guidance text builder
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build the static guidance text block injected into the system prompt.
 * Contains: directory location, taxonomy, what not to save, write protocol,
 * when to access, and the engineering drift caveat.
 *
 * This text never changes within a session and is safe to memoize.
 */
export function buildMemoryGuidanceLines(memoryDir = MEMORY_DIR) {
    return [
        '# 工程记忆系统',
        '',
        `你拥有一个基于文件的持久记忆系统，位于 \`${memoryDir}\`。`,
        '该目录已存在——使用 Write 工具直接写入（无需先运行 mkdir）。',
        '',
        '随时间积累记忆，让未来的会话能够获取用户背景、已验证的领域知识，',
        '以及过往 campaign 的经验教训。记忆跨项目、跨会话持久保存。',
        '',
        ...TYPES_SECTION,
        ...WHAT_NOT_TO_SAVE_SECTION,
        '',
        ...HOW_TO_SAVE_SECTION,
        '',
        ...WHEN_TO_ACCESS_SECTION,
        '',
        ...TRUSTING_RECALL_SECTION,
        '',
        ...DRIFT_CAVEAT,
    ];
}
//# sourceMappingURL=memdir.js.map