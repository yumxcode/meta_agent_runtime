import { describe, it, expect, afterEach } from 'vitest'
import { SubAgentBridge } from '../SubAgentBridge.js'
import type { SubAgentRecord } from '../types.js'
import { readTask } from '../SubAgentTaskStore.js'

// Verifies the auto-mode jail is forwarded into every spawned sub-agent's config:
//   - fail-closed sandbox (allowUnsandboxedFallback:false)
//   - autonomy profile passthrough
//   - projectDir bound to the jail root
// We inspect the persisted task record's config rather than running a real
// sub-agent (no model/credentials needed).

describe('SubAgentBridge autonomy jail passthrough', () => {
  const bridges: SubAgentBridge[] = []
  afterEach(async () => {
    for (const b of bridges) await b.dispose().catch(() => undefined)
    bridges.length = 0
  })

  function newBridge(): SubAgentBridge {
    const b = new SubAgentBridge('parent-session')
    bridges.push(b)
    return b
  }

  async function spawnAndReadConfig(b: SubAgentBridge): Promise<SubAgentRecord['config']> {
    const rec = await b.spawnSubAgent({
      config: { taskDescription: 'do x', maxTurns: 1, maxBudgetUsd: 0.01, useEventDriven: true, pollIntervalMs: 1, requireHumanApproval: false, checkpointEveryNTurns: 0 },
    })
    const persisted = await readTask(rec.taskId)
    return persisted!.config
  }

  it('does NOT alter config when the jail is not armed', async () => {
    const b = newBridge()
    const cfg = await spawnAndReadConfig(b)
    expect(cfg.autonomy).toBeUndefined()
    expect(cfg.sandbox).toBeUndefined()
  })

  it('forwards fail-closed sandbox + autonomy + projectDir when armed', async () => {
    const b = newBridge()
    b.setAutonomyJail({ workspaceRoot: '/work/space', autonomy: { lockWorkspace: true, autoApproveInWorkspace: true } })
    const cfg = await spawnAndReadConfig(b)
    expect(cfg.sandbox?.allowUnsandboxedFallback).toBe(false)
    expect(cfg.autonomy).toEqual({ lockWorkspace: true, autoApproveInWorkspace: true })
    expect(cfg.projectDir).toBe('/work/space')
  })

  it('forces fail-closed even if a caller passes a permissive sandbox', async () => {
    const b = newBridge()
    b.setAutonomyJail({ workspaceRoot: '/work/space', autonomy: { lockWorkspace: true } })
    const rec = await b.spawnSubAgent({
      config: {
        taskDescription: 'do x', maxTurns: 1, maxBudgetUsd: 0.01, useEventDriven: true, pollIntervalMs: 1,
        requireHumanApproval: false, checkpointEveryNTurns: 0,
        sandbox: { allowUnsandboxedFallback: true, network: 'none' },
      },
    })
    const cfg = (await readTask(rec.taskId))!.config
    expect(cfg.sandbox?.allowUnsandboxedFallback).toBe(false) // forced
    expect(cfg.sandbox?.network).toBe('none')                 // preserved
  })

  it('an explicit per-spawn projectDir wins over the jail root', async () => {
    const b = newBridge()
    b.setAutonomyJail({ workspaceRoot: '/work/space', autonomy: { lockWorkspace: true } })
    const rec = await b.spawnSubAgent({
      config: {
        taskDescription: 'do x', maxTurns: 1, maxBudgetUsd: 0.01, useEventDriven: true, pollIntervalMs: 1,
        requireHumanApproval: false, checkpointEveryNTurns: 0,
        projectDir: '/work/space/.meta-agent/auto/worktrees/t1',
      },
    })
    const cfg = (await readTask(rec.taskId))!.config
    expect(cfg.projectDir).toBe('/work/space/.meta-agent/auto/worktrees/t1')
  })
})
