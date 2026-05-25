/**
 * Meta-Agent Memory — file I/O and prompt assembly
 *
 * Mirrors Claude Code's memdir.ts structure:
 *   - truncateEntrypointContent()   same 200-line / 25 KB caps + warning message
 *   - ensureMemoryDirExists()       mkdir -p, idempotent
 *   - loadMemoryIndex()             reads and truncates MEMORY.md
 *   - buildMemoryGuidanceLines()    static guidance text (taxonomy + write protocol)
 */

import { mkdir, readFile } from 'fs/promises'
import {
  MEMORY_DIR,
  MEMORY_ENTRYPOINT_NAME,
  getMemoryEntrypoint,
} from './paths.js'
// types.ts exports the full taxonomy/write-protocol constants (TYPES_SECTION,
// HOW_TO_SAVE_SECTION, etc.) for tests and doc generation — not injected every
// turn since buildMemoryGuidanceLines now uses a compact reference card.

// ─────────────────────────────────────────────────────────────────────────────
// Truncation constants — identical to CC
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum lines loaded from MEMORY.md (index). */
export const MAX_ENTRYPOINT_LINES = 200
/** Maximum bytes loaded from MEMORY.md; catches long-line abuse. */
export const MAX_ENTRYPOINT_BYTES = 25_000

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

/**
 * Truncate MEMORY.md content to the line AND byte caps, appending a warning
 * message that names which cap fired.  Line-truncates first (natural boundary),
 * then byte-truncates at the last newline before the cap so we never cut mid-line.
 *
 * Identical algorithm to CC's truncateEntrypointContent().
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed.split('\n')
  const lineCount = contentLines.length
  // Use byte length for the cap check — long lines are the failure mode the
  // byte cap targets, so post-line-truncation size would understate the warning.
  const byteCount = Buffer.byteLength(trimmed, 'utf-8')

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated }
  }

  // Step 1: line truncation
  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  // Step 2: byte truncation — cut at the last newline before the cap
  if (Buffer.byteLength(truncated, 'utf-8') > MAX_ENTRYPOINT_BYTES) {
    const buf = Buffer.from(truncated, 'utf-8')
    const sliced = buf.slice(0, MAX_ENTRYPOINT_BYTES)
    const lastNewline = sliced.lastIndexOf(0x0a /* '\n' */)
    truncated = sliced.slice(0, lastNewline > 0 ? lastNewline : MAX_ENTRYPOINT_BYTES).toString('utf-8')
  }

  const reason =
    wasLineTruncated && wasByteTruncated
      ? `${lineCount} lines and ${byteCount} bytes`
      : wasLineTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${byteCount} bytes (limit: ${MAX_ENTRYPOINT_BYTES})`

  return {
    content:
      truncated +
      `\n\n> WARNING: ${MEMORY_ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded.` +
      ` Keep index entries to one line under ~150 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure the memory directory exists.  Idempotent — called once per session
 * from the memory section resolver.  The model can write directly with the
 * Write tool without checking for directory existence.
 */
export async function ensureMemoryDirExists(): Promise<void> {
  try {
    await mkdir(MEMORY_DIR, { recursive: true })
  } catch {
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
export async function loadMemoryIndex(): Promise<string | null> {
  try {
    const raw = await readFile(getMemoryEntrypoint(), 'utf-8')
    if (!raw.trim()) return null
    return truncateEntrypointContent(raw).content
  } catch {
    // File not yet created — normal on first run
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guidance text builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the static guidance text block injected into the system prompt.
 *
 * Deliberately compact (~200 words) so it does not dominate the prompt on
 * every turn.  The full taxonomy, write protocol, and drift caveats live in
 * types.ts and are available for deep inspection; this card is the "always
 * visible" reference that covers the 95 % case.
 */
export function buildMemoryGuidanceLines(memoryDir: string = MEMORY_DIR): string[] {
  return [
    '## 工程记忆系统',
    '',
    `持久记忆目录：\`${memoryDir}\`（直接用 Write 工具写入，无需 mkdir）。`,
    '记忆跨会话持久保存。召回通过 MEMORY.md 索引 + 按查询相关性加载话题文件。',
    '',
    '**类型速查**（选最匹配的一种）：',
    '- `user` — 用户角色、背景、协作偏好',
    '- `feedback` — 用户对工作方式的纠正或确认（两者都记）',
    '- `domain_knowledge` — 已验证的物理常数/标准/材料属性（须注明来源）',
    '- `campaign_lessons` — 已完成 campaign 的可迁移经验（REPORTING 阶段后保存）',
    '- `robot_lessons` — robotics mode 中可迁移的错误、警告、避坑经验',
    '- `reference` — 外部资源指针（API 端点、文档 URL）',
    '',
    '**Campaign mode 硬边界**：',
    '① 仿真/计算结果 → provenance tracker（prov-xxx ID）',
    '② 活跃 campaign 状态 → campaign_context（实时注入）',
    '③ 项目专属参数 → campaign 配置文件',
    '',
    '**Robotics mode 硬边界**：成熟工程经验 → ExperienceStore；memory 只记公共偏好、警告和错误模式。',
    '',
    '**保存两步**：① 写 `<name>.md`（含 frontmatter: name/type/date）',
    '② 在 `MEMORY.md` 加一行指针。写前先扫 MEMORY.md 确认无重复条目。',
    '',
    '**使用前验证**：记忆中的路径/函数/数值反映写入时状态，不代表现在仍有效。',
    '数值用于计算前须核对来源；无法核实时注明"来自记忆，未核实"。',
  ]
}
