import { describe, expect, it } from 'vitest'
import {
  buildGraphDistillerSystem,
  buildGraphSemanticReviewerSystem,
  buildLoopArchitectSystem,
  buildLoopIntakeSystem,
  createDefaultGraphRuntimeCatalog,
  graphReference,
  INTAKE_PROBE_BANK,
} from '../index.js'
import { createGlobTool } from '../../../tools/fs/glob/index.js'
import { createListDirTool } from '../../../tools/fs/list_dir/index.js'

/**
 * Graph Loop compiles requirements from ANY domain. Every prompt it ships is
 * therefore infrastructure, and the fastest way to degrade it is to paste in
 * vocabulary from whichever project was being debugged that week: a model shown
 * a robotics-shaped example while compiling a compliance-reporting loop is
 * being primed toward the wrong shape before it reads a single requirement.
 *
 * This has happened twice. A previous round had to strip `stale_count`,
 * `pivot`, `attention` and literal thresholds from the Compiler after a
 * specific research loop's vocabulary leaked in. A later round leaked a
 * training project's directory names and CLI names into the Intake example and
 * the glob tool's skip list.
 *
 * The rule this encodes: prompts may describe MECHANISM in the abstract and may
 * use conventional, ecosystem-wide names (node_modules, src/, *.ts). They may
 * not name a particular project's directories, tools, files or metrics.
 */
const FORBIDDEN = [
  // A robotics/RL training project
  'isaacgym', 'mujoco', 'gradmotion', 'humanoid/', 'pylibs', 'account-pool',
  'amp_loop', 'discriminator', 'motion.npz', 'urdf', 'mjcf', 'retarget',
  // A specific research loop's routing vocabulary (stripped once already)
  'stale_count', 'stale_countA', 'stale_countB', 'stale_countC',
  'pivot_state', 'attention_required',
  // Domain metric names that only make sense for one requirement
  'style reward', 'sim2sim', 'gate a', 'gate b', 'gate c',
]

const prompts = (): Record<string, string> => {
  const catalog = createDefaultGraphRuntimeCatalog()
  return {
    intake: buildLoopIntakeSystem(),
    architect: buildLoopArchitectSystem(),
    'architect (with intake)': buildLoopArchitectSystem(true),
    compiler: buildGraphDistillerSystem(catalog),
    reviewer: buildGraphSemanticReviewerSystem(),
    'graph_reference: overview': graphReference('overview', catalog),
    'graph_reference: nodes': graphReference('nodes', catalog),
    'graph_reference: control': graphReference('control', catalog),
    'graph_reference: lanes': graphReference('lanes', catalog),
    'graph_reference: workspace': graphReference('workspace', catalog),
    'intake probe bank': INTAKE_PROBE_BANK.map(probe => probe.question).join('\n'),
  }
}

describe('Distill prompts stay domain-neutral', () => {
  for (const [name, text] of Object.entries(prompts())) {
    it(`${name} names no specific project's tools, paths or metrics`, () => {
      const lower = text.toLowerCase()
      const leaked = FORBIDDEN.filter(term => lower.includes(term.toLowerCase()))
      expect(leaked, `${name} leaked domain vocabulary: ${leaked.join(', ')}`).toEqual([])
    })
  }

  it('covers every prompt a Distill phase actually sends', () => {
    // A prompt added later without a line here would be unguarded, so assert the
    // set explicitly rather than trusting the loop above to be exhaustive.
    expect(Object.keys(prompts())).toEqual(expect.arrayContaining([
      'intake', 'architect', 'architect (with intake)', 'compiler', 'reviewer',
      'graph_reference: control', 'intake probe bank',
    ]))
  })
})

describe('shared file tools stay domain-neutral', () => {
  it('glob and list_dir describe themselves without naming one project', async () => {
    const ctx = { toolNames: new Set(['glob', 'list_dir']) } as never
    for (const make of [createGlobTool, createListDirTool]) {
      const tool = await make()
      const description = typeof tool.description === 'function'
        ? await tool.description(ctx)
        : String(tool.description)
      const leaked = FORBIDDEN.filter(term => description.toLowerCase().includes(term.toLowerCase()))
      expect(leaked, `${tool.name} leaked: ${leaked.join(', ')}`).toEqual([])
    }
  })

  it('skips only ecosystem-wide directory conventions', async () => {
    // `pylibs` was one project's vendoring choice and had no business being a
    // default for every other domain; `env`, `build` and `target` are plausible
    // source directories and were rejected for the same reason.
    const glob = await createGlobTool()
    const skipped = String(await (glob.description as (c: never) => Promise<string>)({ toolNames: new Set() } as never))
    for (const term of ['pylibs', 'humanoid']) expect(skipped).not.toContain(term)
  })
})
