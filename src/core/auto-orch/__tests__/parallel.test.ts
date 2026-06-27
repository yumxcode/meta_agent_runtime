/**
 * Parallel nodes — IR validation (L1 write-scope disjointness) + planMerge (L2).
 */
import { describe, it, expect } from 'vitest'
import {
  validatePlan,
  planMerge,
  writeScopesOverlap,
  type OrchPlan,
  type OrchNode,
} from '../LoopIR.js'

function planWith(node: OrchNode): OrchPlan {
  return { entry: node.id, nodes: [node], edges: [] }
}

// ── L1: write-scope overlap helper ──────────────────────────────────────────────

describe('writeScopesOverlap', () => {
  it('treats different top-level dirs as disjoint', () => {
    expect(writeScopesOverlap(['src/auth/**'], ['src/api/**'])).toBe(false)
    expect(writeScopesOverlap(['src/auth/**', 'docs/**'], ['src/api/**'])).toBe(false)
  })
  it('treats nested / equal / root scopes as overlapping (conservative)', () => {
    expect(writeScopesOverlap(['src/**'], ['src/auth/**'])).toBe(true) // nested
    expect(writeScopesOverlap(['src/auth/x.ts'], ['src/auth/x.ts'])).toBe(true) // equal
    expect(writeScopesOverlap(['**'], ['anything/**'])).toBe(true) // root
  })
})

// ── L1: parallel node validation ───────────────────────────────────────────────

describe('validatePlan (parallel node)', () => {
  const branch = (id: string, over?: Record<string, unknown>): Record<string, unknown> => ({
    id, taskDescription: id, ...over,
  })

  it('accepts disjoint writers without an integrator', () => {
    const node: OrchNode = {
      id: 'build', kind: 'parallel', taskDescription: 'build modules',
      branches: [
        branch('auth', { workspaceMode: 'isolated_write', writeScope: ['src/auth/**'] }),
        branch('api', { workspaceMode: 'isolated_write', writeScope: ['src/api/**'] }),
      ] as never,
    }
    expect(validatePlan(planWith(node))).toHaveLength(0)
  })

  it('rejects a writer branch without a writeScope', () => {
    const node: OrchNode = {
      id: 'build', kind: 'parallel', taskDescription: 'b',
      branches: [branch('auth', { workspaceMode: 'isolated_write' })] as never,
    }
    expect(validatePlan(planWith(node)).some(e => e.includes('must declare a writeScope'))).toBe(true)
  })

  it('rejects overlapping writers when no integrator is declared', () => {
    const node: OrchNode = {
      id: 'build', kind: 'parallel', taskDescription: 'b',
      branches: [
        branch('a', { workspaceMode: 'isolated_write', writeScope: ['src/**'] }),
        branch('b', { workspaceMode: 'isolated_write', writeScope: ['src/auth/**'] }),
      ] as never,
    }
    expect(validatePlan(planWith(node)).some(e => e.includes('overlapping write-scopes'))).toBe(true)
  })

  it('allows overlapping writers WHEN an integrator is declared', () => {
    const node: OrchNode = {
      id: 'build', kind: 'parallel', taskDescription: 'b', integrator: 'integrator',
      branches: [
        branch('a', { workspaceMode: 'isolated_write', writeScope: ['src/**'] }),
        branch('b', { workspaceMode: 'isolated_write', writeScope: ['src/auth/**'] }),
      ] as never,
    }
    expect(validatePlan(planWith(node))).toHaveLength(0)
  })

  it('accepts read-only branches with no scope, and flags bad quorum', () => {
    const ok: OrchNode = {
      id: 'research', kind: 'parallel', taskDescription: 'r',
      branches: [branch('r1'), branch('r2')] as never,
    }
    expect(validatePlan(planWith(ok))).toHaveLength(0)

    const badQuorum: OrchNode = { ...ok, join: 'quorum', quorum: 5 }
    expect(validatePlan(planWith(badQuorum)).some(e => e.includes('quorum'))).toBe(true)
  })

  it('rejects an empty parallel node', () => {
    const node: OrchNode = { id: 'p', kind: 'parallel', taskDescription: 'p', branches: [] }
    expect(validatePlan(planWith(node)).some(e => e.includes('at least one branch'))).toBe(true)
  })
})

// ── L2: planMerge ───────────────────────────────────────────────────────────────

describe('planMerge', () => {
  it('all disjoint → all clean, deterministic order', () => {
    const plan = planMerge([
      { id: 'auth', changedFiles: ['src/auth/a.ts'] },
      { id: 'api', changedFiles: ['src/api/b.ts'] },
    ])
    expect(plan.order).toEqual(['auth', 'api'])
    expect(plan.cleanMerges).toEqual(['auth', 'api'])
    expect(plan.conflicts).toHaveLength(0)
  })

  it('overlapping branch is flagged for the integrator with the overlap files', () => {
    const plan = planMerge([
      { id: 'auth', changedFiles: ['src/shared/types.ts', 'src/auth/a.ts'] },
      { id: 'api', changedFiles: ['src/shared/types.ts', 'src/api/b.ts'] },
    ])
    expect(plan.cleanMerges).toEqual(['auth'])            // first merges clean
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0]).toMatchObject({ branch: 'api', overlapsWith: ['auth'] })
    expect(plan.conflicts[0]!.files).toEqual(['src/shared/types.ts'])
  })

  it('three-way overlap reports all prior owners', () => {
    const plan = planMerge([
      { id: 'a', changedFiles: ['x'] },
      { id: 'b', changedFiles: ['y'] },
      { id: 'c', changedFiles: ['x', 'y'] }, // overlaps both a and b
    ])
    expect(plan.cleanMerges).toEqual(['a', 'b'])
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0]!.overlapsWith.sort()).toEqual(['a', 'b'])
  })
})
