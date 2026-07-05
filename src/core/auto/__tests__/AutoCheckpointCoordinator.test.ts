import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AutoCheckpointCoordinator } from '../AutoCheckpointCoordinator.js'
import { readAutoCheckpoint, writeAutoCheckpoint, AUTO_CHECKPOINT_SCHEMA_VERSION } from '../AutoCheckpointStore.js'

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
      expect(readAutoCheckpoint(dir, 's1')).toMatchObject({
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

  it('generates an edit digest after N FS-only checkpoints and folds it into the next write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-cp-digest-'))
    try {
      const calls: string[][] = []
      let digestReady: Promise<string> | undefined
      const coordinator = new AutoCheckpointCoordinator({
        projectDir: dir,
        fsOnlyDigestThreshold: 3,
        // Resolve on a later tick to mimic a real (async) LLM side-call.
        summarizeEdits: paths => {
          calls.push(paths)
          digestReady = new Promise(resolve => {
            setTimeout(() => resolve('EDIT_DIGEST'), 5)
          })
          return digestReady
        },
        getSnapshot: () => ({ completedSteps: [], pendingTodos: [], artifacts: [], activeSubAgentIds: [] }),
      })
      const fsFlush = (n: number, path: string) => coordinator.flush({
        type: 'tool_batch_completed',
        sessionId: 's1',
        toolBatchCount: n,
        estimatedCostUsd: 0,
        successfulToolNames: ['edit_file'],
        mutatedPaths: [path],
      })

      await fsFlush(1, 'a.ts')
      await fsFlush(2, 'b.ts')
      await fsFlush(3, 'c.ts')                  // threshold reached → digest fired (async)
      // Digest not ready yet, so the threshold write carries no summary.
      expect(readAutoCheckpoint(dir, 's1')?.autoEditSummary).toBeUndefined()

      await digestReady
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual(['a.ts', 'b.ts', 'c.ts'])  // unioned paths of the streak

      await fsFlush(4, 'd.ts')                  // next write folds in the pending digest
      expect(readAutoCheckpoint(dir, 's1')?.autoEditSummary).toBe('EDIT_DIGEST')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resets the FS-only streak when a state tool reports progress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-cp-digest-reset-'))
    try {
      const calls: string[][] = []
      const coordinator = new AutoCheckpointCoordinator({
        projectDir: dir,
        fsOnlyDigestThreshold: 3,
        summarizeEdits: async paths => { calls.push(paths); return 'D' },
        getSnapshot: () => ({ completedSteps: [], pendingTodos: [], artifacts: [], activeSubAgentIds: [] }),
      })
      const flush = (n: number, path: string, names: string[]) => coordinator.flush({
        type: 'tool_batch_completed',
        sessionId: 's1',
        toolBatchCount: n,
        estimatedCostUsd: 0,
        successfulToolNames: names,
        mutatedPaths: [path],
      })

      await flush(1, 'a.ts', ['edit_file'])
      await flush(2, 'b.ts', ['edit_file'])
      await flush(3, 'c.ts', ['edit_file', 'todo_write'])  // state tool → streak resets
      await flush(4, 'd.ts', ['edit_file'])
      await flush(5, 'e.ts', ['edit_file'])
      await new Promise(r => setTimeout(r, 10))

      // Never reached 3 CONSECUTIVE FS-only checkpoints, so no digest was generated.
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('counts lifecycle boundaries (verify/drift/compact) and stamps recency', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-cp-health-'))
    try {
      const coordinator = new AutoCheckpointCoordinator({
        projectDir: dir,
        getSnapshot: () => ({ completedSteps: [], pendingTodos: [], artifacts: [], activeSubAgentIds: [] }),
      })
      const flush = (type: string, toolBatchCount: number) => coordinator.flush({
        type: type as never,
        sessionId: 's1',
        toolBatchCount,
        estimatedCostUsd: 0,
      })

      await flush('verify_rejected', 5)
      await flush('drift_corrected', 8)
      await flush('compact_before', 10)
      await flush('compact_after', 10)   // must NOT double-count the compaction
      await flush('verify_rejected', 12)

      expect(readAutoCheckpoint(dir, 's1')).toMatchObject({
        verifyRejections: 2,
        driftCorrections: 1,
        compactions: 1,
        lastVerifyRejectTurn: 12,
        lastDriftCorrectionTurn: 8,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resumes run-health counters from a prior checkpoint (monotonic)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-cp-health-resume-'))
    try {
      const coordinator = new AutoCheckpointCoordinator({
        projectDir: dir,
        initialRunHealth: { verifyRejections: 3, driftCorrections: 2, compactions: 1 },
        getSnapshot: () => ({ completedSteps: [], pendingTodos: [], artifacts: [], activeSubAgentIds: [] }),
      })

      await coordinator.flush({
        type: 'drift_corrected',
        sessionId: 's1',
        toolBatchCount: 40,
        estimatedCostUsd: 0,
      })

      expect(readAutoCheckpoint(dir, 's1')).toMatchObject({
        verifyRejections: 3,             // carried from resume, untouched
        driftCorrections: 3,             // 2 (seed) + 1
        compactions: 1,
        lastDriftCorrectionTurn: 40,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a re-anchor (reset + hard write) clears run-health without regressing the revision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-cp-reset-'))
    try {
      const coordinator = new AutoCheckpointCoordinator({
        projectDir: dir,
        getSnapshot: () => ({ completedSteps: [], pendingTodos: [], artifacts: [], activeSubAgentIds: [] }),
      })

      // Build up run-health and several revisions on "task 1".
      await coordinator.flush({ type: 'verify_rejected', sessionId: 's1', toolBatchCount: 5, estimatedCostUsd: 0 })
      await coordinator.flush({ type: 'drift_corrected', sessionId: 's1', toolBatchCount: 8, estimatedCostUsd: 0 })
      const rev = coordinator.latestRevision
      expect(rev).toBeGreaterThan(0)

      // Re-anchor to "task 2", mirroring SessionRouter._reanchorAutoGoal exactly:
      //   1. reset the coordinator's in-memory run-scoped state, AND
      //   2. hard-write a fresh checkpoint at the CURRENT revision (not 0).
      coordinator.resetRunScopedState()
      expect(coordinator.latestRevision).toBe(rev)  // reset never touches the revision
      await writeAutoCheckpoint(dir, {
        schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
        sessionId: 's1',
        updatedAt: Date.now(),
        revision: coordinator.latestRevision,
        goal: 'task two',
      })

      // The new task's first durable write must advance the revision (no drift
      // starvation) and carry NONE of the prior task's run-health.
      await coordinator.flush({ type: 'tool_batch_completed', sessionId: 's1', toolBatchCount: 9, estimatedCostUsd: 0, successfulToolNames: ['edit_file'] })
      const cp = readAutoCheckpoint(dir, 's1')
      expect(cp?.revision).toBe(rev + 1)            // monotonic advance, NOT reset to 1
      expect(cp?.goal).toBe('task two')
      expect(cp?.verifyRejections ?? 0).toBe(0)
      expect(cp?.driftCorrections ?? 0).toBe(0)
      expect(cp?.lastVerifyRejectTurn).toBeUndefined()
      expect(cp?.lastDriftCorrectionTurn).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('discards an in-flight edit digest generated before a re-anchor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-cp-reset-digest-'))
    try {
      const coordinator = new AutoCheckpointCoordinator({
        projectDir: dir,
        fsOnlyDigestThreshold: 2,
        summarizeEdits: paths => new Promise(resolve => {
          setTimeout(() => resolve(`digest:${paths.join(',')}`), 10)
        }),
        getSnapshot: () => ({ completedSteps: [], pendingTodos: [], artifacts: [], activeSubAgentIds: [] }),
      })
      const fs = (n: number, p: string) => coordinator.flush({
        type: 'tool_batch_completed', sessionId: 's1', toolBatchCount: n,
        estimatedCostUsd: 0, successfulToolNames: ['edit_file'], mutatedPaths: [p],
      })

      await fs(1, 'old1.ts')
      await fs(2, 'old2.ts')          // threshold → digest fires (resolves in ~10ms)
      coordinator.resetRunScopedState() // re-anchor before the digest resolves
      await new Promise(r => setTimeout(r, 25))

      // The stale digest about old files must not land on the new goal's write.
      await fs(3, 'new1.ts')
      expect(readAutoCheckpoint(dir, 's1')?.autoEditSummary).toBeUndefined()
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
      expect(readAutoCheckpoint(dir, 's1')).toMatchObject({
        revision: 1,
        lastBoundary: 'external_after',
        estimatedCostUsd: 0.2,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
