import { describe, expect, it } from 'vitest'

// v2.0 removed the path-based write guard entirely; teamWriteGuard.ts is a
// deprecation stub.  This placeholder keeps vitest happy with non-empty test
// files in the directory.
describe('teamWriteGuard.ts (deprecated)', () => {
  it('exports nothing', async () => {
    const mod = await import('../teamWriteGuard.js')
    expect(Object.keys(mod)).toEqual([])
  })
})
