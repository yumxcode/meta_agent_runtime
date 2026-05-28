import { describe, expect, it, vi } from 'vitest'
import { SectionRegistry } from '../../core/systemPromptSections.js'
import { buildW1Section } from '../dynamicSection.js'
import type { WorkflowDefinition, WorkflowState } from '../types.js'

function makeDefinition(): WorkflowDefinition {
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
    ],
  }
}

function makeState(completedGateItems: string[] = []): WorkflowState {
  return {
    schemaVersion: '1.0',
    projectDir: '/tmp/project',
    mode: 'robotics',
    workflowSourceFile: '/project/AGENT.md',
    currentPhaseId: 'phase_one',
    currentPhaseEnteredAt: Date.now(),
    completedGateItems,
    phaseHistory: [],
  }
}

describe('buildW1Section', () => {
  it('is memoized until workflow_phase is invalidated', async () => {
    const registry = new SectionRegistry()
    const getState = vi.fn()
      .mockReturnValueOnce(makeState())
      .mockReturnValueOnce(makeState(['phase_one_gate_0']))
    const section = buildW1Section(makeDefinition(), getState)

    const first = await registry.resolveToString([section])
    const second = await registry.resolveToString([section])
    registry.invalidate('workflow_phase')
    const third = await registry.resolveToString([section])

    expect(getState).toHaveBeenCalledTimes(2)
    expect(first).toContain('[ ] REQUIRED')
    expect(second).toBe(first)
    expect(third).toContain('[x] DONE')
  })
})
