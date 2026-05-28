import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkflowStateStore } from '../WorkflowStateStore.js'
import type { WorkflowDefinition } from '../types.js'

const tempDirs: string[] = []

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-workflow-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function makeDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    mode: 'robotics',
    version: '1.0',
    title: 'Test Workflow',
    globalContext: '',
    sourceFile: '/project/AGENT.md',
    phases: [
      {
        id: 'phase_one',
        chineseName: '阶段一',
        englishName: 'Phase One',
        index: 0,
        content: '',
        outputs: [],
        gateItems: [
          { id: 'phase_one_gate_0', type: 'REQUIRED', description: 'Do first thing', completed: false },
        ],
      },
      {
        id: 'phase_two',
        chineseName: '阶段二',
        englishName: 'Phase Two',
        index: 1,
        content: '',
        outputs: [],
        gateItems: [
          { id: 'phase_two_gate_0', type: 'REQUIRED', description: 'Do second thing', completed: false },
        ],
      },
    ],
    ...overrides,
  }
}

describe('WorkflowStateStore compatibility', () => {
  it('reuses state only when it matches the active workflow definition', async () => {
    const project = await tempProject()
    const definition = makeDefinition({
      workflowBlockHash: 'block-a',
      workflowDefinitionHash: 'definition-a',
    })
    const state = await WorkflowStateStore.initialize(project, definition)

    await expect(WorkflowStateStore.readCompatible(project, definition)).resolves.toMatchObject({
      currentPhaseId: state.currentPhaseId,
    })

    const changed = makeDefinition({ sourceFile: '/project/new-AGENT.md' })
    await expect(WorkflowStateStore.readCompatible(project, changed)).resolves.toBeNull()

    const changedHash = makeDefinition({
      workflowBlockHash: 'block-b',
      workflowDefinitionHash: 'definition-a',
    })
    await expect(WorkflowStateStore.readCompatible(project, changedHash)).resolves.toBeNull()
  })

  it('fails closed when state points to an unknown phase', async () => {
    const definition = makeDefinition()
    const result = WorkflowStateStore.checkGates(definition, {
      schemaVersion: '1.0',
      projectDir: '/tmp/project',
      mode: 'robotics',
      workflowSourceFile: definition.sourceFile,
      currentPhaseId: 'deleted_phase',
      currentPhaseEnteredAt: Date.now(),
      completedGateItems: [],
      phaseHistory: [],
    })

    expect(result.canAdvance).toBe(false)
  })

  it('does not advance when persisted state is incompatible with the current definition', async () => {
    const project = await tempProject()
    const definition = makeDefinition()
    await WorkflowStateStore.initialize(project, definition)
    const changed = makeDefinition({ sourceFile: '/project/new-AGENT.md' })

    await expect(WorkflowStateStore.advancePhase(project, changed, 'agent'))
      .rejects.toThrow(/not compatible/)
  })
})

describe('WorkflowStateStore current-phase gates', () => {
  it('rejects completing a future phase gate', async () => {
    const project = await tempProject()
    const definition = makeDefinition()
    await WorkflowStateStore.initialize(project, definition)

    await expect(
      WorkflowStateStore.completeCurrentPhaseGateItem(project, definition, 'phase_two_gate_0'),
    ).rejects.toThrow(/not part of the current workflow phase/)
  })

  it('completes a gate from the current phase', async () => {
    const project = await tempProject()
    const definition = makeDefinition()
    await WorkflowStateStore.initialize(project, definition)

    const state = await WorkflowStateStore.completeCurrentPhaseGateItem(project, definition, 'phase_one_gate_0')

    expect(state.completedGateItems).toContain('phase_one_gate_0')
  })
})
