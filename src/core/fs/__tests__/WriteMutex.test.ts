import { describe, it, expect } from 'vitest'
import { PathWriteMutex, getGlobalWriteMutex } from '../WriteMutex.js'

describe('PathWriteMutex', () => {
  it('serialises concurrent acquirers of the SAME path (FIFO, no interleave)', async () => {
    const mtx = new PathWriteMutex()
    const order: string[] = []

    async function critical(label: string, holdMs: number) {
      const release = await mtx.acquire('/tmp/same.txt')
      order.push(`${label}:enter`)
      await new Promise((r) => setTimeout(r, holdMs))
      order.push(`${label}:exit`)
      release()
    }

    // Start A first; B and C queue behind it.
    const a = critical('A', 20)
    const b = critical('B', 5)
    const c = critical('C', 5)
    await Promise.all([a, b, c])

    // Each critical section must fully complete before the next begins.
    expect(order).toEqual([
      'A:enter', 'A:exit',
      'B:enter', 'B:exit',
      'C:enter', 'C:exit',
    ])
  })

  it('does NOT block acquirers of DIFFERENT paths (run in parallel)', async () => {
    const mtx = new PathWriteMutex()
    const events: string[] = []
    const relA = await mtx.acquire('/tmp/a.txt')
    // A different path must acquire immediately even while /tmp/a.txt is held.
    const relB = await mtx.acquire('/tmp/b.txt')
    events.push('both-held')
    relA()
    relB()
    expect(events).toEqual(['both-held'])
  })

  it('normalises paths so equivalent spellings share one lock', async () => {
    const mtx = new PathWriteMutex()
    const rel = await mtx.acquire('/tmp/x/../x/file.txt')
    let acquired = false
    const p = mtx.acquire('/tmp/x/file.txt').then((r) => { acquired = true; r() })
    await new Promise((r) => setTimeout(r, 10))
    expect(acquired).toBe(false) // blocked by the equivalent path
    rel()
    await p
    expect(acquired).toBe(true)
  })

  it('releases drop the chain entry so the map does not grow unbounded', async () => {
    const mtx = new PathWriteMutex()
    const r1 = await mtx.acquire('/tmp/one.txt')
    r1()
    const r2 = await mtx.acquire('/tmp/two.txt')
    r2()
    expect(mtx.activePathCount).toBe(0)
  })

  it('getGlobalWriteMutex returns a stable singleton', () => {
    expect(getGlobalWriteMutex()).toBe(getGlobalWriteMutex())
  })
})
