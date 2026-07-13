import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../../subagent/types.js'
import { makeSubAgentTaskId } from '../../../subagent/types.js'
import type { Charter } from '../../charter/CharterTypes.js'
import {
  freezeCharter,
  normalizeFrozenCharterForRuntime,
  validateCharter,
} from '../../charter/CharterValidate.js'
import { createInstance } from '../../instance/InstanceStore.js'
import { runUntilQuiescent } from '../../runner.js'
import { instancePaths } from '../../types.js'
import { WakeStore } from '../../wake/WakeStore.js'
import {
  DEFAULT_SCENARIO_ID,
  COMPLIANCE_SCENARIO_ID,
  GENERIC_SCENARIO_ID,
  RELEASE_SCENARIO_ID,
  registeredScenarioIds,
  scenarioRuntimeFor,
} from '../ScenarioRuntime.js'
import { walkResearchCharter } from '../../__tests__/testCharter.js'
import { materializeArtifactStreams } from '../../artifacts/ArtifactExecutor.js'

function genericCharter(): Charter {
  return {
    id: 'generic-work', version: 1, scenario: GENERIC_SCENARIO_ID,
    goal: '完成一个不产生 Research Artifact 的通用长周期任务。',
    observables: [],
    meters: [{ name: 'iteration', inc: 'every_round' }],
    tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
    gates: {},
    seats: {
      worker: { context: 'lineage_round', prompt: '完成本轮通用工作。' },
    },
    budgets: { lifetime: { rounds: 2 } },
  }
}

function dispatcher(beforeComplete?: () => Promise<void>): ISubAgentDispatcher {
  return {
    async spawnSubAgent({ config }) {
      await beforeComplete?.()
      return {
        schemaVersion: '1.0', taskId: makeSubAgentTaskId(), parentSessionId: 'scenario-test',
        status: 'completed', config: config as SubAgentRecord['config'],
        createdAt: Date.now(), completedAt: Date.now(), pendingHumanApproval: false,
        result: {
          success: true, summary: 'generic work complete', output: { label: 'ok' },
          turnsUsed: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1,
        },
      } satisfies SubAgentRecord
    },
    async getStatus() { return null },
    async cancelTask() { return true },
  }
}

