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
  type ParallelBranch,
} from '../LoopIR.js'
import {
  runParallelNode,
  type BranchOps,
  type BranchRunResult,
  type MergeOutcome,
} from '../ParallelBranchRunner.js'
import { Blackboard } from '../Blackboard.js'
import { parseOrchPlan } from '../PlannerAgent.js'
import type { PlanRunContext } from '../PlanRunner.js'
import { filesOutsideWriteScope } from '../KernelBranchOps.js'

function planWith(node: OrchNode): OrchPlan {
  return { entry: node.id, nodes: [node], edges: [] }
}

const ctx = (blackboard?: Blackboard): PlanRunContext => ({
  signal: new AbortController().signal,
  visits: new Map(),
  totalSteps: 0,
  costUsd: 0,
  blackboard,
})

/** A BranchOps stub: canned branch results + recorded merge calls. */
function stubOps(
  results: Record<string, Partial<BranchRunResult>>,
  merge?: { clean?: MergeOutcome; resolve?: MergeOutcome },
): BranchOps & { mergeCleanCalls: string[]; resolveCalls: { branchId: string; integrator: string }[] } {
  const mergeCleanCalls: string[] = []
  const resolveCalls: { branchId: string; integrator: string }[] = []
  return {
    mergeCleanCalls,
    resolveCalls,
    async runBranch(b: ParallelBranch): Promise<BranchRunResult> {
      const r = results[b.id] ?? {}
      return {
        id: b.id,
        success: r.success ?? true,
        changedFiles: r.changedFiles ?? [],
        summary: r.summary,
        error: r.error,
        costUsd: r.costUsd ?? 0,
        isWriter: r.isWriter ?? (b.workspaceMode === 'isolated_write'),
      }
    },
    async mergeClean(id) { mergeCleanCalls.push(id); return merge?.clean ?? { merged: true } },
    async resolveAndMerge({ branchId, integrator }) { resolveCalls.push({ branchId, integrator }); return merge?.resolve ?? { merged: true } },
  }
}

const pnode = (over: Partial<OrchNode>): OrchNode => ({
  id: 'p', kind: 'parallel', taskDescription: 'group',
  branches: [], ...over,
})

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

