import { resolve } from 'node:path'
import { detectWsl, isWindowsBackedPath, type WslKind } from '../infra/platform/wsl.js'

export interface WslPathUnderTest {
  /** Human label shown in the warning, e.g. "workspace". */
  label: string
  path: string
}

export interface WslWarningOptions {
  paths?: WslPathUnderTest[]
  env?: NodeJS.ProcessEnv
  detect?: () => WslKind
  isWindowsBacked?: (path: string) => boolean
}

/**
 * Return the WSL warning shown when meta-agent state lives on a Windows-side
 * volume (`/mnt/c/...`) instead of the distro's own filesystem.
 *
 * This is advisory but load-bearing: the durable Loop runtime relies on
 * `link()`, atomic `rename()` and usable `mtime` granularity, and the 9p/DrvFs
 * transport that backs `/mnt/<drive>` provides none of the three reliably.
 * See infra/platform/wsl.ts for the full rationale.
 *
 * Returns null when not running under WSL, when nothing is Windows-backed, or
 * when suppressed via `META_AGENT_SUPPRESS_WSL_WARNING=1`.
 */
export function getWslFilesystemWarning(options: WslWarningOptions = {}): string | null {
  const detect = options.detect ?? detectWsl
  const kind = detect()
  if (kind === null) return null

  const env = options.env ?? process.env
  if (env['META_AGENT_SUPPRESS_WSL_WARNING'] === '1') return null

  const isWindowsBacked = options.isWindowsBacked ?? isWindowsBackedPath
  const affected = (options.paths ?? []).filter(item => item.path && isWindowsBacked(item.path))
  if (!affected.length) return null

  const bullets = affected.map(item => `  - ${item.label}: ${resolve(item.path)}`)

  return [
    `[meta-agent] ${kind === 'wsl2' ? 'WSL2' : 'WSL1'} detected, but meta-agent state lives on a Windows drive:`,
    ...bullets,
    'Windows drives are proxied into WSL over 9p/DrvFs, where link() can fail, rename() is not reliably',
    'atomic, and mtime is coarse. The durable Loop runtime depends on all three: the scheduler lock',
    '(.loop/daemon.lock), withFileLock, and WakeStore staleness can all misbehave — up to two schedulers',
    'running against one workspace, or a scheduler that never starts.',
    'Move the workspace inside the distro filesystem (e.g. ~/code/<project>) and keep $META_AGENT_HOME',
    'on ~ as well. Access the files from Windows via \\\\wsl$\\<distro>\\home\\<user>\\... when needed.',
    'Suppress this warning with META_AGENT_SUPPRESS_WSL_WARNING=1 if you accept the risk.',
  ].join('\n')
}
