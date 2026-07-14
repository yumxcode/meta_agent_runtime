import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ScenarioRegistry } from '../ScenarioRegistry.js'
import { loadScenarioPlugins } from '../ScenarioLoader.js'
import type { ScenarioPluginV1 } from '../ScenarioPlugin.js'
import { createGenericScenarioRuntime } from '../generic/GenericScenario.js'
import { createBuiltinScenarioRegistry } from '../BuiltinScenarioPlugins.js'
import { createInstance, loadInstance } from '../../instance/InstanceStore.js'
import { WakeStore } from '../../wake/WakeStore.js'
import type { Charter } from '../../charter/CharterTypes.js'
import { prepareAndClaim, runUntilQuiescent } from '../../runner.js'
import { runLoopScheduler } from '../../daemon.js'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../../subagent/types.js'
import { makeSubAgentTaskId } from '../../../subagent/types.js'

const ID = 'test/external-delivery@1'

function externalPlugin(version = '1.0.0'): ScenarioPluginV1 {
  return {
    manifest: { apiVersion: 1, id: ID, version, integrity: `test:${version}` },
    definition: {
      id: ID,
      artifacts: () => ({
        result: {
          id: 'result', kind: 'json', draftPath: 'drafts/result.json', stream: 'results',
          commitMode: 'replace', draft: { cardinality: 'one', requirement: 'on_finalize' },
          requiredGates: ['producer', 'artifact_drafts'],
        },
      }),
      artifactGateIds: ['producer', 'artifact_drafts'],
      mandatoryArtifactGateIds: ['producer', 'artifact_drafts'],
      allowAdditionalArtifacts: false,
      gateBindings: [{
        id: 'artifact_drafts', kind: 'contract', handler: 'scenario', gateIds: [],
        retryProducer: 1, executionRetry: 0, feedback: 'messages',
      }],
    },
    runtime: createGenericScenarioRuntime({ id: ID }),
  }
}

function charter(): Charter {
  return {
    id: 'external-delivery', version: 1, scenario: ID, goal: 'produce result',
    observables: [], meters: [{ name: 'iteration', inc: 'every_round' }],
    tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
    gates: {}, seats: { worker: { context: 'isolated', prompt: 'produce result' } },
  }
}

function dispatcher(beforeComplete: () => Promise<void>): ISubAgentDispatcher {
  return {
    async spawnSubAgent({ config }) {
      await beforeComplete()
      return {
        schemaVersion: '1.0', taskId: makeSubAgentTaskId(), parentSessionId: 'plugin-test',
        status: 'completed', config: config as SubAgentRecord['config'], createdAt: Date.now(),
        completedAt: Date.now(), pendingHumanApproval: false,
        result: {
          success: true, summary: 'done', output: { label: 'ok' }, turnsUsed: 1,
          inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1,
        },
      } satisfies SubAgentRecord
    },
    async getStatus() { return null },
    async cancelTask() { return true },
  }
}