describe('filesOutsideWriteScope', () => {
  it('accepts files covered by exact, star, and globstar scopes', () => {
    expect(filesOutsideWriteScope(
      ['src/auth/index.ts', 'src/api.ts', 'README.md'],
      ['src/auth/**', 'src/*.ts', 'README.md'],
    )).toEqual([])
  })

  it('reports files outside the declared branch scope', () => {
    expect(filesOutsideWriteScope(
      ['src/auth/index.ts', 'src/billing/index.ts'],
      ['src/auth/**'],
    )).toEqual(['src/billing/index.ts'])
  })

  it('checks both sides of git rename status paths', () => {
    expect(filesOutsideWriteScope(
      ['src/auth/old.ts -> src/auth/new.ts', 'src/auth/old.ts -> src/billing/new.ts'],
      ['src/auth/**'],
    )).toEqual(['src/auth/old.ts -> src/billing/new.ts'])
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

// ── runParallelNode (pure orchestration over a BranchOps stub) ───────────────────

describe('runParallelNode', () => {
  const branch = (id: string, over?: Partial<ParallelBranch>): ParallelBranch => ({ id, taskDescription: id, ...over })

  it('all readers succeed → ok, and publishes each output to the blackboard', async () => {
    const node = pnode({ branches: [branch('r1'), branch('r2')] })
    const ops = stubOps({ r1: { summary: 'sumX' }, r2: { summary: 'sumY' } })
    const bb = new Blackboard()
    const v = await runParallelNode(ops, node, ctx(bb))
    expect(v).toMatchObject({ action: 'branch', label: 'ok' })
    expect(ops.mergeCleanCalls).toHaveLength(0) // readers don't merge
    expect(bb.readFor('p', 'output').map(e => e.messages?.[0])).toEqual(['sumX', 'sumY'])
  })

  it("join 'all' fails when a branch fails", async () => {
    const node = pnode({ branches: [branch('r1'), branch('r2')], join: 'all' })
    const v = await runParallelNode(stubOps({ r2: { success: false, error: 'boom' } }), node, ctx())
    expect(v).toMatchObject({ action: 'branch', label: 'fail' })
    expect(v.messages?.join(' ')).toContain('boom')
  })

  it("join 'any' passes with one success", async () => {
    const node = pnode({ branches: [branch('r1'), branch('r2')], join: 'any' })
    const v = await runParallelNode(stubOps({ r1: { success: false, error: 'x' }, r2: { success: true } }), node, ctx())
    expect(v.label).toBe('ok')
  })

  it('disjoint writers → all clean merges, no integrator', async () => {
    const node = pnode({
      branches: [
        branch('auth', { workspaceMode: 'isolated_write', writeScope: ['src/auth/**'] }),
        branch('api', { workspaceMode: 'isolated_write', writeScope: ['src/api/**'] }),
      ],
    })
    const ops = stubOps({
      auth: { isWriter: true, changedFiles: ['src/auth/a.ts'] },
      api: { isWriter: true, changedFiles: ['src/api/b.ts'] },
    })
    const v = await runParallelNode(ops, node, ctx())
    expect(v.label).toBe('ok')
    expect(ops.mergeCleanCalls).toEqual(['auth', 'api'])
    expect(ops.resolveCalls).toHaveLength(0)
  })

  it('overlapping writers → conflicting branch routed to the integrator', async () => {
    const node = pnode({ integrator: 'integrator', branches: [
      branch('a', { workspaceMode: 'isolated_write', writeScope: ['src/**'] }),
      branch('b', { workspaceMode: 'isolated_write', writeScope: ['src/**'] }),
    ] })
    const ops = stubOps({
      a: { isWriter: true, changedFiles: ['src/shared.ts'] },
      b: { isWriter: true, changedFiles: ['src/shared.ts'] }, // overlaps a
    })
    const v = await runParallelNode(ops, node, ctx())
    expect(v.label).toBe('ok')
    expect(ops.mergeCleanCalls).toEqual(['a'])           // a merges clean
    expect(ops.resolveCalls).toEqual([{ branchId: 'b', integrator: 'integrator' }]) // b → integrator
  })

  it('merge failure → fail verdict with correctives', async () => {
    const node = pnode({ branches: [branch('w', { workspaceMode: 'isolated_write', writeScope: ['src/**'] })] })
    const ops = stubOps({ w: { isWriter: true, changedFiles: ['src/x.ts'] } }, { clean: { merged: false, error: 'conflict' } })
    const v = await runParallelNode(ops, node, ctx())
    expect(v.label).toBe('fail')
    expect(v.messages?.join(' ')).toContain('合并失败')
  })
})

// ── parseOrchPlan: parallel node parsing ────────────────────────────────────────

describe('parseOrchPlan (parallel)', () => {
  it('parses branches/join/integrator and the plan validates', () => {
    const json = '```json\n' + JSON.stringify({
      entry: 'build',
      nodes: [{
        id: 'build', kind: 'parallel', taskDescription: 'build', join: 'all', integrator: 'integrator',
        branches: [
          { id: 'auth', taskDescription: 'auth', workspaceMode: 'isolated_write', writeScope: ['src/auth/**'], allowedTools: ['edit_file'] },
          { id: 'api', taskDescription: 'api', workspaceMode: 'isolated_write', writeScope: ['src/api/**'] },
        ],
      }],
      edges: [],
    }) + '\n```'
    const plan = parseOrchPlan(json)
    expect(plan).not.toBeNull()
    const node = plan!.nodes[0]!
    expect(node.kind).toBe('parallel')
    expect(node.branches).toHaveLength(2)
    expect(node.branches![0]).toMatchObject({ id: 'auth', workspaceMode: 'isolated_write' })
    expect(node.branches![0]!.writeScope).toEqual(['src/auth/**'])
    expect(node.join).toBe('all')
    expect(node.integrator).toBe('integrator')
    expect(validatePlan(plan!)).toHaveLength(0)
  })
})

// ── rubric examples must parse + validate (locks the prompt's correctness) ───────

describe('PLANNER_RUBRIC examples', () => {
  it('example B (conditional branch A→B→C/D) parses and validates', () => {
    const json = '```json\n' + JSON.stringify({
      entry: 'A',
      nodes: [
        { id: 'A', kind: 'executor', taskDescription: '...' },
        { id: 'B', kind: 'executor', taskDescription: '...' },
        { id: 'C', kind: 'executor', taskDescription: '...' },
        { id: 'D', kind: 'executor', taskDescription: '修复 B 的失败' },
      ],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C', when: { on: 'verdictLabel', label: 'ok' } },
        { from: 'B', to: 'D', when: { on: 'verdictLabel', label: 'error' } },
      ],
    }) + '\n```'
    const plan = parseOrchPlan(json)
    expect(plan).not.toBeNull()
    expect(validatePlan(plan!)).toHaveLength(0)
  })

  it('parallel-write example (disjoint scopes) parses and validates', () => {
    const json = '```json\n' + JSON.stringify({
      id: 'plan', entry: 'build',
      nodes: [{
        id: 'build', kind: 'parallel', taskDescription: '并行实现各模块', join: 'all', integrator: 'integrator',
        branches: [
          { id: 'auth', taskDescription: '实现鉴权模块', allowedTools: ['read_file', 'edit_file', 'bash'], workspaceMode: 'isolated_write', writeScope: ['src/auth/**'] },
          { id: 'api', taskDescription: '实现API模块', allowedTools: ['read_file', 'edit_file', 'bash'], workspaceMode: 'isolated_write', writeScope: ['src/api/**'] },
        ],
      }],
      edges: [],
    }) + '\n```'
    const plan = parseOrchPlan(json)
    expect(plan).not.toBeNull()
    expect(plan!.nodes[0]!.kind).toBe('parallel')
    expect(validatePlan(plan!)).toHaveLength(0)
  })
})
