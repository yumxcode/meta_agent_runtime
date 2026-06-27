/**
 * SimpleAutoBackend — verifies that simple_auto is auto WITHOUT the heavyweight
 * self-supervision machinery.
 *
 * simple_auto must keep auto's autonomy jail (auto-approve writes inside the
 * workspace, locked workspace, denied tools) but MUST NOT wire:
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
  },
}))

vi.mock('../../subagent/SubAgentBridge.js', () => ({
  SubAgentBridge: class {
    constructor(_sessionId: string, _opts?: unknown) {}
    setToolRegistry(): void {}
    setAutonomyJail(): void {}
    setWorktreeCoordinator(): void {}
    setSubAgentToolOverrides(): void {}
    getWorktreeCoordinator(): unknown { return null }
    getSchedulerStats(): { activeTaskIds: string[] } { return { activeTaskIds: [] } }
  },
}))

import { createAgenticBackend } from '../AgenticBackendFactory.js'
import { MODE_PROFILES } from '../../core/modes.js'
import { resolveConfig } from '../../core/config.js'

function tmpProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'meta-agent-simple-auto-'))
}

async function buildBackend(promptModeKey: 'auto' | 'simple_auto') {
  const projectDir = tmpProjectDir()
  const baseConfig = resolveConfig({ projectDir })
  const backend = await createAgenticBackend({
    baseConfig,
    projectDir,
    explicitResume: false,
    overrides: MODE_PROFILES[promptModeKey].agenticOverrides,
    getGoal: () => null,
  })
  const config = mockState.configs.at(-1)!
  return { backend, config }
}

describe('simple_auto backend wiring', () => {
  beforeEach(() => {
    mockState.configs.length = 0
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

    // Returned coordinators are null — no durable checkpoint, no orchestration.
    expect(backend.checkpointCoordinator).toBeNull()
    expect(backend.orchController).toBeNull()

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
    // auto (not auto-orch) carries the jail but no orchestration phase hooks.
    expect(backend.orchController).toBeNull()
  })
})
