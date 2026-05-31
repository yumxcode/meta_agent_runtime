import { describe, expect, it } from 'vitest'
import {
  TEAM_STATE_LATEST_VERSION,
  TeamStateSchema,
  TeamStateV10Schema,
  TeamStateV20Schema,
  migrateTeamState,
} from '../schemas.js'

function validV20() {
  return {
    schemaVersion: '2.0' as const,
    project: 'demo',
    goals: ['ship robot'],
    tasks: [{
      id: 'TASK-001',
      title: 'first',
      status: 'open' as const,
      attempts: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    units: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function validV10() {
  return {
    schemaVersion: '1.0' as const,
    project: 'demo',
    goals: ['ship robot'],
    modules: [{ name: 'core', paths: ['src/**'], responsibilities: ['core'] }],
    tasks: [
      {
        id: 'TASK-001',
        title: 'first',
        status: 'in_progress' as const,
        ownerUnit: 'alice',
        paths: ['src/**'],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'TASK-002',
        title: 'second',
        status: 'done' as const,
        paths: ['tests/**'],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'TASK-003',
        title: 'third',
        status: 'cancelled' as const,
        paths: ['tests/**'],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'TASK-004',
        title: 'fourth',
        status: 'blocked' as const,
        paths: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    units: [{
      id: 'alice', machine: 'alice-mac', status: 'idle' as const, lastSeen: '2026-01-01T00:00:00.000Z',
    }],
    decisions: ['use ROS 2'],
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('TEAM_STATE_LATEST_VERSION', () => {
  it('is 2.0 today', () => {
    expect(TEAM_STATE_LATEST_VERSION).toBe('2.0')
  })
})

describe('TeamStateSchema (v2.0 alias)', () => {
  it('parses a valid v2.0 state', () => {
    expect(TeamStateSchema.safeParse(validV20()).success).toBe(true)
    expect(TeamStateV20Schema.safeParse(validV20()).success).toBe(true)
  })
  it('rejects v1.0 input via the canonical schema (must migrate first)', () => {
    expect(TeamStateSchema.safeParse(validV10()).success).toBe(false)
    expect(TeamStateV10Schema.safeParse(validV10()).success).toBe(true)
  })
  it('rejects a v2.0 state missing required field', () => {
    const bad = validV20() as Record<string, unknown>
    delete bad['project']
    expect(TeamStateSchema.safeParse(bad).success).toBe(false)
  })
})

describe('migrateTeamState — v2.0 passthrough', () => {
  it('returns validated state for a current v2.0 payload', () => {
    const out = migrateTeamState(validV20())
    expect(out?.schemaVersion).toBe('2.0')
    expect(out?.tasks).toHaveLength(1)
  })
  it('returns null for non-object input', () => {
    expect(migrateTeamState(null)).toBeNull()
    expect(migrateTeamState('hello')).toBeNull()
    expect(migrateTeamState(42)).toBeNull()
  })
  it('returns null for unknown future schemaVersion', () => {
    expect(migrateTeamState({ ...validV20(), schemaVersion: '99.0' })).toBeNull()
  })
})

describe('migrateTeamState — v1.0 → v2.0 upgrade', () => {
  it('drops modules/decisions/paths/branch and initialises attempts[]', () => {
    const out = migrateTeamState(validV10())!
    expect(out.schemaVersion).toBe('2.0')
    expect((out as unknown as { modules?: unknown }).modules).toBeUndefined()
    expect((out as unknown as { decisions?: unknown }).decisions).toBeUndefined()
    for (const t of out.tasks) {
      expect(t.attempts).toEqual([])
      expect((t as unknown as { paths?: unknown }).paths).toBeUndefined()
    }
  })

  it('preserves ownerUnit + goals + project', () => {
    const out = migrateTeamState(validV10())!
    expect(out.project).toBe('demo')
    expect(out.goals).toEqual(['ship robot'])
    expect(out.tasks.find(t => t.id === 'TASK-001')?.ownerUnit).toBe('alice')
  })

  it('collapses 9-state status into open|paused|done', () => {
    const out = migrateTeamState(validV10())!
    const t1 = out.tasks.find(t => t.id === 'TASK-001')!
    const t2 = out.tasks.find(t => t.id === 'TASK-002')!
    const t3 = out.tasks.find(t => t.id === 'TASK-003')!
    const t4 = out.tasks.find(t => t.id === 'TASK-004')!
    expect(t1.status).toBe('open')      // in_progress → open
    expect(t2.status).toBe('done')      // done       → done
    expect(t3.status).toBe('done')      // cancelled  → done
    expect(t4.status).toBe('paused')    // blocked    → paused
  })

  it('collapses 3-state unit status into active|away', () => {
    const out = migrateTeamState(validV10())!
    expect(out.units[0]!.status).toBe('away')   // idle → away
  })

  it('returns null when v1.0 payload is structurally broken', () => {
    const broken = { ...validV10(), tasks: 'not-an-array' }
    expect(migrateTeamState(broken)).toBeNull()
  })
})
