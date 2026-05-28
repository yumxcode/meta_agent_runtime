/**
 * AutoCompact unit tests
 *
 * Covers:
 *  - Recursion guard: skips when querySource is 'compact' or 'session_memory'
 *  - Global disable: skips when DISABLE_COMPACT / DISABLE_AUTO_COMPACT is set
 *  - Circuit breaker: stops after MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES (3) failures
 *  - Threshold: only runs when token count >= autoCompactThreshold
 *  - Success: resets tracking state, returns postCompactMessages
 *  - Failure: increments consecutiveFailures
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { autoCompactIfNeeded, type AutoCompactTrackingState } from '../compact/AutoCompact.js'
import type { KernelMessage } from '../types/KernelMessage.js'
import { FileStateCache } from '../session/FileStateCache.js'

// ── Mocks ──────────────────────────────────────────────────────────────────────
// Mock compactConversation so we don't need a live API

vi.mock('../compact/CompactConversation.js', () => ({
  compactConversation: vi.fn(),
}))

// Mock token count so we can control threshold behavior
vi.mock('../api/TokenCount.js', () => ({
  tokenCountWithEstimation: vi.fn(),
}))

import { compactConversation } from '../compact/CompactConversation.js'
import { tokenCountWithEstimation } from '../api/TokenCount.js'

const mockCompact = vi.mocked(compactConversation)
const mockTokenCount = vi.mocked(tokenCountWithEstimation)

// ── Helpers ────────────────────────────────────────────────────────────────────

const MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT = 32_768
// effectiveContextWindow = 200_000 - 20_000 = 180_000
// autoCompactThreshold = 180_000 - 13_000 = 167_000
const BELOW_THRESHOLD = 100_000
const ABOVE_THRESHOLD = 170_000

const COMPACT_OPTIONS = {
  model: 'claude-haiku-4-5-20251001',
  apiKey: 'test-key',
  querySource: 'compact' as const,
}

function makeMessages(n = 2): KernelMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    uuid: `uuid-${i}`,
    role: 'user' as const,
    content: [{ type: 'text' as const, text: `message ${i}` }],
  }))
}

function freshTracking(): AutoCompactTrackingState {
  return {
    compacted: false,
    turnId: 'turn-0',
    turnCounter: 0,
    consecutiveFailures: 0,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.clearAllMocks()
  delete process.env['DISABLE_COMPACT']
  delete process.env['DISABLE_AUTO_COMPACT']
})

describe('autoCompactIfNeeded — recursion guard', () => {
  it('skips when querySource is "compact"', async () => {
    mockTokenCount.mockReturnValue(ABOVE_THRESHOLD)
    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'compact', freshTracking(), MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(result.wasCompacted).toBe(false)
    expect(mockCompact).not.toHaveBeenCalled()
  })

  it('skips when querySource is "session_memory"', async () => {
    mockTokenCount.mockReturnValue(ABOVE_THRESHOLD)
    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'session_memory', freshTracking(), MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(result.wasCompacted).toBe(false)
    expect(mockCompact).not.toHaveBeenCalled()
  })

  it('does not skip for querySource "main"', async () => {
    mockTokenCount.mockReturnValue(ABOVE_THRESHOLD)
    mockCompact.mockResolvedValue({ postCompactMessages: makeMessages(1), summaryTokenEstimate: 0 })
    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'main', freshTracking(), MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(mockCompact).toHaveBeenCalledOnce()
    expect(result.wasCompacted).toBe(true)
  })
})

describe('autoCompactIfNeeded — global disable', () => {
  it('skips when DISABLE_COMPACT is set', async () => {
    process.env['DISABLE_COMPACT'] = '1'
    mockTokenCount.mockReturnValue(ABOVE_THRESHOLD)
    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'main', freshTracking(), MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(result.wasCompacted).toBe(false)
    expect(mockCompact).not.toHaveBeenCalled()
  })

  it('skips when DISABLE_AUTO_COMPACT is set', async () => {
    process.env['DISABLE_AUTO_COMPACT'] = 'true'
    mockTokenCount.mockReturnValue(ABOVE_THRESHOLD)
    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'main', freshTracking(), MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(result.wasCompacted).toBe(false)
  })
})

describe('autoCompactIfNeeded — circuit breaker', () => {
  it('skips after 3 consecutive failures', async () => {
    mockTokenCount.mockReturnValue(ABOVE_THRESHOLD)
    const brokenTracking: AutoCompactTrackingState = {
      ...freshTracking(),
      consecutiveFailures: 3,
    }
    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'main', brokenTracking, MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(result.wasCompacted).toBe(false)
    expect(mockCompact).not.toHaveBeenCalled()
  })

  it('runs when consecutiveFailures is 2 (below limit)', async () => {
    mockTokenCount.mockReturnValue(ABOVE_THRESHOLD)
    mockCompact.mockResolvedValue({ postCompactMessages: makeMessages(1), summaryTokenEstimate: 0 })
    const tracking: AutoCompactTrackingState = {
      ...freshTracking(),
      consecutiveFailures: 2,
    }
    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'main', tracking, MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(result.wasCompacted).toBe(true)
    expect(result.tracking.consecutiveFailures).toBe(0) // reset on success
  })
})

describe('autoCompactIfNeeded — threshold', () => {
  it('does not compact when below threshold', async () => {
    mockTokenCount.mockReturnValue(BELOW_THRESHOLD)
    const tracking = freshTracking()
    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'main', tracking, MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(result.wasCompacted).toBe(false)
    expect(mockCompact).not.toHaveBeenCalled()
  })

  it('increments turnCounter when below threshold', async () => {
    mockTokenCount.mockReturnValue(BELOW_THRESHOLD)
    const tracking = { ...freshTracking(), turnCounter: 4 }
    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'main', tracking, MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(result.tracking.turnCounter).toBe(5)
  })

  it('compacts when at or above threshold', async () => {
    mockTokenCount.mockReturnValue(ABOVE_THRESHOLD)
    mockCompact.mockResolvedValue({ postCompactMessages: makeMessages(1), summaryTokenEstimate: 0 })
    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'main', freshTracking(), MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(result.wasCompacted).toBe(true)
  })

  it('force-compacts even when below threshold', async () => {
    mockTokenCount.mockReturnValue(BELOW_THRESHOLD)
    mockCompact.mockResolvedValue({ postCompactMessages: makeMessages(1), summaryTokenEstimate: 123 })

    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'main', freshTracking(), MAX_OUTPUT, COMPACT_OPTIONS, true,
    )

    expect(result.wasCompacted).toBe(true)
    expect(result.summaryTokenEstimate).toBe(123)
  })
})

describe('autoCompactIfNeeded — success path', () => {
  it('returns postCompactMessages from compactConversation', async () => {
    const compacted = makeMessages(3)
    mockTokenCount.mockReturnValue(ABOVE_THRESHOLD)
    mockCompact.mockResolvedValue({ postCompactMessages: compacted, summaryTokenEstimate: 42 })

    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'main', freshTracking(), MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(result.wasCompacted).toBe(true)
    expect(result.postCompactMessages).toBe(compacted)
    expect(result.summaryTokenEstimate).toBe(42)
  })

  it('resets tracking state on success', async () => {
    mockTokenCount.mockReturnValue(ABOVE_THRESHOLD)
    mockCompact.mockResolvedValue({ postCompactMessages: makeMessages(1), summaryTokenEstimate: 0 })
    const tracking = { ...freshTracking(), turnCounter: 10, consecutiveFailures: 2 }

    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'main', tracking, MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(result.tracking.turnCounter).toBe(0)
    expect(result.tracking.consecutiveFailures).toBe(0)
    expect(result.tracking.compacted).toBe(true)
  })
})

describe('autoCompactIfNeeded — failure path', () => {
  it('increments consecutiveFailures on compact error', async () => {
    mockTokenCount.mockReturnValue(ABOVE_THRESHOLD)
    mockCompact.mockRejectedValue(new Error('API error'))

    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'main', freshTracking(), MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(result.wasCompacted).toBe(false)
    expect(result.tracking.consecutiveFailures).toBe(1)
  })

  it('accumulates consecutiveFailures across multiple failures', async () => {
    mockTokenCount.mockReturnValue(ABOVE_THRESHOLD)
    mockCompact.mockRejectedValue(new Error('API error'))
    const tracking = { ...freshTracking(), consecutiveFailures: 1 }

    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'main', tracking, MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(result.tracking.consecutiveFailures).toBe(2)
  })
})

describe('autoCompactIfNeeded — undefined tracking', () => {
  it('initialises tracking state when undefined', async () => {
    mockTokenCount.mockReturnValue(BELOW_THRESHOLD)
    const result = await autoCompactIfNeeded(
      makeMessages(), MODEL, new FileStateCache(), 'main', undefined, MAX_OUTPUT, COMPACT_OPTIONS,
    )
    expect(result.tracking).toBeDefined()
    expect(result.tracking.consecutiveFailures).toBe(0)
  })
})
