import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../../subagent/types.js'
import { makeSubAgentTaskId } from '../../../subagent/types.js'
import type { Charter } from '../../charter/CharterTypes.js'
import { createInstance, loadInstance } from '../../instance/InstanceStore.js'
import { tickOnce } from '../../runner.js'
import { instancePaths } from '../../types.js'
import { WakeStore } from '../../wake/WakeStore.js'
import { effectLedgerFor, ingestEvents, readPendingRound, reconcileWaiting } from '../../effects/WaitOps.js'
import { signEffectEvent, writeAuthenticatedEffectEvent } from '../../effects/EventAuth.js'
import {
  COMPLIANCE_SCENARIO_ID,
  RELEASE_SCENARIO_ID,
} from '../ScenarioDefinitions.js'

function charter(id: string, scenario: string): Charter {
  return {
    id, version: 1, scenario, goal: 'complete built-in work scenario',
    observables: [], meters: [{ name: 'iteration', inc: 'every_round' }],
    tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }], gates: {},
    seats: { worker: { context: 'lineage_round', prompt: 'complete the declared artifacts' } },
    budgets: { lifetime: { rounds: 2 } },
  }
}

function dispatcher(script: (task: string) => Promise<Record<string, unknown>>): ISubAgentDispatcher {
  return {
    async spawnSubAgent({ config }) {
      const output = await script(config.taskDescription)
      return {
        schemaVersion: '1.0', taskId: makeSubAgentTaskId(), parentSessionId: 'builtin-scenario-test',
        status: 'completed', config: config as SubAgentRecord['config'], createdAt: Date.now(),
        completedAt: Date.now(), pendingHumanApproval: false,
        result: {
          success: true, summary: 'scripted', output,
          turnsUsed: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1,
        },
      } satisfies SubAgentRecord
    },
    async getStatus() { return null },
    async cancelTask() { return true },
  }
}

async function pump(projectDir: string, seat: ISubAgentDispatcher, instanceId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    await tickOnce({ projectDir, dispatcher: seat })
    const record = JSON.parse(await readFile(instancePaths(projectDir, instanceId).instanceJson, 'utf-8'))
    if (record.status === 'done') return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('scenario did not finish')
}

