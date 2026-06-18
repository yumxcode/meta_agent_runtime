import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AutoCheckpointCoordinator } from '../AutoCheckpointCoordinator.js'
import { readAutoCheckpoint } from '../AutoCheckpointStore.js'

describe('AutoCheckpointCoordinator', () => {
  it('serialises writes and records trusted snapshot state with kernel counters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-cp-coord-'))
    try {
      let pendingTodos = ['first']
      const coordinator = new AutoCheckpointCoordinator({
        projectDir: dir,
        getSnapshot: () => ({
          goal: 'goal',
          completedSteps: [],
          pendingTodos,
          note: 'working',
          artifacts: [],
          activeSubAgentIds: [],
        }),
      })

      const first = await coordinator.flush({
        type: 'tool_batch_completed',
        sessionId: 's1',
        toolBatchCount: 3,
        estimatedCostUsd: 0.2,
        successfulToolNames: ['todo_write'],
      })
      pendingTodos = []
      const second = await coordinator.flush({
        type: 'termination',
        sessionId: 's1',
        toolBatchCount: 4,
        estimatedCostUsd: 0.3,
        stopReason: 'success',
      })

      expect(first).toEqual({ updated: true, revision: 1 })
      expect(second).toEqual({ updated: true, revision: 2 })
      expect(readAutoCheckpoint(dir)).toMatchObject({
        revision: 2,
        lastBoundary: 'termination',
        pendingTodos: [],
        turnCount: 4,
        estimatedCostUsd: 0.3,
        stopReason: 'success',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not advance revision when the checkpoint cannot be persisted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-cp-coord-fail-'))
    const invalidRoot = join(dir, 'not-a-directory')
    writeFileSync(invalidRoot, 'file')
    try {
      const coordinator = new AutoCheckpointCoordinator({
        projectDir: invalidRoot,
        getSnapshot: () => ({
          completedSteps: [],
          pendingTodos: [],
          artifacts: [],
          activeSubAgentIds: [],
        }),
      })

      await expect(coordinator.flush({
        type: 'termination',
        sessionId: 's1',
        toolBatchCount: 1,
        estimatedCostUsd: 0,
        stopReason: 'success',
      })).resolves.toEqual({ updated: false, revision: 0 })
      expect(coordinator.latestRevision).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('coalesces adjacent concurrent boundaries into one durable revision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-cp-coalesce-'))
    try {
      const coordinator = new AutoCheckpointCoordinator({
        projectDir: dir,
        getSnapshot: () => ({
          completedSteps: [],
          pendingTodos: [],
          artifacts: [],
          activeSubAgentIds: [],
        }),
      })
      const [before, after] = await Promise.all([
        coordinator.flush({
          type: 'external_before',
          sessionId: 's1',
          toolBatchCount: 2,
          estimatedCostUsd: 0.1,
          externalToolNames: ['mcp_call'],
        }),
        coordinator.flush({
          type: 'external_after',
          sessionId: 's1',
          toolBatchCount: 2,
          estimatedCostUsd: 0.2,
          externalToolNames: ['mcp_call'],
        }),
      ])
      expect(before.revision).toBe(1)
      expect(after.revision).toBe(1)
      expect(readAutoCheckpoint(dir)).toMatchObject({
        revision: 1,
        lastBoundary: 'external_after',
        estimatedCostUsd: 0.2,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
