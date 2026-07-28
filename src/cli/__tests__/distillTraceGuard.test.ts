import { describe, expect, it } from 'vitest'
import { referencesDistillTrace } from '../distillTraceGuard.js'

/**
 * `.loop/distill/` holds the Architect checkpoint and the per-attempt run
 * trace. Architect and Reviewer both carry read_file/grep/glob over the whole
 * workspace, and glob's SKIP_DIRS does not exclude `.loop`, so without this
 * guard a phase could read an earlier attempt's rejected graph or a previous
 * reviewer verdict — making the independent review accidentally, and
 * unrepeatably, stateful.
 */
describe('Distill trace read guard', () => {
  it('denies reads that target the run trace or the architect checkpoint', () => {
    expect(referencesDistillTrace({ path: '.loop/distill/run-2026/review.r0.c3.json' })).toBe(true)
    expect(referencesDistillTrace({ file_path: './.loop/distill/architect.checkpoint.json' })).toBe(true)
    expect(referencesDistillTrace({ path: '/Users/me/proj/.loop/distill' })).toBe(true)
    expect(referencesDistillTrace({ pattern: '**/*.json', path: '.loop/distill/run-x' })).toBe(true)
    expect(referencesDistillTrace({ path: '.loop' })).toBe(true)
  })

  it('leaves source files, ordinary globs and loop runtime state readable', () => {
    expect(referencesDistillTrace({ path: 'f1_loop.md' })).toBe(false)
    expect(referencesDistillTrace({ pattern: '**/*.md' })).toBe(false)
    expect(referencesDistillTrace({ path: 'navigation/src' })).toBe(false)
    // Runtime instance state is legitimate evidence for runtime_preconditions.
    expect(referencesDistillTrace({ path: '.loop/instances/nav-v1' })).toBe(false)
  })

  it('does not fire on paths that merely start with the same characters', () => {
    expect(referencesDistillTrace({ path: '.loopback/config' })).toBe(false)
    expect(referencesDistillTrace({ path: 'docs/.looper.md' })).toBe(false)
  })

  it('scans nested argument shapes without unbounded recursion', () => {
    expect(referencesDistillTrace({ opts: { paths: ['src', '.loop/distill/timeline.jsonl'] } })).toBe(true)
    const cyclic: Record<string, unknown> = { path: 'src' }
    cyclic.self = cyclic
    expect(() => referencesDistillTrace(cyclic)).not.toThrow()
  })
})
