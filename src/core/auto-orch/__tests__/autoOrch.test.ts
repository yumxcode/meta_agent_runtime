/**
 * auto-orch — unit coverage for the (B) phase-hook registry and (C) plan IR +
 * interpreter, plus the predicate DSL and unified verdict adapters.
 *
 * These tests pin the behaviours the design relies on:
 *   • predicates are total + validated;
 *   • verdict adapters map drift/verify onto the unified verdict;
 *   • HookRegistry folds verdicts into the kernel PhaseHookOutcome and is
 *     fail-open + predicate-gated;
 *   • validatePlan rejects malformed graphs;
 *   • PlanRunner walks a generate→verify→fix CYCLE to completion and enforces
 *     its hard bounds.
 */
import { describe, it, expect } from 'vitest'
import {
  evalPredicate,
  validatePredicate,
  type Predicate,
  type LoopStateView,
} from '../predicates.js'
import { fromDrift, fromVerify, continueVerdict, type OrchVerdict } from '../Verdict.js'
import { HookRegistry } from '../HookRegistry.js'
import { validatePlan, detectUnterminableCycles, type OrchPlan, type OrchNode } from '../LoopIR.js'
import { PlanRunner, type NodeRunner } from '../PlanRunner.js'
import type { PhaseHookEvent } from '../../../kernel/loop/PhaseHooks.js'

// ── predicates ─────────────────────────────────────────────────────────────────

describe('predicates', () => {
  const base: LoopStateView = { turnCount: 30, estimatedCostUsd: 1, point: 'pre_tool' }

  it('turnInterval fires only on multiples', () => {
    expect(evalPredicate({ kind: 'turnInterval', n: 30 }, base)).toBe(true)
    expect(evalPredicate({ kind: 'turnInterval', n: 30 }, { ...base, turnCount: 31 })).toBe(false)
    expect(evalPredicate({ kind: 'turnInterval', n: 30 }, { ...base, turnCount: 0 })).toBe(false)
  })

  it('composes and/or/not', () => {
    const p: Predicate = {
      kind: 'and',
      of: [
        { kind: 'atPoint', point: 'pre_tool' },
        { kind: 'not', of: { kind: 'anyToolErrored' } },
      ],
    }
    expect(evalPredicate(p, base)).toBe(true)
    expect(evalPredicate(p, { ...base, erroredToolNames: ['bash'] })).toBe(false)
  })

  it('toolUsed / counterAtLeast / costAtLeast', () => {
    expect(evalPredicate({ kind: 'toolUsed', name: 'bash' }, { ...base, toolNames: ['bash'] })).toBe(true)
    expect(evalPredicate({ kind: 'counterAtLeast', counter: 'fix', n: 2 }, { ...base, counters: { fix: 2 } })).toBe(true)
    expect(evalPredicate({ kind: 'costAtLeast', usd: 5 }, base)).toBe(false)
  })

  it('validatePredicate rejects empty boolean groups and NaN', () => {
    expect(validatePredicate({ kind: 'and', of: [] })).toHaveLength(1)
    expect(validatePredicate({ kind: 'turnInterval', n: Number.NaN })).toHaveLength(1)
    expect(validatePredicate({ kind: 'always' })).toHaveLength(0)
  })
})

// ── verdict adapters ─────────────────────────────────────────────────────────

describe('verdict adapters', () => {
  it('fromDrift maps drifted→inject, clean→continue, skipped→skipped', () => {
    expect(fromDrift({ drifted: false, corrective: [] }).action).toBe('continue')
    const v = fromDrift({ drifted: true, severity: 'major', corrective: ['re-align'] })
    expect(v.action).toBe('inject')
    expect(v.label).toBe('drift_major')
    expect(v.messages).toEqual(['re-align'])
    expect(fromDrift({ drifted: true, corrective: [], skipped: true }).skipped).toBe(true)
  })

  it('fromVerify maps done→done/pass, not-done→reject/fail', () => {
    expect(fromVerify({ done: true, unfinished: [] })).toMatchObject({ action: 'done', label: 'pass' })
    expect(fromVerify({ done: false, unfinished: ['x'] })).toMatchObject({ action: 'reject', label: 'fail' })
  })
})