describe('Scenario plugin ABI', () => {
  it('registers an external Scenario and freezes its exact identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scenario-plugin-'))
    const scenarios = createBuiltinScenarioRegistry().register(externalPlugin())
    const instance = await createInstance({
      projectDir: dir, charter: charter(), wakeStore: new WakeStore(dir), scenarios,
    })
    expect(instance.charter.frozen.scenarioPlugin).toEqual({
      id: ID, apiVersion: 1, version: '1.0.0', integrity: 'test:1.0.0',
    })
    await runUntilQuiescent({
      projectDir: dir, scenarios,
      dispatcher: dispatcher(() => writeFile(
        join(instance.paths.draftsDir, 'result.json'), JSON.stringify({ delivered: true }),
      )),
    })
    expect((await loadInstance(dir, instance.record.instanceId, scenarios))?.record.status).toBe('done')
    const incompatible = createBuiltinScenarioRegistry().register(externalPlugin('2.0.0'))
    await expect(loadInstance(dir, instance.record.instanceId, incompatible))
      .rejects.toThrow(/plugin mismatch/)
  })

  it('propagates an external Scenario registry through the daemon', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scenario-plugin-daemon-'))
    const scenarios = createBuiltinScenarioRegistry().register(externalPlugin())
    const instance = await createInstance({
      projectDir: dir, charter: charter(), wakeStore: new WakeStore(dir), scenarios,
    })
    const result = await runLoopScheduler({
      projectDir: dir,
      scenarios,
      dispatcher: dispatcher(() => writeFile(
        join(instance.paths.draftsDir, 'result.json'), JSON.stringify({ delivered: true }),
      )),
      pollMs: 10,
      idleExitMs: 20,
      hostCoordinatorOptions: { rootDir: join(dir, 'host-coordinator'), pollMs: 10 },
    })
    expect(result.exitReason).toBe('idle')
    expect((await loadInstance(dir, instance.record.instanceId, scenarios))?.record.status).toBe('done')
  })

  it('loads only an explicitly named local ESM plugin and pins its file digest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scenario-loader-'))
    const file = join(dir, 'explicit-plugin.mjs')
    await writeFile(file, `
      export const scenarioPlugin = {
        manifest: { apiVersion: 1, id: 'test/loaded@1', version: '1.0.0', integrity: 'declared' },
        definition: {
          id: 'test/loaded@1', artifacts: () => ({}), artifactGateIds: [],
          mandatoryArtifactGateIds: [], allowAdditionalArtifacts: true, gateBindings: []
        },
        runtime: {
          id: 'test/loaded@1', producerOutputContract: () => '',
          runProducerGate: async () => ({ verdict: 'pass', messages: [] }),
          harvestPreface: () => '', renderReport: async () => ''
        }
      }
    `, 'utf-8')
    const registry = await loadScenarioPlugins(['./explicit-plugin.mjs'], {
      projectDir: dir, base: new ScenarioRegistry(),
    })
    expect(registry.ids()).toEqual(['test/loaded@1'])
    expect(registry.require('test/loaded@1').manifest.integrity).toMatch(/^sha256:/)
  })

  it('rejects a local plugin that claims a false sha256 identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scenario-loader-integrity-'))
    await writeFile(join(dir, 'forged.mjs'), `
      export default {
        manifest: { apiVersion: 1, id: 'test/forged@1', version: '1.0.0', integrity: 'sha256:${'0'.repeat(64)}' },
        definition: { id: 'test/forged@1', artifacts: () => ({}), artifactGateIds: [], mandatoryArtifactGateIds: [], allowAdditionalArtifacts: true, gateBindings: [] },
        runtime: { id: 'test/forged@1', producerOutputContract: () => '', runProducerGate: async () => ({ verdict: 'pass', messages: [] }), harvestPreface: () => '', renderReport: async () => '' }
      }
    `, 'utf-8')
    await expect(loadScenarioPlugins(['./forged.mjs'], {
      projectDir: dir, base: new ScenarioRegistry(),
    })).rejects.toThrow(/integrity mismatch/)
  })

  it('does not claim a wake when the pinned plugin implementation is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scenario-plugin-blocked-'))
    const available = createBuiltinScenarioRegistry().register(externalPlugin())
    const instance = await createInstance({
      projectDir: dir, charter: charter(), wakeStore: new WakeStore(dir), scenarios: available,
    })
    const incompatible = createBuiltinScenarioRegistry().register(externalPlugin('2.0.0'))
    const prepared = await prepareAndClaim({
      projectDir: dir, scenarios: incompatible,
      dispatcher: dispatcher(async () => undefined),
    })
    expect(prepared.wakes).toEqual([])
    const wake = (await new WakeStore(dir).list()).find(item => item.loopId === instance.record.instanceId)
    expect(wake).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('rejects duplicate IDs and unsupported API versions', () => {
    const registry = new ScenarioRegistry([externalPlugin()])
    expect(() => registry.register(externalPlugin())).toThrow(/already registered/)
    expect(() => new ScenarioRegistry([{
      ...externalPlugin(), manifest: { ...externalPlugin().manifest, apiVersion: 2 as 1 },
    }])).toThrow(/API must be 1/)
  })

  it('validates required hooks and snapshots registration metadata', () => {
    const mutable = externalPlugin()
    const registry = new ScenarioRegistry([mutable])
    mutable.manifest.version = 'mutated'
    mutable.definition.artifactGateIds = []
    expect(registry.require(ID).manifest.version).toBe('1.0.0')
    expect(registry.require(ID).definition.artifactGateIds).toContain('producer')

    const invalid = externalPlugin()
    invalid.runtime = { ...invalid.runtime, renderReport: undefined as never }
    expect(() => new ScenarioRegistry([invalid])).toThrow(/missing required runtime hooks/)
  })
})
