/**
 * research_dispatch — the cost ceiling, and what a truncated run leaves behind.
 *
 * `maxTurns` (60) and `maxDurationMs` (30 min) were both raised for research;
 * `maxBudgetUsd` was not, so every run silently inherited the generic $0.50
 * sub-agent default. That made cost the binding constraint on an agent whose
 * instructions are to "read the relevant sources IN FULL": it was hard-stopped
 * mid-read, never reached `return_result`, and the report saved to disk decayed
 * into whatever narration happened to be in its last message — with nothing on
 * the file to say so.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createResearchDispatchTool } from '../research_dispatch/index.js'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { ToolCallContext } from '../../../core/types.js'
import { DEFAULT_RESEARCH_BUDGET_USD, DEFAULT_RESEARCH_MAX_TURNS } from '../../../infra/budgets.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function projectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'research-budget-'))
  dirs.push(dir)
  return dir
}

/** Records the spawn config and replays a canned terminal state. */
function fakeDispatcher(terminal: Record<string, unknown>): {
  dispatcher: ISubAgentDispatcher
  spawned: Array<Record<string, unknown>>
} {
  const spawned: Array<Record<string, unknown>> = []
  const dispatcher = {
    async spawnSubAgent(args: { config: Record<string, unknown> }) {
      spawned.push(args.config)
      return { taskId: 'task-1', status: 'running' }
    },
    async getStatus() {
      return { taskId: 'task-1', ...terminal }
    },
  } as unknown as ISubAgentDispatcher
  return { dispatcher, spawned }
}

const ctx = {} as ToolCallContext

describe('the research run gets a budget sized for research', () => {
  it('never inherits the generic sub-agent default', async () => {
    const { dispatcher, spawned } = fakeDispatcher({
      status: 'completed',
      result: { summary: 'done', output: { report_markdown: '# Report', conclusion: 'c' } },
    })
    const tool = createResearchDispatchTool({
      dispatcher, projectDir: await projectDir(), sessionId: 's1',
    })

    await tool.call({ question: 'what reward terms do bipedal walkers use?' }, ctx)
    expect(spawned[0]!['maxBudgetUsd']).toBe(DEFAULT_RESEARCH_BUDGET_USD)
    // Turns move with the budget — see infra/budgets.ts. Research gets the
    // most of any tier because it reads sources in full.
    expect(spawned[0]!['maxTurns']).toBe(DEFAULT_RESEARCH_MAX_TURNS)
  })

  it('honours an explicit ceiling for a broad survey', async () => {
    const { dispatcher, spawned } = fakeDispatcher({
      status: 'completed',
      result: { summary: 'done', output: { report_markdown: '# Report' } },
    })
    const tool = createResearchDispatchTool({
      dispatcher, projectDir: await projectDir(), sessionId: 's1',
    })

    await tool.call({ question: 'q', max_budget_usd: 12 }, ctx)
    expect(spawned[0]!['maxBudgetUsd']).toBe(12)
  })

  it('ignores a nonsensical ceiling rather than disabling the breaker', async () => {
    const { dispatcher, spawned } = fakeDispatcher({
      status: 'completed',
      result: { summary: 'done', output: { report_markdown: '# Report' } },
    })
    const tool = createResearchDispatchTool({
      dispatcher, projectDir: await projectDir(), sessionId: 's1',
    })

    await tool.call({ question: 'q', max_budget_usd: 0 }, ctx)
    expect(spawned[0]!['maxBudgetUsd']).toBe(DEFAULT_RESEARCH_BUDGET_USD)
  })
})

describe('a truncated report says so on the file itself', () => {
  it('banners the saved report with the real stop reason', async () => {
    // The shape a budget stop actually produces: no return_result, so no
    // structured output — only the trailing narration survives as `summary`.
    const { dispatcher } = fakeDispatcher({
      status: 'failed',
      result: {
        summary: 'I read two of the five papers and was still extracting…',
        error: 'Budget exceeded ($0.50 limit)',
      },
    })
    const dir = await projectDir()
    const tool = createResearchDispatchTool({ dispatcher, projectDir: dir, sessionId: 's1' })

    const result = await tool.call({ question: 'reward terms' }, ctx)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('PARTIAL')

    // ResearchStore reports a PROJECT-RELATIVE path (that is what the model
    // read_file's), so resolve it against the project dir.
    const reportPath = /Report saved: (.+)/.exec(result.content as string)?.[1]!.trim()
    const saved = await readFile(join(dir, reportPath!), 'utf-8')
    // The report outlives the tool result — it is re-read sessions later by a
    // model with no memory of this call, so the warning must be IN it.
    expect(saved).toContain('INCOMPLETE')
    expect(saved).toContain('Budget exceeded ($0.50 limit)')
    expect(saved).toContain('I read two of the five papers')
  })

  it('leaves a completed report unbannered', async () => {
    const { dispatcher } = fakeDispatcher({
      status: 'completed',
      result: { summary: 'done', output: { report_markdown: '# Report\nfull text', conclusion: 'c' } },
    })
    const dir = await projectDir()
    const tool = createResearchDispatchTool({ dispatcher, projectDir: dir, sessionId: 's1' })

    const result = await tool.call({ question: 'q' }, ctx)
    const reportPath = /Report saved: (.+)/.exec(result.content as string)?.[1]!.trim()
    const saved = await readFile(join(dir, reportPath!), 'utf-8')
    expect(saved).not.toContain('INCOMPLETE')
    expect(saved).toContain('full text')
  })
})