// ── HookRegistry (B) ─────────────────────────────────────────────────────────

function makeEvent(point: PhaseHookEvent['point'], over?: Partial<PhaseHookEvent['state']>): PhaseHookEvent {
  return {
    point,
    workspaceRoot: '/tmp/ws',
    state: { turnCount: 30, estimatedCostUsd: 0, ...over },
    signal: new AbortController().signal,
  }
}

describe('HookRegistry', () => {
  it('folds inject messages from matching hooks and dedupes', async () => {
    const reg = new HookRegistry()
    reg.register({ id: 'a', point: 'pre_tool', handler: () => ({ action: 'inject', messages: ['m1'] }) })
    reg.register({ id: 'b', point: 'pre_tool', handler: () => ({ action: 'inject', messages: ['m1', 'm2'] }) })
    const fn = reg.toPhaseHookFn()
    const out = await fn(makeEvent('pre_tool'))
    expect(out.inject).toEqual(['m1', 'm2'])
    expect(out.abort).toBeUndefined()
  })

  it('gates hooks by predicate', async () => {
    const reg = new HookRegistry()
    reg.register({
      id: 'interval',
      point: 'post_tool',
      when: { kind: 'turnInterval', n: 10 },
      handler: () => ({ action: 'inject', messages: ['tick'] }),
    })
    const fn = reg.toPhaseHookFn()
    expect((await fn(makeEvent('post_tool', { turnCount: 10 }))).inject).toEqual(['tick'])
    expect((await fn(makeEvent('post_tool', { turnCount: 11 }))).inject).toBeUndefined()
  })

  it('propagates abort and is fail-open on a throwing hook', async () => {
    const reg = new HookRegistry()
    reg.register({ id: 'boom', point: 'pre_query', handler: () => { throw new Error('nope') } })
    reg.register({ id: 'stop', point: 'pre_query', handler: () => ({ action: 'abort', note: 'budget' }) })
    const out = await reg.toPhaseHookFn()(makeEvent('pre_query'))
    expect(out.abort).toBe(true)
    expect(out.note).toContain('boom')
  })

  it('rejects a structurally invalid hook at register time', () => {
    const reg = new HookRegistry()
    expect(() => reg.register({ id: '', point: 'pre_tool', handler: () => continueVerdict() })).toThrow()
  })
})

// ── LoopIR validation (C) ────────────────────────────────────────────────────

describe('validatePlan', () => {
  const node = (id: string, over?: Partial<OrchNode>): OrchNode => ({
    id,
    kind: 'executor',
    taskDescription: `do ${id}`,
    ...over,
  })

  it('accepts a well-formed cyclic plan', () => {
    const plan: OrchPlan = {
      entry: 'gen',
      nodes: [node('gen'), node('verify', { kind: 'role', role: 'verify' })],
      edges: [
        { from: 'gen', to: 'verify' },
        { from: 'verify', to: 'gen', when: { on: 'verdictLabel', label: 'fail' } },
      ],
    }
    expect(validatePlan(plan)).toHaveLength(0)
  })

  it('flags unknown entry, dangling edges, and writer without isolation', () => {
    const bad: OrchPlan = {
      entry: 'missing',
      nodes: [node('gen', { allowedTools: ['edit_file'] })],
      edges: [{ from: 'gen', to: 'ghost' }],
    }
    const errs = validatePlan(bad)
    expect(errs.some(e => e.includes('entry'))).toBe(true)
    expect(errs.some(e => e.includes('ghost'))).toBe(true)
    expect(errs.some(e => e.includes('isolated_write'))).toBe(true)
  })
})

// ── Graceful-termination (cycle escape) check ───────────────────────────────────

