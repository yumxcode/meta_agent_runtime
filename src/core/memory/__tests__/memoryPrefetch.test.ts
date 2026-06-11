import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findRelevantMemories,
  prefetchRelevantMemories,
  clearMemoryPrefetchCache,
  clearTopicScanCache,
  scanTopicFiles,
} from '../findRelevantMemories.js'

const tempDirs: string[] = []

async function tempMemoryDir(): Promise<string> {
  const dir = join(tmpdir(), `meta-agent-prefetch-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  clearMemoryPrefetchCache()
  clearTopicScanCache()
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

function userFile(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} profile\ntype: user\ndate: 2025-01-01\n---\n\n${name} content`
}

const settle = (ms = 200) => new Promise(r => setTimeout(r, ms))

describe('prefetchRelevantMemories (P0-1)', () => {
  it('consume-once: first call uses the prefetched snapshot, second call recomputes fresh', async () => {
    const dir = await tempMemoryDir()
    await writeFile(join(dir, 'a.md'), userFile('a'), 'utf-8')

    prefetchRelevantMemories({ query: 'hello world', memoryDir: dir })
    await settle()                                  // let the prefetch scan finish
    clearTopicScanCache()                           // isolate prefetch from scan cache
    await writeFile(join(dir, 'b.md'), userFile('b'), 'utf-8')

    // First consumer sees the prefetched snapshot (only a.md existed then).
    const first = await findRelevantMemories({ query: 'hello world', memoryDir: dir })
    expect(first.map(m => m.header.filename).sort()).toEqual(['a.md'])

    // Entry was consumed — second call computes fresh and sees both files.
    const second = await findRelevantMemories({ query: 'hello world', memoryDir: dir })
    expect(second.map(m => m.header.filename).sort()).toEqual(['a.md', 'b.md'])
  })

  it('compat mismatch: differing result-affecting options discard the prefetch', async () => {
    const dir = await tempMemoryDir()
    await writeFile(join(dir, 'a.md'), userFile('a'), 'utf-8')

    prefetchRelevantMemories({ query: 'q1', memoryDir: dir, maxCandidates: 5 })
    await settle()
    clearTopicScanCache()
    await writeFile(join(dir, 'b.md'), userFile('b'), 'utf-8')

    // maxCandidates differs → prefetch discarded → fresh scan sees both files.
    const result = await findRelevantMemories({ query: 'q1', memoryDir: dir, maxCandidates: 3 })
    expect(result.map(m => m.header.filename).sort()).toEqual(['a.md', 'b.md'])
  })

  it('sessionMode difference does NOT discard the prefetch (mode does not affect recall)', async () => {
    const dir = await tempMemoryDir()
    await writeFile(join(dir, 'a.md'), userFile('a'), 'utf-8')

    prefetchRelevantMemories({ query: 'q2', memoryDir: dir, sessionMode: undefined })
    await settle()
    clearTopicScanCache()
    await writeFile(join(dir, 'b.md'), userFile('b'), 'utf-8')

    // sessionMode differs but is excluded from the compat check by design.
    const result = await findRelevantMemories({ query: 'q2', memoryDir: dir, sessionMode: 'robotics' })
    expect(result.map(m => m.header.filename).sort()).toEqual(['a.md'])
  })

  it('prefetch is single-flight per (query, dir)', async () => {
    const dir = await tempMemoryDir()
    await writeFile(join(dir, 'a.md'), userFile('a'), 'utf-8')
    // Both calls race; neither throws and a later consume still works.
    prefetchRelevantMemories({ query: 'q3', memoryDir: dir })
    prefetchRelevantMemories({ query: 'q3', memoryDir: dir })
    const result = await findRelevantMemories({ query: 'q3', memoryDir: dir })
    expect(result.map(m => m.header.filename)).toEqual(['a.md'])
  })
})

describe('scanTopicFiles cache (P1-2)', () => {
  it('re-scans when the directory changes (new file invalidates via dir mtime)', async () => {
    const dir = await tempMemoryDir()
    await writeFile(join(dir, 'a.md'), userFile('a'), 'utf-8')

    const first = await scanTopicFiles(dir)
    expect(first.map(h => h.filename)).toEqual(['a.md'])

    await writeFile(join(dir, 'b.md'), userFile('b'), 'utf-8')
    const second = await scanTopicFiles(dir)
    expect(second.map(h => h.filename).sort()).toEqual(['a.md', 'b.md'])
  })
})
