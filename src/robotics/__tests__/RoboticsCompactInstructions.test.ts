/**
 * Tests for buildRoboticsCompactInstructions()
 *
 * Verifies that the robotics compact instructions block:
 *   - Returns null when there is nothing to preserve (empty session)
 *   - Includes active sub-agent task IDs verbatim
 *   - Includes hardware safety constraints
 *   - Includes current phase
 *   - Handles partial state gracefully
 */

import { describe, it, expect } from 'vitest'
import { buildRoboticsCompactInstructions, buildRoboticsDeterministicAnchors } from '../compactInstructions.js'
import type { RoboticsProjectState } from '../types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<RoboticsProjectState> = {}): RoboticsProjectState {
  return {
    schemaVersion: '1.0',
    sessionId: 'sess-abc',
    projectDir: '/home/user/robot',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    progressNotes: [],
    activeSubAgentTasks: [],
    completedSubAgentTaskIds: [],
    git: { enabled: false, mainBranch: 'main', subAgentBranches: {}, forkPoints: {} },
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildRoboticsCompactInstructions', () => {
  it('returns null when state is null and no hardware summary', () => {
    const result = buildRoboticsCompactInstructions({ state: null })
    expect(result).toBeNull()
  })

  it('returns null when state has no tasks, no phase, and no hardware summary', () => {
    const result = buildRoboticsCompactInstructions({ state: makeState() })
    expect(result).toBeNull()
  })

  it('includes task ID and title when there are active sub-agent tasks', () => {
    const state = makeState({
      activeSubAgentTasks: [
        {
          taskId: 'task-0001-abc',
          role: 'experiment',
          title: 'Locomotion gait tuning',
          spawnedAt: Date.now(),
          on_complete: 'call get_sub_agent_status and merge if success_rate ≥ 90%',
        },
      ],
    })

    const result = buildRoboticsCompactInstructions({ state })
    expect(result).not.toBeNull()
    expect(result).toContain('task-0001-abc')
    expect(result).toContain('Locomotion gait tuning')
    expect(result).toContain('on_complete')
    expect(result).toContain('get_sub_agent_status')
  })

  it('includes branch name when present', () => {
    const state = makeState({
      activeSubAgentTasks: [
        {
          taskId: 'task-xyz',
          role: 'experiment',
          title: 'SLAM test',
          spawnedAt: Date.now(),
          branchName: 'exp/slam-test',
        },
      ],
    })

    const result = buildRoboticsCompactInstructions({ state })
    expect(result).toContain('exp/slam-test')
  })

  it('includes current phase when set', () => {
    const state = makeState({ currentPhase: 'train — 实验验证 3/5' })

    const result = buildRoboticsCompactInstructions({ state })
    expect(result).not.toBeNull()
    expect(result).toContain('train — 实验验证 3/5')
  })

  it('includes hardware summary when provided', () => {
    const result = buildRoboticsCompactInstructions({
      state: null,
      hardwareSummary: 'Platform: Unitree Go2\nMax joint velocity: 10 rad/s\nEmergency stop: GPIO pin 17',
    })

    expect(result).not.toBeNull()
    expect(result).toContain('Unitree Go2')
    expect(result).toContain('Max joint velocity')
    expect(result).toContain('Emergency stop')
  })

  it('includes current experience working set with applicability reasons', () => {
    const result = buildRoboticsCompactInstructions({
      state: null,
      experienceWorkingSet: [
        {
          id: 'exp_mabc_1234abcd',
          title: 'Go2 MPC torque saturation',
          appliesBecause: 'same robot platform (go2); same algorithm (MPC)',
          principle: 'Torque saturation often comes from gain and actuator limit mismatch.',
        },
      ],
    })

    expect(result).not.toBeNull()
    expect(result).toContain('Current Experience Working Set')
    expect(result).toContain('exp_mabc_1234abcd')
    expect(result).toContain('same robot platform (go2); same algorithm (MPC)')
    expect(result).toContain('Torque saturation often comes from gain')
  })

  it('truncates hardware summary to 400 chars to avoid bloating compact', () => {
    const longSummary = 'Z'.repeat(600)   // use Z — no collision with other result text
    const result = buildRoboticsCompactInstructions({
      state: null,
      hardwareSummary: longSummary,
    })
    expect(result).not.toBeNull()
    // Count Z's: only the (trimmed) hardware summary contributes them
    const countZ = (result ?? '').split('Z').length - 1
    expect(countZ).toBeLessThanOrEqual(400)
    // And the full 600-char block must NOT be present
    expect(result).not.toContain('Z'.repeat(401))
  })

  it('includes multiple tasks all with their IDs', () => {
    const state = makeState({
      activeSubAgentTasks: [
        { taskId: 'task-001', role: 'experiment', title: 'Exp A', spawnedAt: Date.now() },
        { taskId: 'task-002', role: 'paper_search', title: 'Paper B', spawnedAt: Date.now() },
      ],
    })

    const result = buildRoboticsCompactInstructions({ state })
    expect(result).toContain('task-001')
    expect(result).toContain('task-002')
    expect(result).toContain('Exp A')
    expect(result).toContain('Paper B')
  })

  it('always includes the experience-IDs and safety-limits reminder', () => {
    const state = makeState({ currentPhase: 'deploy' })
    const result = buildRoboticsCompactInstructions({ state })
    expect(result).toContain('exp_')       // experience ID format hint
    expect(result).toContain('safety')     // safety limits reminder
  })

  it('includes Compact Instructions header', () => {
    const state = makeState({ currentPhase: 'init' })
    const result = buildRoboticsCompactInstructions({ state })
    expect(result).toContain('## Compact Instructions (Robotics Mode)')
  })

  it('lists completed sub-agent task IDs and asks to preserve their final status', () => {
    const state = makeState({
      completedSubAgentTaskIds: ['TASK_20260606_001', 'TASK_20260606_002'],
    })
    const result = buildRoboticsCompactInstructions({ state })
    expect(result).not.toBeNull()
    expect(result).toContain('Completed Sub-Agent Tasks')
    expect(result).toContain('TASK_20260606_001')
    expect(result).toContain('TASK_20260606_002')
    expect(result).toContain('merge-or-discard')
  })
})