describe('built-in Release and Compliance Scenarios', () => {
  it('runs Release with fixed replace/versioned artifacts through the unchanged Kernel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-release-'))
    const instanceId = 'release-work-v1'
    const paths = instancePaths(dir, instanceId)
    const instance = await createInstance({
      projectDir: dir, instanceId, charter: charter('release-work', RELEASE_SCENARIO_ID),
      wakeStore: new WakeStore(dir),
    })
    expect(Object.keys(instance.charter.artifacts).sort()).toEqual(['release_manifest', 'release_note'])
    expect(instance.charter.projections).toHaveLength(2)
    await pump(dir, dispatcher(async () => {
      await writeFile(join(paths.draftsDir, 'release_manifest.json'), JSON.stringify({ version: '1.0.0' }))
      await writeFile(join(paths.draftsDir, 'release_note.md'), '# Release 1.0.0')
      return { label: 'ok' }
    }), instanceId)
    const checkpoint = JSON.parse(await readFile(paths.artifactsCheckpointJson, 'utf-8'))
    expect(checkpoint.streamStates.release_manifest).toMatchObject({ commitMode: 'replace', logicalCount: 1 })
    expect(checkpoint.streamStates.release_notes).toMatchObject({ commitMode: 'versioned', logicalCount: 1 })
  })

  it('binds human approval to the exact Compliance draft and resumes the same round', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-compliance-'))
    const instanceId = 'compliance-work-v1'
    const paths = instancePaths(dir, instanceId)
    await createInstance({
      projectDir: dir, instanceId, charter: charter('compliance-work', COMPLIANCE_SCENARIO_ID),
      wakeStore: new WakeStore(dir),
    })
    const seat = dispatcher(async task => {
      if (!task.includes('收割段')) {
        await writeFile(join(paths.draftsDir, 'compliance_bundle.json'), JSON.stringify({ control: 'SOC2', ok: true }))
        return { label: 'wait', maxWaitMs: 60_000 }
      }
      return { label: 'ok' }
    })
    await tickOnce({ projectDir: dir, dispatcher: seat })
    const waiting = (await loadInstance(dir, instanceId))!
    const pending = (await readPendingRound(waiting))!
    expect(pending.effectKey).toBe(`human-approval:${instanceId}:round:1`)
    const effect = (await effectLedgerFor(waiting).get(pending.effectKey!))!
    expect(effect.payload).toMatchObject({
      protocol: 'builtin/human-artifact-approval@1', artifactId: 'compliance_bundle',
    })

    const wakeStore = new WakeStore(dir)
    // Use the authenticated host ingress, then simulate a crash after conclude
    // but before the harvest wake remains durable.
    await writeAuthenticatedEffectEvent(waiting, {
      principal: 'alice', roles: ['approver'], effectKey: pending.effectKey!,
      verdict: 'approved', data: { contentHash: effect.payload!.contentHash },
    })
    await ingestEvents(waiting, { wakeStore, projectDir: dir })
    await wakeStore.cancelForLoop(instanceId)
    const actions = await reconcileWaiting(waiting, { wakeStore, projectDir: dir })
    expect(actions.some(action => action.includes('missing harvest wake'))).toBe(true)
    await pump(dir, seat, instanceId)
    const checkpoint = JSON.parse(await readFile(paths.artifactsCheckpointJson, 'utf-8'))
    expect(checkpoint.streamStates.compliance_bundles).toMatchObject({ logicalCount: 1 })
    expect((await effectLedgerFor((await loadInstance(dir, instanceId))!).get(pending.effectKey!))!.status)
      .toBe('harvested')
  })

  it('uses first-wins approval and rejects an event for a different content hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-compliance-reject-'))
    const instanceId = 'compliance-reject-v1'
    const paths = instancePaths(dir, instanceId)
    await createInstance({
      projectDir: dir, instanceId, charter: charter('compliance-reject', COMPLIANCE_SCENARIO_ID),
      wakeStore: new WakeStore(dir),
    })
    const seat = dispatcher(async task => {
      if (!task.includes('收割段')) {
        await writeFile(join(paths.draftsDir, 'compliance_bundle.json'), JSON.stringify({ control: 'ISO27001' }))
        return { label: 'wait', effectKey: 'ignored' }
      }
      return { label: 'ok' }
    })
    await tickOnce({ projectDir: dir, dispatcher: seat })
    const pending = (await readPendingRound((await loadInstance(dir, instanceId))!))!
    const waiting = (await loadInstance(dir, instanceId))!
    await mkdir(paths.eventsDir, { recursive: true })
    const wrong = await signEffectEvent(waiting, {
      principal: 'alice', roles: ['approver'], effectKey: pending.effectKey!,
      verdict: 'approved', data: { contentHash: 'wrong' },
    })
    const tooLate = await signEffectEvent(waiting, {
      principal: 'bob', roles: ['approver'], effectKey: pending.effectKey!,
      verdict: 'approved', data: { contentHash: 'cannot-overwrite-first-winner' },
    })
    await writeFile(join(paths.eventsDir, 'a-wrong.json'), JSON.stringify(wrong))
    await writeFile(join(paths.eventsDir, 'b-correct.json'), JSON.stringify(tooLate))
    await pump(dir, seat, instanceId)
    const checkpoint = JSON.parse(await readFile(paths.artifactsCheckpointJson, 'utf-8'))
    expect(checkpoint.streamStates.compliance_bundles).toBeUndefined()
    const events = (await readFile(paths.artifactsJsonl, 'utf-8')).trim().split('\n').map(line => JSON.parse(line))
    const terminal = events.find(event => event.type === 'artifact.transaction_committed')
    expect(terminal.decisions[0]).toMatchObject({ verdict: 'rejected' })
  })

  it('quarantines unsigned forged approval and accepts a signed approver event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-compliance-auth-'))
    const instanceId = 'compliance-auth-v1'
    const paths = instancePaths(dir, instanceId)
    await createInstance({
      projectDir: dir, instanceId, charter: charter('compliance-auth', COMPLIANCE_SCENARIO_ID),
      wakeStore: new WakeStore(dir),
    })
    const seat = dispatcher(async task => {
      if (!task.includes('收割段')) {
        await writeFile(join(paths.draftsDir, 'compliance_bundle.json'), JSON.stringify({ authenticated: true }))
        return { label: 'wait' }
      }
      return { label: 'ok' }
    })
    await tickOnce({ projectDir: dir, dispatcher: seat })
    const waiting = (await loadInstance(dir, instanceId))!
    const pending = (await readPendingRound(waiting))!
    const effect = (await effectLedgerFor(waiting).get(pending.effectKey!))!
    await writeFile(join(paths.eventsDir, 'forged.json'), JSON.stringify({
      effectKey: pending.effectKey, verdict: 'approved',
      data: { contentHash: effect.payload?.['contentHash'] },
    }))
    await ingestEvents(waiting, { wakeStore: new WakeStore(dir), projectDir: dir })
    expect((await effectLedgerFor(waiting).get(pending.effectKey!))?.status).toBe('submitted')
    expect(await readdir(paths.eventsDir)).toContain('forged.json.unauthorized')

    await writeAuthenticatedEffectEvent(waiting, {
      principal: 'security-reviewer', roles: ['approver'], effectKey: pending.effectKey!,
      verdict: 'approved', data: { contentHash: effect.payload?.['contentHash'] },
    })
    await pump(dir, seat, instanceId)
    const checkpoint = JSON.parse(await readFile(paths.artifactsCheckpointJson, 'utf-8'))
    expect(checkpoint.streamStates.compliance_bundles).toMatchObject({ logicalCount: 1 })
  })

  it('corrects an invalid approval wait once instead of entering a crash/requeue loop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-compliance-wait-contract-'))
    const instanceId = 'compliance-wait-contract-v1'
    const paths = instancePaths(dir, instanceId)
    await createInstance({
      projectDir: dir, instanceId,
      charter: charter('compliance-wait-contract', COMPLIANCE_SCENARIO_ID),
      wakeStore: new WakeStore(dir),
    })
    let attempts = 0
    const seat = dispatcher(async () => {
      attempts++
      if (attempts === 2) {
        await writeFile(join(paths.draftsDir, 'compliance_bundle.json'), JSON.stringify({ corrected: true }))
      }
      return { label: 'wait' }
    })
    const tick = await tickOnce({ projectDir: dir, dispatcher: seat })
    expect(tick.outcomes[0]?.error).toBeUndefined()
    expect(attempts).toBe(2)
    expect((await readPendingRound((await loadInstance(dir, instanceId))!))?.effectKey)
      .toBe(`human-approval:${instanceId}:round:1`)
  })
})
