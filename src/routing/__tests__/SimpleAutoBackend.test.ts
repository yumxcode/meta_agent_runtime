/**
 * SimpleAutoBackend — verifies that lightweight autonomous modes keep the auto
 * jail WITHOUT the heavyweight self-supervision machinery.
 *
 * simple_auto and auto_orch must keep auto's autonomy jail (auto-approve writes
 * inside the workspace, locked workspace, denied tools) but MUST NOT wire:
 *   - the durable checkpoint coordinator (onCheckpointBoundary),
 *   - the drift (course-correction) gate (driftGate),
 *   - the completion-verify gate (verifyGate),
 *   - the auto experience-recall store (getExperienceRecallBlock).
 *
 * The kernel loop no-ops each of those whenever its config hook is absent, so the
 * absence asserted here is exactly what disables the three mechanisms at runtime.
 *
 * We mock MetaAgentSession + SubAgentBridge to (a) capture the config the factory
 * constructs the session with, and (b) avoid spinning up a real kernel session.
 * A plain (non-git) tmp dir keeps the worktree coordinator inert.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({
  // Constructor config captured from each MetaAgentSession instantiation.
  configs: [] as Array<Record<string, unknown>>,
  autonomyJailCalls: [] as Array<{ jail: unknown; opts: unknown }>,
}))

vi.mock('../../core/MetaAgentSession.js', () => ({
  MetaAgentSession: class {
    constructor(config: Record<string, unknown>) {
      mockState.configs.push(config)
    }
    getSessionId(): string { return 'simple-auto-test-session' }
    getToolRegistry(): unknown { return {} }
    registerTool(): void {}
    setSubAgentBridge(): void {}
    async dispose(): Promise<void> {}
  },
}))

vi.mock('../../subagent/SubAgentBridge.js', () => ({
  SubAgentBridge: class {
    constructor(_sessionId: string, _opts?: unknown) {}
    setToolRegistry(): void {}
    setAutonomyJail(jail: unknown, opts?: unknown): void {
      mockState.autonomyJailCalls.push({ jail, opts })
    }
    setWorktreeCoordinator(): void {}
    setSubAgentToolOverrides(): void {}
    getWorktreeCoordinator(): unknown { return null }
    getSchedulerStats(): { activeTaskIds: string[] } { return { activeTaskIds: [] } }
  },
}))

import { createAgenticBackend } from '../AgenticBackendFactory.js'
import { MODE_PROFILES } from '../../core/modes.js'
import { resolveConfig } from '../../core/config.js'
import { writeAutoCheckpoint, AUTO_CHECKPOINT_SCHEMA_VERSION } from '../../core/auto/AutoCheckpointStore.js'

function tmpProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'meta-agent-simple-auto-'))
}

async function buildBackend(
  promptModeKey: 'auto' | 'simple_auto',
  opts: { projectDir?: string; explicitResume?: boolean; resumeSessionId?: string } = {},
) {
  const projectDir = opts.projectDir ?? tmpProjectDir()
  const baseConfig = resolveConfig({ projectDir })
  const backend = await createAgenticBackend({
    baseConfig,
    projectDir,
    explicitResume: opts.explicitResume ?? false,
    resumeSessionId: opts.resumeSessionId,
    overrides: MODE_PROFILES[promptModeKey].agenticOverrides,
    getGoal: () => null,
  })
  const config = mockState.configs.at(-1)!
  return { backend, config }
}

describe('simple_auto backend wiring', () => {
  beforeEach(() => {
    mockState.configs.length = 0
    mockState.autonomyJailCalls.length = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the autonomy jail (auto-approve + locked workspace + denied tools)', async () => {
    const { config } = await buildBackend('simple_auto')
    expect(config['promptMode']).toBe('simple_auto')
    expect(config['autonomy']).toMatchObject({
      autoApproveInWorkspace: true,
      lockWorkspace: true,
    })
  })

  it('does NOT wire verify / drift / checkpoint / experience-recall', async () => {
    const { backend, config } = await buildBackend('simple_auto')

    // Returned coordinator is null — no durable checkpoint.
    expect(backend.checkpointCoordinator).toBeNull()

    // The session is built with every self-supervision hook absent, which is
    // exactly what makes the kernel loop skip each mechanism.
    expect(config['verifyGate']).toBeUndefined()
    expect(config['driftGate']).toBeUndefined()
    expect(config['onCheckpointBoundary']).toBeUndefined()
    expect(config['getExperienceRecallBlock']).toBeUndefined()
    // simple_auto never enables the orchestration phase hooks.
    expect(config['phaseHooks']).toBeUndefined()
  })

  it('plain auto DOES wire verify / drift / checkpoint (control)', async () => {
    const { backend, config } = await buildBackend('auto')

    expect(backend.checkpointCoordinator).not.toBeNull()
    expect(config['promptMode']).toBe('auto')
    expect(config['verifyGate']).toBeTypeOf('function')
    expect(config['driftGate']).toBeTypeOf('function')
    expect(config['onCheckpointBoundary']).toBeTypeOf('function')
    expect(config['getExperienceRecallBlock']).toBeTypeOf('function')
  })

  it('only restores auto checkpoint counters for the matching resumed session', async () => {
    const projectDir = tmpProjectDir()
    await writeAutoCheckpoint(projectDir, {
      schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'other-session',
      updatedAt: Date.now(),
      revision: 9,
      turnCount: 42,
    })

    const mismatched = await buildBackend('auto', {
      projectDir,
      explicitResume: true,
      resumeSessionId: 'target-session',
    })
    expect(mismatched.config['initialCheckpointRevision']).toBe(0)
    expect(mismatched.config['initialToolBatchCount']).toBe(0)

    await writeAutoCheckpoint(projectDir, {
      schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'target-session',
      updatedAt: Date.now(),
      revision: 7,
      turnCount: 13,
    })
    const matched = await buildBackend('auto', {
      projectDir,
      explicitResume: true,
      resumeSessionId: 'target-session',
    })
    expect(matched.config['initialCheckpointRevision']).toBe(7)
    expect(matched.config['initialToolBatchCount']).toBe(13)
  })
})
