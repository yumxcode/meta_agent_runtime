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
  bridgeOptions: [] as unknown[],
  registeredToolNames: [] as string[],
}))

vi.mock('../../modes/MetaAgentSession.js', () => ({
  MetaAgentSession: class {
    constructor(config: Record<string, unknown>) {
      mockState.configs.push(config)
    }
    getSessionId(): string { return 'simple-auto-test-session' }
    getToolRegistry(): unknown { return {} }
    registerTool(tool: { name?: string }): void {
      if (tool.name) mockState.registeredToolNames.push(tool.name)
    }
    setSubAgentBridge(): void {}
    async dispose(): Promise<void> {}
  },
}))

vi.mock('../../subagent/SubAgentBridge.js', () => ({
  SubAgentBridge: class {
    constructor(_sessionId: string, opts?: unknown) { mockState.bridgeOptions.push(opts) }
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
  opts: { projectDir?: string; explicitResume?: boolean; resumeSessionId?: string; subAgentBudgetOwner?: 'session' | 'caller' } = {},
) {
  const projectDir = opts.projectDir ?? tmpProjectDir()
  const baseConfig = resolveConfig({ projectDir })
  const backend = await createAgenticBackend({
    baseConfig,
    projectDir,
    explicitResume: opts.explicitResume ?? false,
    resumeSessionId: opts.resumeSessionId,
    overrides: MODE_PROFILES[promptModeKey].agenticOverrides,
    subAgentBudgetOwner: opts.subAgentBudgetOwner,
    getGoal: () => null,
  })
  const config = mockState.configs.at(-1)!
  return { backend, config }
}

describe('simple_auto backend wiring', () => {
  beforeEach(() => {
    mockState.configs.length = 0
    mockState.autonomyJailCalls.length = 0
    mockState.bridgeOptions.length = 0
    mockState.registeredToolNames.length = 0
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

  it('lets a durable caller own aggregate child budget without disabling the auto jail', async () => {
    const { backend } = await buildBackend('auto', { subAgentBudgetOwner: 'caller' })
    expect(backend.costLedger).toBeNull()
    expect(mockState.bridgeOptions.at(-1)).toMatchObject({
      conservativeAutoDefaults: true,
      budgetManagedExternally: true,
    })
    expect(mockState.autonomyJailCalls).toHaveLength(1)
    expect(mockState.autonomyJailCalls.at(-1)?.opts).toEqual({ retryLimit: 0 })
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
    expect(mockState.registeredToolNames).toContain('self_timer')
  })

  it('exposes self_timer only on plain auto, never simple_auto', async () => {
    await buildBackend('simple_auto')
    expect(mockState.registeredToolNames).not.toContain('self_timer')

    mockState.registeredToolNames.length = 0
    await buildBackend('auto')
    expect(mockState.registeredToolNames).toContain('self_timer')
  })

  it('only restores auto checkpoint counters for the matching resumed session', async () => {
    const projectDir = tmpProjectDir()
    await writeAutoCheckpoint(projectDir, {
      schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'other-session',
      updatedAt: Date.now(),
      revision: 9,
      turnCount: 42,
      estimatedCostUsd: 4.25,
    })

    const mismatched = await buildBackend('auto', {
      projectDir,
      explicitResume: true,
      resumeSessionId: 'target-session',
    })
    expect(mismatched.config['initialCheckpointRevision']).toBe(0)
    expect(mismatched.config['initialToolBatchCount']).toBe(0)
    expect(mismatched.config['initialCostUsd']).toBe(0)

    await writeAutoCheckpoint(projectDir, {
      schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'target-session',
      updatedAt: Date.now(),
      revision: 7,
      turnCount: 13,
      estimatedCostUsd: 4.25,
    })
    const matched = await buildBackend('auto', {
      projectDir,
      explicitResume: true,
      resumeSessionId: 'target-session',
    })
    expect(matched.config['initialCheckpointRevision']).toBe(7)
    expect(matched.config['initialToolBatchCount']).toBe(13)
    expect(matched.config['initialCostUsd']).toBe(4.25)
  })
})

/**
 * The session budget is CUMULATIVE ACROSS RESUME — the ledger is seeded from the
 * checkpoint's `estimatedCostUsd`.
 *
 * A session that legitimately spent past its ceiling could therefore be resumed,
 * burn a couple of model calls, and only then stop with a message whose advice
 * ("拆分为更小的子任务") is wrong for this cause: the task size is irrelevant, the
 * ledger was over the line before the first turn. Observed 2026-08-27 —
 * $23.73 recorded against a $20 ceiling, dead after two tool calls.
 */
describe('resume past the budget ceiling is announced up front', () => {
  let warnings: string[]
  let restore: () => void

  beforeEach(() => {
    warnings = []
    const original = process.stderr.write.bind(process.stderr)
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      warnings.push(String(chunk))
      return true
    }) as typeof process.stderr.write)
    restore = () => { spy.mockRestore(); void original }
  })

  afterEach(() => restore())

  async function resumeWithRecordedCost(costUsd: number, budgetUsd: number) {
    const projectDir = tmpProjectDir()
    await writeAutoCheckpoint(projectDir, {
      schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'over-budget-session',
      updatedAt: Date.now(),
      revision: 3,
      turnCount: 20,
      estimatedCostUsd: costUsd,
    })
    const baseConfig = resolveConfig({ projectDir, maxBudgetUsd: budgetUsd })
    await createAgenticBackend({
      baseConfig,
      projectDir,
      explicitResume: true,
      resumeSessionId: 'over-budget-session',
      overrides: MODE_PROFILES['auto'].agenticOverrides,
      getGoal: () => null,
    })
    return warnings.join('')
  }

  it('warns before the run when recorded spend already meets the ceiling', async () => {
    const out = await resumeWithRecordedCost(23.73, 20)
    expect(out).toMatch(/\[budget\]/)
    expect(out).toMatch(/23\.73/)
    expect(out).toMatch(/20\.00/)
  })

  it('names the lever that actually applies', async () => {
    // Not "split the task" — that does nothing when the ledger starts over.
    const out = await resumeWithRecordedCost(23.73, 20)
    expect(out).toMatch(/--max-budget-usd/)
    expect(out).toMatch(/META_AGENT_AUTO_MAX_BUDGET_USD/)
    expect(out).toMatch(/cumulative/)
  })

  it('stays quiet when the resumed session is comfortably inside its ceiling', async () => {
    const out = await resumeWithRecordedCost(23.73, 300)
    expect(out).not.toMatch(/\[budget\]/)
  })

  it('warns at exactly the ceiling, not only past it', async () => {
    // `>=`: a session sitting exactly on its limit has no headroom either.
    const out = await resumeWithRecordedCost(20, 20)
    expect(out).toMatch(/\[budget\]/)
  })

  it('does not fire for a fresh (non-resumed) session', async () => {
    await buildBackend('auto')
    expect(warnings.join('')).not.toMatch(/\[budget\]/)
  })
})
