import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MetaAgentEvent } from '../../core/types.js'
import { writeAutoCheckpoint, AUTO_CHECKPOINT_SCHEMA_VERSION } from '../../core/auto/AutoCheckpointStore.js'

const mockState = vi.hoisted(() => ({
  reanchorOriginalGoal: vi.fn(),
  submitPrompts: [] as string[],
}))

vi.mock('../AgenticBackendFactory.js', () => ({
  createAgenticBackend: vi.fn(async () => ({
    session: {
      async *submit(prompt: string): AsyncGenerator<MetaAgentEvent> {
        mockState.submitPrompts.push(prompt)
      },
      registerTool: vi.fn(),
      interrupt: vi.fn(),
      reanchorOriginalGoal: mockState.reanchorOriginalGoal,
      getMessages: vi.fn(() => []),
      getUsage: vi.fn(() => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })),
      getEstimatedCost: vi.fn(() => 0),
      getSessionId: vi.fn(() => 'auto-goal-reanchor-test'),
    },
    bridge: null,
    checkpointCoordinator: {
      latestRevision: 0,
      resetRunScopedState: vi.fn(),
      flushDispose: vi.fn(),
    },
  })),
}))

import { SessionRouter } from '../SessionRouter.js'

async function drain(iter: AsyncGenerator<MetaAgentEvent>): Promise<void> {
  for await (const _ of iter) {
    // Drain the router generator.
  }
}

function tmpProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'meta-agent-auto-reanchor-'))
}

describe('SessionRouter auto goal re-anchor', () => {
  beforeEach(() => {
    mockState.reanchorOriginalGoal.mockClear()
    mockState.submitPrompts.length = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not re-anchor a resumed continuation prompt', async () => {
    const router = new SessionRouter({
      mode: 'auto',
      explicitResume: true,
      projectDir: tmpProjectDir(),
    })

    await drain(router.submit('继续'))

    expect(mockState.reanchorOriginalGoal).not.toHaveBeenCalled()
  })

  it('does not inject a resume preamble from another session checkpoint', async () => {
    const projectDir = tmpProjectDir()
    await writeAutoCheckpoint(projectDir, {
      schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'other-session',
      updatedAt: Date.now(),
      goal: 'WRONG GOAL FROM OTHER SESSION',
      pendingTodos: ['wrong todo'],
    })
    const router = new SessionRouter({
      mode: 'auto',
      explicitResume: true,
      resumeSessionId: 'target-session',
      projectDir,
    })

    await drain(router.submit('继续'))

    expect(mockState.submitPrompts).toEqual(['继续'])
    expect(mockState.submitPrompts.join('\n')).not.toContain('WRONG GOAL')
  })

  it('injects the matching session checkpoint preamble on resumed continuation', async () => {
    const projectDir = tmpProjectDir()
    await writeAutoCheckpoint(projectDir, {
      schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'target-session',
      updatedAt: Date.now(),
      goal: 'MATCHING GOAL',
      pendingTodos: ['finish matching todo'],
    })
    const router = new SessionRouter({
      mode: 'auto',
      explicitResume: true,
      resumeSessionId: 'target-session',
      projectDir,
    })

    await drain(router.submit('继续'))

    expect(mockState.submitPrompts).toHaveLength(1)
    expect(mockState.submitPrompts[0]).toContain('MATCHING GOAL')
    expect(mockState.submitPrompts[0]).toContain('finish matching todo')
  })

  it('re-anchors a resumed session when the first prompt is a new requirement', async () => {
    const router = new SessionRouter({
      mode: 'auto',
      explicitResume: true,
      projectDir: tmpProjectDir(),
    })
    const prompt = '实现新的 compact current top-level goal re-anchor 行为'

    await drain(router.submit(prompt))

    expect(mockState.reanchorOriginalGoal).toHaveBeenCalledTimes(1)
    expect(mockState.reanchorOriginalGoal).toHaveBeenCalledWith(prompt)
  })

  it('keeps in-session continuation anchored and re-anchors the next new task', async () => {
    const router = new SessionRouter({
      mode: 'auto',
      projectDir: tmpProjectDir(),
    })
    const nextTask = '开始一个新的 auto 顶层任务，验证 compact anchor 已更新'

    await drain(router.submit('初始 auto 任务'))
    await drain(router.submit('continue'))
    await drain(router.submit(nextTask))

    expect(mockState.reanchorOriginalGoal).toHaveBeenCalledTimes(1)
    expect(mockState.reanchorOriginalGoal).toHaveBeenCalledWith(nextTask)
  })
})
