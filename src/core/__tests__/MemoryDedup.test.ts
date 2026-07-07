/**
 * <memory> block hygiene — the index must never be recalled as a topic file
 * (case-insensitive filesystems!), recalled files must be deduped, and YAML
 * frontmatter must be stripped (header line already carries name/date).
 */
import { describe, it, expect } from 'vitest'
import {
  buildVolatileContextSections,
  stripMemoryFrontmatter,
  filterRecalledIndexBullets,
} from '../dynamicPrompt.js'

describe('stripMemoryFrontmatter', () => {
  it('removes the YAML frontmatter block, keeps the body', () => {
    const raw = [
      '---',
      'name: 算法开发先搜论文再写代码',
      'description: 先 paper_search 再编码',
      'type: feedback',
      'date: 2026-06-03',
      'scope: domain',
      'domain: generic',
      '---',
      '',
      '**规则:** 先调用 paper_search 搜索最新论文。',
    ].join('\n')
    const out = stripMemoryFrontmatter(raw)
    expect(out).toBe('**规则:** 先调用 paper_search 搜索最新论文。')
    expect(out).not.toContain('name:')
    expect(out).not.toContain('---')
  })

  it('returns content unchanged when there is no frontmatter', () => {
    expect(stripMemoryFrontmatter('纯正文内容')).toBe('纯正文内容')
  })

  it('tolerates unterminated frontmatter', () => {
    const raw = '---\nname: x\n(no closing fence)'
    expect(stripMemoryFrontmatter(raw)).toBe(raw.trim())
  })
})

describe('filterRecalledIndexBullets（召回差集）', () => {
  const INDEX = [
    '- [算法开发先搜论文再写代码](mem_f2609a72.md) - 先 paper_search 再编码',
    '',
    '- [先读码算数再设计方案](mem_e83b8ddd.md) - 先读码再动手写',
    '',
    '- [Gradmotion 模板](gradmotion_task_create_skill.md) - 按 skill 最小模板',
  ].join('\n')

  it('removes bullets for recalled files, keeps the rest', () => {
    const out = filterRecalledIndexBullets(
      INDEX,
      new Set(['mem_e83b8ddd.md', 'gradmotion_task_create_skill.md']),
    )
    expect(out).toContain('mem_f2609a72.md')
    expect(out).not.toContain('mem_e83b8ddd.md')
    expect(out).not.toContain('gradmotion_task_create_skill.md')
    expect(out).not.toMatch(/\n{3,}/)
  })

  it('is case-insensitive on filenames and keeps non-bullet lines', () => {
    const withHeader = `# 标题\n${INDEX}`
    const out = filterRecalledIndexBullets(withHeader, new Set(['MEM_E83B8DDD.MD'.toLowerCase()]))
    expect(out).toContain('# 标题')
    expect(out).not.toContain('mem_e83b8ddd.md')
  })

  it('returns the index unchanged when nothing was recalled', () => {
    expect(filterRecalledIndexBullets(INDEX, new Set())).toBe(INDEX.trim())
  })

  it('returns empty string when ALL entries are recalled', () => {
    const out = filterRecalledIndexBullets(
      INDEX,
      new Set(['mem_f2609a72.md', 'mem_e83b8ddd.md', 'gradmotion_task_create_skill.md']),
    )
    expect(out).toBe('')
  })
})

describe('buildVolatileContextSections', () => {
  it('can skip memory recall for isolated sub-agents', () => {
    const sections = buildVolatileContextSections({
      currentQuery: 'sub-agent task',
      skipMemoryRecall: true,
    })
    expect(sections.map(s => s.name)).not.toContain('memory_content')
  })
})
