/**
 * Regression: FileStateCache must be a true LRU — re-recording an existing
 * path refreshes its recency. (Map.set on an existing key keeps the original
 * insertion position, which previously made eviction FIFO: hot files that
 * were re-read constantly could be evicted before cold ones.)
 */
import { describe, it, expect } from 'vitest'
import { FileStateCache } from '../session/FileStateCache.js'

describe('FileStateCache LRU semantics', () => {
  it('re-recording a path refreshes its recency', () => {
    const cache = new FileStateCache(3)
    cache.record('/a', 1)
    cache.record('/b', 1)
    cache.record('/c', 1)

    // Touch /a — it is now the most recently used entry.
    cache.record('/a', 2)

    // Inserting /d must evict /b (the least recently used), NOT /a.
    cache.record('/d', 1)
    expect(cache.has('/a')).toBe(true)
    expect(cache.has('/b')).toBe(false)
    expect(cache.has('/c')).toBe(true)
    expect(cache.has('/d')).toBe(true)
    expect(cache.size()).toBe(3)
  })

  it('evicts in least-recently-recorded order under sustained pressure', () => {
    const cache = new FileStateCache(2)
    cache.record('/hot', 1)
    cache.record('/cold1', 1)
    cache.record('/hot', 1)   // refresh
    cache.record('/cold2', 1) // evicts /cold1
    expect(cache.has('/hot')).toBe(true)
    expect(cache.has('/cold1')).toBe(false)
    expect(cache.has('/cold2')).toBe(true)
  })
})
