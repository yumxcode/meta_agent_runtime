/**
 * ResearchStore — disk persistence + registry + compact anchor rendering.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ResearchStore, buildResearchArtifactAnchors } from '../ResearchStore.js'

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'research-'))
  try { await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

describe('ResearchStore', () => {
  it('persists report + sources and registers an index entry with relative paths', async () => {
    await withTmp(async dir => {
      const store = new ResearchStore(dir)
      const entry = await store.saveResult({
        taskId: 'task_abc',
        question: '最小奖励设计有哪些做法？',
        status: 'success',
        conclusion: '收敛于 4-6 项核心奖励',
        reportMarkdown: '## Key Findings\nalive bonus + velocity tracking…',
        sourcesMarkdown: '- arXiv:2404.19173',
        papersCovered: 11,
        sessionId: 'sess-1',
      })

      expect(entry.reportPath).toBe(join('.meta-agent', 'research', 'task_abc', 'report.md'))
      const report = await readFile(join(dir, entry.reportPath), 'utf-8')
      expect(report).toContain('alive bonus')
      const sources = await readFile(join(dir, entry.sourcesPath!), 'utf-8')
      expect(sources).toContain('2404.19173')

      const listed = await store.list()
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({ taskId: 'task_abc', status: 'success', papersCovered: 11 })
    })
  })

  it('listSync returns newest-first and same-taskId entries are upserted', async () => {
    await withTmp(async dir => {
      const store = new ResearchStore(dir)
      const base = {
        status: 'success' as const, conclusion: 'c', reportMarkdown: 'r', sessionId: 's',
      }
      await store.saveResult({ ...base, taskId: 't1', question: 'q1' })
      await store.saveResult({ ...base, taskId: 't2', question: 'q2' })
      await store.saveResult({ ...base, taskId: 't1', question: 'q1-updated' })

      const sync = ResearchStore.listSync(dir)
      expect(sync.map(e => e.taskId)).toEqual(['t1', 't2'])  // newest first, t1 upserted
      expect(sync[0]!.question).toBe('q1-updated')
    })
  })

  it('buildResearchArtifactAnchors renders re-READ guidance; null when empty', async () => {
    await withTmp(async dir => {
      expect(buildResearchArtifactAnchors(dir)).toBeNull()
      expect(buildResearchArtifactAnchors(undefined)).toBeNull()

      const store = new ResearchStore(dir)
      await store.saveResult({
        taskId: 't9', question: '奖励函数对比', status: 'partial',
        conclusion: '已覆盖 6/11 篇', reportMarkdown: 'r', sessionId: 's', papersCovered: 6,
      })
      const anchors = buildResearchArtifactAnchors(dir)!
      expect(anchors).toContain('Persisted Research Reports')
      expect(anchors).toContain('re-READ')
      expect(anchors).toContain('[partial] 奖励函数对比 · 6 sources')
      expect(anchors).toContain(`read_file ${join('.meta-agent', 'research', 't9', 'report.md')}`)
      expect(anchors).toContain('Do NOT re-run the research')
    })
  })
})