describe('detectUnterminableCycles', () => {
  const exec = (id: string): OrchNode => ({ id, kind: 'executor', taskDescription: id })

  it('accepts generate→verify→fix (verify pass terminates via no-match)', () => {
    const plan: OrchPlan = {
      entry: 'gen',
      nodes: [exec('gen'), { id: 'verify', kind: 'role', role: 'verify', taskDescription: 'v' }],
      edges: [
        { from: 'gen', to: 'verify' },
        { from: 'verify', to: 'gen', when: { on: 'verdictLabel', label: 'fail' } },
      ],
    }
    expect(detectUnterminableCycles(plan)).toHaveLength(0)
  })

  it('accepts a branch+cycle graph with a conditional escape (B error → D)', () => {
    const plan: OrchPlan = {
      entry: 'A',
      nodes: [exec('A'), exec('B'), exec('C'), exec('D')],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C', when: { on: 'verdictLabel', label: 'ok' } },
        { from: 'B', to: 'D', when: { on: 'verdictLabel', label: 'error' } },
        { from: 'C', to: 'A', when: { on: 'verdictLabel', label: 'loop' } },
      ],
    }
    expect(detectUnterminableCycles(plan)).toHaveLength(0)
  })

  it('REJECTS a trapped cycle where every edge is unconditional (A↔B always)', () => {
    const plan: OrchPlan = {
      entry: 'A',
      nodes: [exec('A'), exec('B')],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' },
      ],
    }
    const errs = detectUnterminableCycles(plan)
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('no graceful exit')
    // and validatePlan surfaces it too
    expect(validatePlan(plan).some(e => e.includes('no graceful exit'))).toBe(true)
  })

  it('REJECTS an unconditional self-loop but ACCEPTS a conditional one', () => {
    const trapped: OrchPlan = {
      entry: 'A',
      nodes: [exec('A')],
      edges: [{ from: 'A', to: 'A' }],
    }
    expect(detectUnterminableCycles(trapped)).toHaveLength(1)

    const ok: OrchPlan = {
      entry: 'A',
      nodes: [exec('A')],
      edges: [{ from: 'A', to: 'A', when: { on: 'verdictLabel', label: 'retry' } }],
    }
    expect(detectUnterminableCycles(ok)).toHaveLength(0) // 'done' verdict → terminates
  })

  it('REJECTS when an always edge shadows the only escape', () => {
    // B→A (always) fires first and stays in the cycle; B→C (conditional) is dead.
    const plan: OrchPlan = {
      entry: 'A',
      nodes: [exec('A'), exec('B'), exec('C')],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' }, // always, declared first → shadows the escape
        { from: 'B', to: 'C', when: { on: 'verdictLabel', label: 'pass' } },
      ],
    }
    expect(detectUnterminableCycles(plan)).toHaveLength(1)
  })
})

// ── PlanRunner (C) ────────────────────────────────────────────────────────────

