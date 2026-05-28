/**
 * Campaign memory block builder.
 *
 * Builds the MEMORY.md + recalled topic files section for CampaignSession.
 * Extracted from _buildEnrichedSuffix() so it can be unit-tested independently.
 *
 * Mirrors the logic in buildMemoryContentSection() (dynamicPrompt.ts) but returns
 * a plain string instead of a SystemPromptSection — CampaignSession doesn't use
 * SectionRegistry for its per-turn context injection.
 */

import { ensureMemoryDirExists, loadMemoryIndex } from '../core/memory/memdir.js'
import { findRelevantMemories } from '../core/memory/findRelevantMemories.js'
import { MEMORY_DIR, MEMORY_ENTRYPOINT_NAME } from '../core/memory/paths.js'

/**
 * Build the memory context block for a campaign turn.
 *
 * @param prompt  The current user query — used for per-query relevance selection.
 * @returns       Markdown string with MEMORY.md index + recalled files, or null if
 *                both index and recalled list are empty (nothing to inject).
 */
export async function buildCampaignMemoryBlock(prompt: string): Promise<string | null> {
  await ensureMemoryDirExists()

  const [index, relevant] = await Promise.all([
    loadMemoryIndex(),
    findRelevantMemories({ query: prompt, memoryDir: MEMORY_DIR, sessionMode: 'campaign' }),
  ])

  // Nothing to show — omit the block entirely to keep the context clean
  if (!index && relevant.length === 0) return null

  const parts: string[] = []

  // MEMORY.md index
  parts.push(`## ${MEMORY_ENTRYPOINT_NAME}`, '')
  if (index) {
    parts.push(index)
  } else {
    parts.push(
      `Your ${MEMORY_ENTRYPOINT_NAME} is currently empty.`,
      'When you save memories, they will appear here as an index.',
    )
  }

  // Recalled topic files
  if (relevant.length > 0) {
    parts.push('', '## Recalled memory files', '')
    for (const mem of relevant) {
      const { header, content } = mem
      const metaParts: string[] = []
      if (header.type) metaParts.push(header.type)
      if (header.date)  metaParts.push(header.date)
      if (header.requiresRevalidation) metaParts.push('🔄 requires_revalidation')
      const meta = metaParts.join(' · ')
      parts.push(
        `### ${header.name}  (\`${header.filename}\`)`,
        meta ? `_${meta}_` : '',
        '',
        content,
        '',
      )
    }
  }

  return parts.join('\n')
}
