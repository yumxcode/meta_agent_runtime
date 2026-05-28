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
import { buildRoboticsCompactInstructions } from '../compactInstructions.js'
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
})
