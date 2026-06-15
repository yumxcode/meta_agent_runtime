/**
 * Legacy MEMORY.md repair — a topic file named memory.md collided with the
 * entrypoint on case-insensitive filesystems, mashing entry + index into one
 * file. The repair extracts the entry to its own topic file and leaves a
 * bullets-only index.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { repairMemoryEntrypoint, resetMemoryRepairForTest } from '../memdir.js'

const MASHED = [
  '---',
  'name: 算法开发先搜论文再写代码',
  'description: 先 paper_search 再编码',
  'type: feedback',
  'date: 2026-06-03',
  '---',
  '',
  '**规则:** 先调用 paper_search 搜索最新论文，再进行代码实现。',
  '- [算法开发先搜论文再写代码](memory.md) - 先 paper_search 查最新论文',
  '',
  '- [先读码算数再设计方案](mem_e83b8ddd.md) - 先读码再动手写',
].join('\n')

describe('repairMemoryEntrypoint', () => {
  beforeEach(() => resetMemoryRepairForTest())

  it('extracts the embedded entry to a topic file and rewrites a bullets-only index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memrepair-'))
    try {
      const entrypoint = join(dir, 'MEMORY.md')
      await writeFile(entrypoint, MASHED, 'utf-8')

      const repaired = await repairMemoryEntrypoint(MASHED, entrypoint)

      // Returned index: bullets only, no frontmatter, no entry body
      expect(repaired).not.toContain('---')
      expect(repaired).not.toContain('**规则:**')
      expect(repaired).toContain('先读码算数再设计方案')
      // Self-link repointed away from memory.md
      expect(repaired).not.toContain('](memory.md)')
      expect(repaired).toMatch(/\]\(mem_[0-9a-f]{8}\.md\)/)

      // Entry persisted to its own topic file, content intact
      const newLink = repaired.match(/\((mem_[0-9a-f]{8}\.md)\)/)![1]!
      const topic = await readFile(join(dir, newLink), 'utf-8')
      expect(topic).toContain('name: 算法开发先搜论文再写代码')
      expect(topic).toContain('**规则:**')

      // Entrypoint rewritten on disk + backup kept
      expect(await readFile(entrypoint, 'utf-8')).toContain('先读码算数再设计方案')
      expect(await readFile(`${entrypoint}.bak`, 'utf-8')).toBe(MASHED)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves a healthy bullets-only index untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memrepair-'))
    try {
      const entrypoint = join(dir, 'MEMORY.md')
      const healthy = '- [规则A](a.md) - 描述A\n- [规则B](b.md) - 描述B'
      await writeFile(entrypoint, healthy, 'utf-8')
      expect(await repairMemoryEntrypoint(healthy, entrypoint)).toBe(healthy)
      expect(await readFile(entrypoint, 'utf-8')).toBe(healthy)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runs at most once per process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memrepair-'))
    try {
      const entrypoint = join(dir, 'MEMORY.md')
      await writeFile(entrypoint, MASHED, 'utf-8')
      await repairMemoryEntrypoint(MASHED, entrypoint)
      // Second call (without reset) is a no-op passthrough
      expect(await repairMemoryEntrypoint(MASHED, entrypoint)).toBe(MASHED)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
