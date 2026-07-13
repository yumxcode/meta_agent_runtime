import { existsSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import { getValue as getConfigValue } from '../core/config/ConfigService.js'

/**
 * Resolve operator-controlled writable host paths from the layered
 * `sandbox.writeAllowPaths` setting.  Charter data may REQUIRE one of these
 * paths, but can never grant a new host path by itself.
 */
export function resolveConfiguredWriteAllowPaths(projectDir: string): string[] {
  try {
    const raw = getConfigValue('sandbox.writeAllowPaths', { projectDir })
    if (!Array.isArray(raw)) return []
    const home = homedir()
    const out: string[] = []
    for (const entry of raw) {
      if (typeof entry !== 'string' || !entry.trim()) continue
      let path = entry.trim()
      if (path === '~') path = home
      else if (path.startsWith('~/')) path = home + path.slice(1)
      if (!isAbsolute(path)) continue
      path = resolve(path)
      if (!existsSync(path) || out.includes(path)) continue
      out.push(path)
    }
    return out
  } catch {
    return []
  }
}

/** Expand an absolute/~/ requirement without checking whether it is granted. */
export function resolveHostPathRequirement(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2))
  return resolve(trimmed)
}
