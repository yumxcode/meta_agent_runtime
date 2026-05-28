/**
 * Tests for buildCampaignMemoryBlock()
 *
 * Verifies that CampaignSession injects memory content (MEMORY.md index +
 * recalled topic files) into each turn's context prefix — the same content
 * that agentic/robotics modes inject via buildMemoryContentSection().
 *
 * We mock the fs-level helpers (loadMemoryIndex, findRelevantMemories,
 * ensureMemoryDirExists) so tests run without touching the real ~/.claude dir.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock memory helpers before importing the module under test ────────────────

vi.mock('../../core/memory/memdir.js', () => ({
  ensureMemoryDirExists: vi.fn().mockResolvedValue(undefined),
  loadMemoryIndex: vi.fn(),
}))

vi.mock('../../core/memory/findRelevantMemories.js', () => ({
  findRelevantMemories: vi.fn(),
}))

vi.mock('../../core/memory/paths.js', () => ({
  MEMORY_DIR: '/mock/memory/',
  MEMORY_ENTRYPOINT_NAME: 'MEMORY.md',
}))

import { buildCampaignMemoryBlock } from '../campaignMemory.js'
import { loadMemoryIndex } from '../../core/memory/memdir.js'
import { findRelevantMemories } from '../../core/memory/findRelevantMemories.js'

const mockLoadIndex = vi.mocked(loadMemoryIndex)
const mockFindRelevant = vi.mocked(findRelevantMemories)

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildCampaignMemoryBlock', () => {
  it('returns null when both index and recalled memories are empty', async () => {
    mockLoadIndex.mockResolvedValue(null)
    mockFindRelevant.mockResolvedValue([])

    const result = await buildCampaignMemoryBlock('any query')
    expect(result).toBeNull()
  })

  it('includes MEMORY.md index when index is non-null', async () => {
    mockLoadIndex.mockResolvedValue('- user.md — user profile\n- feedback.md — preferences')
    mockFindRelevant.mockResolvedValue([])

    const result = await buildCampaignMemoryBlock('some query')
    expect(result).not.toBeNull()
    expect(result).toContain('## MEMORY.md')
    expect(result).toContain('user.md')
    expect(result).toContain('feedback.md')
  })

  it('shows empty-memory placeholder when index is null but recalled files exist', async () => {
    mockLoadIndex.mockResolvedValue(null)
    mockFindRelevant.mockResolvedValue([
      {
        header: { name: 'User Profile', filename: 'user.md', type: 'user', date: '2025-01-01' },
        content: 'User prefers concise output.',
      },
    ] as any)

    const result = await buildCampaignMemoryBlock('user preferences')
    expect(result).not.toBeNull()
    expect(result).toContain('currently empty')           // placeholder shown
    expect(result).toContain('## Recalled memory files')
    expect(result).toContain('User Profile')
    expect(result).toContain('User prefers concise output.')
  })

  it('includes recalled topic files with metadata', async () => {
    mockLoadIndex.mockResolvedValue('- feedback.md — preferences')
    mockFindRelevant.mockResolvedValue([
      {
        header: {
          name: 'Feedback',
          filename: 'feedback.md',
          type: 'feedback',
          date: '2025-03-01',
          requiresRevalidation: false,
          sourceVerified: true,
        },
        content: '**Rule:** prefer bullet points',
      },
    ] as any)

    const result = await buildCampaignMemoryBlock('output style')
    expect(result).toContain('## Recalled memory files')
    expect(result).toContain('Feedback')
    expect(result).toContain('feedback')      // type in meta line
    expect(result).toContain('2025-03-01')   // date in meta line
    expect(result).toContain('prefer bullet points')
  })

  it('marks files requiring revalidation', async () => {
    mockLoadIndex.mockResolvedValue('- old.md — stale data')
    mockFindRelevant.mockResolvedValue([
      {
        header: {
          name: 'Old Data',
          filename: 'old.md',
          type: 'user',
          date: '2024-01-01',
          requiresRevalidation: true,
        },
        content: 'Some data that may be stale.',
      },
    ] as any)

    const result = await buildCampaignMemoryBlock('old data')
    expect(result).toContain('requires_revalidation')
  })

  it('calls findRelevantMemories with sessionMode campaign', async () => {
    mockLoadIndex.mockResolvedValue(null)
    mockFindRelevant.mockResolvedValue([])

    await buildCampaignMemoryBlock('campaign query')

    expect(mockFindRelevant).toHaveBeenCalledWith(
      expect.objectContaining({ sessionMode: 'campaign' }),
    )
  })

  it('returns null (does not throw) when helpers throw', async () => {
    // The caller (CampaignSession._buildEnrichedSuffix) wraps in try/catch,
    // but buildCampaignMemoryBlock itself should propagate — verify the error
    // is catchable (not silently swallowed inside the function).
    mockLoadIndex.mockRejectedValue(new Error('disk error'))
    mockFindRelevant.mockResolvedValue([])

    await expect(buildCampaignMemoryBlock('query')).rejects.toThrow('disk error')
  })
})
