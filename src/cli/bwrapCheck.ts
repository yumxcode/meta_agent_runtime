import { isBwrapAvailable } from '../sandbox/detect.js'

export interface BwrapWarningOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  isAvailable?: () => boolean
}

/**
 * Return the Linux CLI warning shown when bubblewrap is missing.
 *
 * This is intentionally advisory: the runtime may still run without bwrap
 * because the default main-agent bash sandbox allows unsandboxed fallback.
 */
export function getMissingBwrapWarning(options: BwrapWarningOptions = {}): string | null {
  const platform = options.platform ?? process.platform
  if (platform !== 'linux') return null

  const env = options.env ?? process.env
  if (env['META_AGENT_SUPPRESS_BWRAP_WARNING'] === '1') return null

  const available = options.isAvailable ?? isBwrapAvailable
  if (available()) return null

  return [
    '[meta-agent] Linux sandbox dependency missing: bubblewrap (bwrap) was not found.',
    'Bash tools can still run, but OS-level sandboxing will fall back to unsandboxed execution unless a strict sandbox policy is used.',
    'Install on Ubuntu/Debian: sudo apt update && sudo apt install -y bubblewrap',
  ].join('\n')
}