describe('buildRoboticsDeterministicAnchors', () => {
  it('returns null when there is nothing worth anchoring', () => {
    expect(buildRoboticsDeterministicAnchors({ state: null })).toBeNull()
    expect(buildRoboticsDeterministicAnchors({ state: makeState() })).toBeNull()
  })

  it('renders a factual anchor block with active + completed task IDs, phase, and hardware', () => {
    const state = makeState({
      currentPhase: 'train — 3/5',
      activeSubAgentTasks: [
        {
          taskId: 'TASK_ACTIVE_9',
          role: 'experiment',
          title: 'Gait tuning',
          spawnedAt: Date.now(),
          on_complete: 'merge if reward improves',
        },
      ],
      completedSubAgentTaskIds: ['TASK_DONE_1'],
    })
    const result = buildRoboticsDeterministicAnchors({
      state,
      hardwareSummary: 'Max joint velocity: 10 rad/s',
    })
    expect(result).not.toBeNull()
    expect(result).toContain('Robotics State Anchors (deterministic)')
    expect(result).toContain('TASK_ACTIVE_9')
    expect(result).toContain('merge if reward improves')
    expect(result).toContain('TASK_DONE_1')
    expect(result).toContain('train — 3/5')
    expect(result).toContain('Max joint velocity')
  })

  it('is factual (not instruction-framed) so it can be appended to summary output', () => {
    const result = buildRoboticsDeterministicAnchors({ state: makeState({ currentPhase: 'deploy' }) })
    expect(result).not.toBeNull()
    // No "you MUST preserve" steering language — this block is appended verbatim.
    expect(result).not.toContain('you MUST')
    expect(result).not.toContain('## Compact Instructions')
  })
})
