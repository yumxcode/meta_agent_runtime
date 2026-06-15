/**
 * research_dispatch — handle-not-payload contract: persists the deliverable to
 * disk and returns only a conclusion + report path to the main agent.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createResearchDispatchTool } from '../research_dispatch/index.js'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord, SubAgentResult } from '../../../subagent/types.js'

function makeRecord(status: SubAgentRecord['status'], result?: Partial<SubAgentResult>): SubAgentRecord {
  return {
    schemaVersion: '1.0',
    taskId: 'task_research_1',
    parentSessionId: 'parent',
    status,
    config: { taskDescription: 'x' } as SubAgentRecord['config'],
    createdAt: Date.now(),
    ...(result
      ? {
          result: {
            success: status === 'completed',
            summary: 'fallback summary',
            turnsUsed: 3, inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 10,
            ...result,
          },
        }
      : {}),
  }
}

function stubDispatcher(final: SubAgentRecord): ISubAgentDispatcher {
  return {
    async spawnSubAgent() { return makeRecord('completed') },  // terminal at once → no polling
    async getStatus() { return final },
    async cancelTask() { return false },
  }
}

const ctx = { abortSignal: new AbortController().signal } as never

describe('research_dispatch', () => {
  it('persists the deliverable and returns a small handle (never the full report)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'research-tool-'))
    try {
      const bigReport = '## Key Findings\n' + 'reward term table…\n'.repeat(500) // ~10k chars
      const tool = createResearchDispatchTool({
        dispatcher: stubDispatcher(makeRecord('completed', {
          output: {
            conclusion: '最小奖励设计收敛于 4-6 项',
            report_markdown: bigReport,
            sources_markdown: '- arXiv:2404.19173',
            papers_covered: 11,
          },
        })),
        projectDir: dir,
        sessionId: 'sess-1',
      })

      const res = await tool.call({ question: '最小奖励设计', extraction_spec: '奖励项+权重' }, ctx)
      expect(res.isError).toBe(false)
      const content = String(res.content)
      // Handle contents
      expect(content).toContain('最小奖励设计收敛于 4-6 项')
      expect(content).toContain(join('.meta-agent', 'research', 'task_research_1', 'report.md'))
      expect(content).toContain('Do NOT re-run')
      // Payload isolation: the full report must NOT be in the tool result
      expect(content.length).toBeLessThan(2_000)
      expect(content).not.toContain('reward term table…')
      // Deliverable on disk, verbatim
      const saved = await readFile(join(dir, '.meta-agent', 'research', 'task_research_1', 'report.md'), 'utf-8')
      expect(saved).toBe(bigReport.trim())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists PARTIAL deliverables on failure and says how to continue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'research-tool-'))
    try {
      const tool = createResearchDispatchTool({
        dispatcher: stubDispatcher(makeRecord('failed', {
          error: 'Sub-agent exceeded 600000ms wall-clock limit',
          output: { conclusion: '覆盖 6/11 篇', report_markdown: '## 部分结果…', papers_covered: 6 },
        })),
        projectDir: dir,
        sessionId: 'sess-1',
      })
      const res = await tool.call({ question: 'q' }, ctx)
      expect(res.isError).toBe(false)
      expect(String(res.content)).toContain('PARTIAL')
      expect(String(res.content)).toContain('NEW research_dispatch scoped to')
      const saved = await readFile(join(dir, '.meta-agent', 'research', 'task_research_1', 'report.md'), 'utf-8')
      expect(saved).toContain('部分结果')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('errors cleanly when no deliverable came back at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'research-tool-'))
    try {
      const tool = createResearchDispatchTool({
        dispatcher: stubDispatcher(makeRecord('failed', { summary: '', error: 'boom' })),
        projectDir: dir,
        sessionId: 'sess-1',
      })
      const res = await tool.call({ question: 'q' }, ctx)
      expect(res.isError).toBe(true)
      expect(String(res.content)).toContain('boom')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
