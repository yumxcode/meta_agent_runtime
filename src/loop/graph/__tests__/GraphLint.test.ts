import { describe, expect, it } from 'vitest'
import { CANONICAL_GRAPH_DISTILL_EXAMPLE, lintLoopGraph, type LoopGraphSpec } from '../index.js'

function graph(): LoopGraphSpec {
  return {
    schemaVersion: 'graph-2.0', id: 'lint_fixture', version: 1, goal: 'Lint fixture.',
    state: { status: { type: { type: 'string' }, initial: 'healthy' } },
    lanes: {
      work: { context: 'persistent', workspace: { read: ['state'], write: [{ path: 'state', mode: 'owned' }], deny: [] } },
    },
    nodes: {
      work: { type: 'agent', lane: 'work', prompt: 'Perform one bounded iteration.', tools: ['read_file'] },
      done: { type: 'terminal', status: 'done' }, failed: { type: 'terminal', status: 'failed' },
    },
    transitions: [
      { id: 'done', from: 'work', to: 'done' },
      { id: 'failed', from: 'work', on: 'failure', to: 'failed' },
    ],
    entrypoints: [{ id: 'start', node: 'work' }], limits: { maxActivations: 10 },
  }
}

describe('graph write-surface lint', () => {
  it('keeps the canonical example and a clean fixture lint-free', () => {
    expect(lintLoopGraph(CANONICAL_GRAPH_DISTILL_EXAMPLE)).toEqual([])
    expect(lintLoopGraph(graph())).toEqual([])
  })

  it('flags prompts that direct writes outside the project (the X1 v3 failure)', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected agent')
    work.prompt = 'Locate the F1 git work tree (outside this project — search common locations). Edit training code, then git commit and push.'
    const findings = lintLoopGraph(spec)
    expect(findings.map(f => f.rule)).toContain('outside-project-write')
    // git ops with an owned prefix present downgrade to the nested-repo reminder.
    expect(findings.find(f => f.rule === 'git-without-capability')?.level).toBe('warning')
  })

  it('does not flag prompts that merely FORBID writing outside the project', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected agent')
    work.prompt = 'Edit files under state/. Never write outside this project.'
    expect(lintLoopGraph(spec).filter(f => f.rule === 'outside-project-write')).toEqual([])
  })

  it('flags absolute and home paths used as prompt targets', () => {
    const spec = graph()
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected agent')
    work.prompt = 'Write results into /Users/yumx/code/F1_locomotion/out.json'
    expect(lintLoopGraph(spec).map(f => f.rule)).toContain('absolute-path')
    work.prompt = 'Wait ~30 minutes between checks, then update state/progress.json'
    expect(lintLoopGraph(spec)).toEqual([])
  })

  it('flags git mutations on a lane with neither scm nor an owned prefix', () => {
    const spec = graph()
    spec.lanes.work.workspace.write = [{ path: 'state/progress.json', mode: 'atomic_replace' }]
    const work = spec.nodes.work
    if (work.type !== 'agent') throw new Error('expected agent')
    work.prompt = 'Implement the change, then git commit and git push.'
    const finding = lintLoopGraph(spec).find(f => f.rule === 'git-without-capability')
    expect(finding?.level).toBe('error')
  })

  it('flags routing on agent-precomputed booleans and dead literal routes', () => {
    const spec = graph()
    spec.transitions = [
      { id: 'stale', from: 'work', when: '$output.is_stale == true', priority: 10, to: 'done', updates: [{ target: 'status', reducer: 'builtin/set@1', args: [{ literal: 'stale' }] }] },
      { id: 'done', from: 'work', default: true, to: 'done' },
      { id: 'dead', from: 'work', when: "$state.status == 'error'", priority: 20, to: 'failed' },
      { id: 'failed', from: 'work', on: 'failure', to: 'failed' },
    ]
    const rules = lintLoopGraph(spec).map(f => f.rule)
    expect(rules).toContain('precomputed-routing')
    expect(rules).toContain('dead-literal-route')
  })
})
