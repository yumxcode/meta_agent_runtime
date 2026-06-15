/**
 * Tests for agentic-mode compact instructions + deterministic anchors.
 */
import { describe, it, expect } from 'vitest'
import {
  buildAgenticCompactInstructions,
  buildAgenticDeterministicAnchors,
} from '../compact/agenticCompactAnchors.js'
import type { SubAgentRecord } from '../../subagent/types.js'
import type { TaskContract } from '../contract/types.js'

function record(overrides: Partial<SubAgentRecord> & { taskId: string }): SubAgentRecord {
  return {
    schemaVersion: '1.0',
    parentSessionId: 'parent-1',
    status: 'running',
    config: { taskDescription: 'experiment with reward shaping' },
    createdAt: Date.now(),
    pendingHumanApproval: false,
    ...overrides,
  } as SubAgentRecord
}

const contract = {
  schemaVersion: '1.0',
  contractId: 'contract-abc12345',
  sessionId: 'parent-1',
  createdAt: '2026-06-11T00:00:00Z',
  updatedAt: '2026-06-11T00:00:00Z',
  primaryGoal: 'ship the v9-smooth-landing policy',
  nonGoals: [],
} as unknown as TaskContract

describe('buildAgenticDeterministicAnchors', () => {
  it('returns null when there is nothing to anchor', () => {
    expect(buildAgenticDeterministicAnchors({})).toBeNull()
    expect(buildAgenticDeterministicAnchors({ subAgentTasks: [] })).toBeNull()
  })

  it('anchors active task IDs verbatim', () => {
    const out = buildAgenticDeterministicAnchors({
      subAgentTasks: [record({ taskId: 'task-aaa', status: 'running' })],
    })!
    expect(out).toContain('task-aaa')
    expect(out).toContain('get_sub_agent_status')
    expect(out).toContain('Agentic State Anchors')
  })

  it('anchors terminal outcomes so finished work is not re-run', () => {
    const out = buildAgenticDeterministicAnchors({
      subAgentTasks: [
        record({
          taskId: 'task-done',
          status: 'completed',
          completedAt: Date.now(),
          result: { success: true, summary: 'merged into main' },
        }),
        record({
          taskId: 'task-fail',
          status: 'failed',
          completedAt: Date.now(),
          result: { success: false, summary: '', error: 'OOM at step 3' },
        }),
      ],
    })!
    expect(out).toContain('task-done — completed — success: merged into main')
    expect(out).toContain('task-fail — failed — failed: OOM at step 3')
    expect(out).toContain('do NOT re-run')
  })

  it('includes the task-contract identity and goal', () => {
    const out = buildAgenticDeterministicAnchors({ taskContract: contract })!
    expect(out).toContain('contract-abc12345')
    expect(out).toContain('ship the v9-smooth-landing policy')
  })

  it('caps the enumerated tasks (newest first)', () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      record({ taskId: `task-${i}`, createdAt: i }))
    const out = buildAgenticDeterministicAnchors({ subAgentTasks: tasks })!
    expect(out).toContain('- task_id: task-19 (') // newest kept
    expect(out).not.toContain('- task_id: task-0 (') // oldest dropped (8-task cap)
    expect((out.match(/- task_id:/g) ?? []).length).toBe(8)
  })
})

describe('buildAgenticCompactInstructions', () => {
  it('returns null with no state', () => {
    expect(buildAgenticCompactInstructions({})).toBeNull()
  })

  it('instructs preservation of task IDs and terminal statuses', () => {
    const out = buildAgenticCompactInstructions({
      subAgentTasks: [
        record({ taskId: 'task-live', status: 'running' }),
        record({ taskId: 'task-old', status: 'cancelled', completedAt: Date.now() }),
      ],
      taskContract: contract,
    })!
    expect(out).toContain('Compact Instructions (Agentic Mode)')
    expect(out).toContain('task-live')
    expect(out).toContain('task-old')
    expect(out).toContain('MUST NOT be re-run')
    expect(out).toContain('contract-abc12345')
  })
})
