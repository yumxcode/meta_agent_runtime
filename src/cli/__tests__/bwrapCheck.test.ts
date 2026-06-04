import { describe, expect, it } from 'vitest'
import { getMissingBwrapWarning } from '../bwrapCheck.js'

describe('getMissingBwrapWarning', () => {
  it('does not warn on non-Linux platforms', () => {
    const warning = getMissingBwrapWarning({
      platform: 'darwin',
      isAvailable: () => false,
    })
    expect(warning).toBeNull()
  })

  it('does not warn when bwrap is available', () => {
    const warning = getMissingBwrapWarning({
      platform: 'linux',
      isAvailable: () => true,
    })
    expect(warning).toBeNull()
  })

  it('warns on Linux when bwrap is missing', () => {
    const warning = getMissingBwrapWarning({
      platform: 'linux',
      isAvailable: () => false,
    })
    expect(warning).toContain('bubblewrap')
    expect(warning).toContain('sudo apt update && sudo apt install -y bubblewrap')
  })

  it('can be suppressed by environment variable', () => {
    const warning = getMissingBwrapWarning({
      platform: 'linux',
      env: { META_AGENT_SUPPRESS_BWRAP_WARNING: '1' },
      isAvailable: () => false,
    })
    expect(warning).toBeNull()
  })
})
