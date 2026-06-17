/**
 * Single source of truth for the CLI version.
 *
 * Read from the package's own package.json at runtime so `meta-agent --version`
 * can never drift from the published version (a hardcoded constant shipped
 * 0.2.10 long after package.json moved to 0.3.0).
 */
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Walk up from this module to the nearest package.json whose name matches this
 * package — works for every layout: the bundled dist/cli.mjs, the tsc lib build
 * under dist/cli/, and source runs via tsx/vitest under src/cli/.
 */
export function resolveVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, 'package.json')
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
        if (pkg?.name === '@meta-agent/runtime' && pkg.version) return pkg.version
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // fall through to the safe default
  }
  return '0.0.0'
}

export const CLI_VERSION: string = resolveVersion()