describe('Scenario registry and frozen GenericCharter bindings', () => {
  it('registers multiple runtimes and fails closed for an unknown ID', () => {
    expect(registeredScenarioIds()).toEqual([
      COMPLIANCE_SCENARIO_ID, GENERIC_SCENARIO_ID, DEFAULT_SCENARIO_ID, RELEASE_SCENARIO_ID,
    ].sort())
    expect(scenarioRuntimeFor(GENERIC_SCENARIO_ID).id).toBe(GENERIC_SCENARIO_ID)
    expect(() => scenarioRuntimeFor('missing/scenario@1')).toThrow(/not registered/)
  })

  it('freezes Scenario ID, ArtifactSpec and the complete ordered GateBinding set', () => {
    const generic = freezeCharter(genericCharter())
    expect(generic.scenario).toBe(GENERIC_SCENARIO_ID)
    expect(generic.artifacts).toEqual({})
    expect(generic.projections).toEqual([])
    expect(generic.gateBindings.map(binding => [binding.id, binding.handler])).toEqual([
      ['producer', 'kernel'], ['wait_contract', 'kernel'], ['artifact_drafts', 'scenario'],
    ])
    expect(generic.frozen.executionPlan.gates).toEqual(generic.gateBindings)

    const research = freezeCharter(walkResearchCharter())
    expect(research.scenario).toBe(DEFAULT_SCENARIO_ID)
    expect(research.artifacts.direction?.requiredGates).toEqual(['producer', 'direction_diversity'])
    expect(research.gateBindings.find(binding => binding.id === 'direction_diversity')?.handler)
      .toBe('scenario')

    delete (research as Partial<typeof research>).scenario
    delete (research as Partial<typeof research>).artifacts
    delete (research as Partial<typeof research>).gateBindings
    delete (research as Partial<typeof research>).projections
    const upgraded = normalizeFrozenCharterForRuntime(research)
    expect(upgraded.scenario).toBe(DEFAULT_SCENARIO_ID)
    expect(upgraded.artifacts.finding).toBeDefined()
    expect(upgraded.gateBindings.some(binding => binding.id === 'direction_diversity')).toBe(true)
    expect(upgraded.projections).toEqual([])
  })

  it('rejects unknown Scenarios and incomplete or unsafe frozen bindings', () => {
    expect(validateCharter({ ...genericCharter(), scenario: 'missing/scenario@1' })
      .some(error => error.includes('not registered'))).toBe(true)

    const research = freezeCharter(walkResearchCharter())
    const withoutScenarioGate: Charter = {
      ...walkResearchCharter(),
      artifacts: research.artifacts,
      gateBindings: research.gateBindings.filter(binding => binding.id !== 'direction_diversity'),
    }
    expect(validateCharter(withoutScenarioGate)
      .some(error => error.includes("missing binding 'direction_diversity'"))).toBe(true)

    const unsafe = genericCharter()
    unsafe.artifacts = {
      output: {
        id: 'output', kind: 'json', draftPath: '../outside.json', stream: 'outputs',
        commitMode: 'append', requiredGates: ['producer'],
      },
    }
    expect(validateCharter(unsafe).some(error => error.includes("must be under 'drafts/'"))).toBe(true)

    const malformed = {
      ...genericCharter(), gateBindings: { bad: true }, artifacts: { broken: null },
    } as unknown as Charter
    expect(() => validateCharter(malformed)).not.toThrow()
    expect(validateCharter(malformed)).toEqual(expect.arrayContaining([
      'gateBindings must be an array',
      'artifacts.broken must be an object',
    ]))

    const badProjection = genericCharter()
    badProjection.projections = [{
      id: 'bad', source: { kind: 'artifact_stream', stream: 'missing' },
      reducer: 'builtin/artifact-view@1', mode: 'window', maxItems: 0,
    }]
    const projectionErrors = validateCharter(badProjection)
    expect(projectionErrors.some(error => error.includes('declared Artifact stream'))).toBe(true)
    expect(projectionErrors.some(error => error.includes('1..10000'))).toBe(true)

    const mixedModes = genericCharter()
    mixedModes.artifacts = {
      a: {
        id: 'a', kind: 'json', draftPath: 'drafts/a.json', stream: 'shared',
        commitMode: 'append', requiredGates: ['producer', 'artifact_drafts'],
      },
      b: {
        id: 'b', kind: 'json', draftPath: 'drafts/b.json', stream: 'shared',
        commitMode: 'replace', requiredGates: ['producer', 'artifact_drafts'],
      },
    }
    expect(validateCharter(mixedModes).some(error => error.includes('mixes commitMode'))).toBe(true)
  })

  it('runs the non-Research Generic Scenario end-to-end through the same Kernel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-generic-scenario-'))
    const paths = instancePaths(dir, 'generic-work-v1')
    const charter = genericCharter()
    charter.artifacts = {
      deliverable: {
        id: 'deliverable', kind: 'json', draftPath: 'drafts/deliverable.json',
        stream: 'deliverables', commitMode: 'append',
        requiredGates: ['producer', 'artifact_drafts'],
      },
    }
    const instance = await createInstance({
      projectDir: dir, charter, wakeStore: new WakeStore(dir),
    })
    await runUntilQuiescent({
      projectDir: dir,
      dispatcher: dispatcher(() => writeFile(
        join(paths.draftsDir, 'deliverable.json'),
        JSON.stringify({ release: 'candidate-1' }),
      )),
    })

    expect(instance.charter.scenario).toBe(GENERIC_SCENARIO_ID)
    const frozen = JSON.parse(await readFile(paths.frozenCharter, 'utf-8')) as Record<string, unknown>
    expect(frozen.scenario).toBe(GENERIC_SCENARIO_ID)
    expect(frozen.artifacts).toEqual(charter.artifacts)
    const artifactEvents = await instance.ledger.readJsonl(paths.artifactsJsonl)
    const streams = materializeArtifactStreams(artifactEvents, instance.charter.artifacts)
    expect(streams.deliverables?.map(item => item.content)).toEqual([{ release: 'candidate-1' }])
    await writeFile(join(paths.draftsDir, 'deliverable.json'), JSON.stringify({ release: 'must-not-commit' }))
    await scenarioRuntimeFor(instance.charter).commitArtifacts(instance, {
      round: 1, producerOk: true, judgeRequired: false, judge: null,
    })
    expect(await instance.ledger.readJsonl(paths.artifactsJsonl)).toHaveLength(artifactEvents.length)
    await expect(readFile(join(paths.draftsDir, 'deliverable.json'), 'utf-8')).rejects.toThrow()
    const progress = await instance.ledger.readProgress()
    expect(progress.totalFindings).toBe(0)
    await expect(readFile(join(paths.draftsDir, 'deliverable.json'), 'utf-8')).rejects.toThrow()
    const report = await readFile(join(paths.reportsDir, 'final_report.md'), 'utf-8')
    expect(report).toContain(`scenario: ${GENERIC_SCENARIO_ID}`)
    expect(report).toContain('committed artifacts: 1')
    expect(report).not.toContain('Findings')
    expect(report).not.toContain('Directions')
  })

  it('corrects a malformed Generic Artifact draft once through its frozen GateBinding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-generic-gate-'))
    const paths = instancePaths(dir, 'generic-work-v1')
    const charter = genericCharter()
    charter.artifacts = {
      manifest: {
        id: 'manifest', kind: 'json', draftPath: 'drafts/manifest.json',
        stream: 'manifests', commitMode: 'replace',
        requiredGates: ['producer', 'artifact_drafts'],
      },
    }
    const instance = await createInstance({
      projectDir: dir, charter, wakeStore: new WakeStore(dir),
    })
    let attempt = 0
    await runUntilQuiescent({
      projectDir: dir,
      dispatcher: dispatcher(async () => {
        attempt++
        await writeFile(
          join(paths.draftsDir, 'manifest.json'),
          attempt === 1 ? '{broken' : JSON.stringify({ valid: true }),
        )
      }),
    })
    expect(attempt).toBe(2)
    const events = await instance.ledger.readJsonl(paths.artifactsJsonl)
    expect(materializeArtifactStreams(events, instance.charter.artifacts).manifests?.[0]?.content)
      .toEqual({ valid: true })
    const rounds = await instance.ledger.readJsonl<{ correctiveRetries: number }>(paths.roundsJsonl)
    expect(rounds[0]?.correctiveRetries).toBe(1)
  })
})