describe('PlanRunner', () => {
  const genVerifyFix: OrchPlan = {
    entry: 'gen',
    nodes: [
      { id: 'gen', kind: 'executor', taskDescription: 'generate' },
      { id: 'verify', kind: 'role', role: 'verify', taskDescription: 'verify goal' },
    ],
    edges: [
      { from: 'gen', to: 'verify' },
      // back-edge: verify fail → regenerate (a real loop)
      { from: 'verify', to: 'gen', when: { on: 'verdictLabel', label: 'fail' } },
      // verify pass → terminal (no matching edge → completes)
    ],
  }

  it('runs a generate→verify→fix cycle until verify passes', async () => {
    let verifyCalls = 0
    const runner: NodeRunner = {
      async run(node): Promise<OrchVerdict> {
        if (node.id === 'verify') {
          verifyCalls++
          // fail twice, then pass
          return verifyCalls < 3
            ? { action: 'branch', label: 'fail', data: { costUsd: 0.1 } }
            : { action: 'done', label: 'pass', data: { costUsd: 0.1 } }
        }
        return { action: 'continue', data: { costUsd: 0.2 } }
      },
    }
    const result = await new PlanRunner(genVerifyFix, runner).run(new AbortController().signal)
    expect(result.status).toBe('completed')
    expect(verifyCalls).toBe(3)
    // gen,verify ×3 then loop: gen×3, verify×3
    expect(result.visitedPath.filter(id => id === 'gen').length).toBe(3)
    expect(result.costUsd).toBeCloseTo(0.2 * 3 + 0.1 * 3, 5)
  })

  it('enforces maxNodeVisits when a cycle never converges', async () => {
    const alwaysFail: NodeRunner = {
      async run(node): Promise<OrchVerdict> {
        return node.id === 'verify' ? { action: 'branch', label: 'fail' } : { action: 'continue' }
      },
    }
    const bounded: OrchPlan = { ...genVerifyFix, bounds: { maxNodeVisits: 3 } }
    const result = await new PlanRunner(bounded, alwaysFail).run(new AbortController().signal)
    expect(result.status).toBe('bounds_exceeded')
    expect(result.note).toContain('visited')
  })

  it('returns invalid (and never runs) for a malformed plan', async () => {
    const runner: NodeRunner = { async run() { throw new Error('should not run') } }
    const result = await new PlanRunner({ entry: 'x', nodes: [], edges: [] }, runner).run(
      new AbortController().signal,
    )
    expect(result.status).toBe('invalid')
    expect(result.visitedPath).toHaveLength(0)
  })

  it('stops cleanly on an abort verdict', async () => {
    const runner: NodeRunner = { async run() { return { action: 'abort', note: 'stop now' } } }
    const result = await new PlanRunner(genVerifyFix, runner).run(new AbortController().signal)
    expect(result.status).toBe('completed')
    expect(result.note).toBe('stop now')
  })

  it('reports failed (fail-open) when a node runner throws', async () => {
    const runner: NodeRunner = { async run() { throw new Error('kaboom') } }
    const result = await new PlanRunner(genVerifyFix, runner).run(new AbortController().signal)
    expect(result.status).toBe('failed')
    expect(result.note).toContain('kaboom')
  })

  it('addresses corrective messages to the back-edge target node (topology-derived)', async () => {
    // Two independent review loops; each verify must address its fix to ITS OWN
    // executor — never the other one (the cross-contamination the addressing fixes).
    const plan: OrchPlan = {
      entry: 'buildAuth',
      nodes: [
        { id: 'buildAuth', kind: 'executor', taskDescription: 'auth' },
        { id: 'verifyAuth', kind: 'role', role: 'verify', taskDescription: 'va' },
        { id: 'buildApi', kind: 'executor', taskDescription: 'api' },
        { id: 'verifyApi', kind: 'role', role: 'verify', taskDescription: 'vp' },
      ],
      edges: [
        { from: 'buildAuth', to: 'verifyAuth' },
        { from: 'verifyAuth', to: 'buildApi', when: { on: 'verdictLabel', label: 'pass' } },
        { from: 'verifyAuth', to: 'buildAuth', when: { on: 'verdictLabel', label: 'fail' } },
        { from: 'buildApi', to: 'verifyApi' },
        { from: 'verifyApi', to: 'buildApi', when: { on: 'verdictLabel', label: 'fail' } },
      ],
    }
    // verifyAuth fails once (→ buildAuth), then passes; verifyApi passes.
    let vaCalls = 0
    const runner: NodeRunner = {
      async run(node): Promise<OrchVerdict> {
        if (node.id === 'verifyAuth') {
          vaCalls++
          return vaCalls < 2
            ? { action: 'branch', label: 'fail', messages: ['fix token expiry'] }
            : { action: 'done', label: 'pass' }
        }
        if (node.id === 'verifyApi') return { action: 'done', label: 'pass' }
        return { action: 'branch', label: 'ok' } // executors
      },
    }
    const pr = new PlanRunner(plan, runner)
    const result = await pr.run(new AbortController().signal)
    expect(result.status).toBe('completed')

    const bb = pr.getBlackboard()
    // the auth fix was addressed to buildAuth, and reaches ONLY buildAuth
    expect(bb.entries().some(e => e.kind === 'corrective' && e.to === 'buildAuth')).toBe(true)
    expect(bb.hasCorrectivesFor('buildApi')).toBe(false) // no cross-contamination
    expect(bb.takeCorrectivesFor('buildAuth')).toEqual([{ from: 'verifyAuth', messages: ['fix token expiry'] }])
  })
})
