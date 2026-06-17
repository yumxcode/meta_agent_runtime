import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveVersion, CLI_VERSION } from '../version.js'

/**
 * Guards against the version drift the review flagged: the CLI version and
 * package.json version must always agree, so `meta-agent --version` can never
 * report a stale number again.
 */
describe('CLI version', () => {
  it('matches the version in package.json', () => {
    // Walk up to the package root (this test lives at src/cli/__tests__/).
    let dir = dirname(fileURLToPath(import.meta.url))
    let pkgVersion: string | undefined
    for (let i = 0; i < 8; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          name?: string
          version?: string
        }
        if (pkg?.name === '@meta-agent/runtime') {
          pkgVersion = pkg.version
          break
        }
      } catch {
        /* not here — keep walking */
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }

    expect(pkgVersion).toBeDefined()
    expect(resolveVersion()).toBe(pkgVersion)
    expect(CLI_VERSION).toBe(pkgVersion)
  })
})
