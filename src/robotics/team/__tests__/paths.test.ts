import { describe, expect, it } from 'vitest'

// paths.ts is a deprecation stub in v2.0; the real coverage lives in
// TeamStore.exclusivity.test.ts and schemas.test.ts.  This placeholder
// keeps vitest happy with non-empty test files in the directory.
describe('paths.ts (deprecated)', () => {
  it('exports nothing', async () => {
    const mod = await import('../paths.js')
    expect(Object.keys(mod)).toEqual([])
  })
})
