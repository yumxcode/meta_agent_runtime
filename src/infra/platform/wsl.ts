/**
 * WSL (Windows Subsystem for Linux) detection and filesystem-class probing.
 *
 * Why this exists
 * ───────────────
 * The supported way to run meta-agent on a Windows machine is inside WSL2,
 * where the whole runtime is an ordinary Linux deployment (bwrap sandbox
 * included). That works — with exactly one sharp edge:
 *
 *   Windows drives surfaced into the Linux VM (`/mnt/c/...`) are NOT a normal
 *   Linux filesystem. WSL2 proxies them over 9p (WSL1 used DrvFs), and on that
 *   transport `link()` may fail outright, `rename()` is not reliably atomic,
 *   and `mtime` granularity/monotonicity is coarse.
 *
 * Those three primitives are load-bearing for the durable Loop runtime:
 *
 *   - `link()`      → `acquireDaemonLock` in loop/daemon.ts uses link-into-place
 *                     for the create-if-absent lock. On 9p it can EPERM, so the
 *                     scheduler silently exits with `lock_held` forever.
 *   - `rename()`    → `atomicWriteJson` / `withFileLock` stale-claim in
 *                     infra/persist/index.ts. Non-atomic rename means a torn
 *                     instance.json or two holders of the same lock.
 *   - `mtime`       → lock freshness (`LOCK_FRESH_MS`) and `WakeStore` stale
 *                     reconciliation. Coarse timestamps make a live lock look
 *                     stale and vice versa.
 *
 * So a workspace (or `$META_AGENT_HOME`) sitting under `/mnt/<drive>` is a
 * correctness hazard, not a performance footnote. This module gives the CLI the
 * facts it needs to say so out loud; see cli/wslCheck.ts for the warning text.
 *
 * Everything here is injectable so it can be unit-tested off-WSL, and memoised
 * on the default (no-probe) path so repeated calls are O(1).
 */

import { readFileSync } from 'node:fs'
import { release as osRelease } from 'node:os'
import { resolve } from 'node:path'

export type WslKind = 'wsl1' | 'wsl2' | null

export interface MountEntry {
  mountPoint: string
  fsType: string
}

/**
 * Probe seams. Omit for real detection; supply in tests to simulate a host.
 * `readFile` must throw when the path is unreadable (matching readFileSync).
 */
export interface WslProbe {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  readFile?: (path: string) => string
  release?: () => string
}

/**
 * Filesystem types that are really a Windows-side volume proxied into Linux.
 *
 *   9p / virtiofs → WSL2 `/mnt/<drive>`
 *   drvfs         → WSL1 `/mnt/<drive>`
 *   cifs / smb*   → a network share; same non-atomic rename / no-hardlink story
 */
const WINDOWS_BACKED_FS = new Set([
  '9p', 'v9fs', 'virtiofs', 'drvfs', 'cifs', 'smbfs', 'smb3',
])

let _wslKind: WslKind | undefined
let _mounts: MountEntry[] | undefined

function defaultProbe(probe?: WslProbe): Required<WslProbe> {
  return {
    platform: probe?.platform ?? process.platform,
    env: probe?.env ?? process.env,
    readFile: probe?.readFile ?? ((path: string) => readFileSync(path, 'utf8')),
    release: probe?.release ?? osRelease,
  }
}

/**
 * Which WSL flavour we are running under, or null when this is not WSL.
 *
 * WSL2 is identified by the `-WSL2` kernel suffix or by `WSL_INTEROP` (which
 * only WSL2 sets). Anything else that still reports a Microsoft kernel is
 * treated as WSL1 — it has the same filesystem caveats, and more of them.
 */
export function detectWsl(probe?: WslProbe): WslKind {
  if (probe === undefined && _wslKind !== undefined) return _wslKind
  const p = defaultProbe(probe)

  const compute = (): WslKind => {
    if (p.platform !== 'linux') return null

    let procVersion = ''
    try { procVersion = p.readFile('/proc/version') } catch { /* not Linux-proc, fall through */ }

    const kernel = `${p.release()} ${procVersion}`
    const looksMicrosoft = /microsoft|wsl/i.test(kernel) || Boolean(p.env['WSL_DISTRO_NAME'])
    if (!looksMicrosoft) return null

    // WSL_INTEROP is WSL2-only; the kernel of a WSL2 distro is tagged -WSL2.
    if (/wsl2/i.test(kernel) || p.env['WSL_INTEROP']) return 'wsl2'
    return 'wsl1'
  }

  const kind = compute()
  if (probe === undefined) _wslKind = kind
  return kind
}

export function isWsl(probe?: WslProbe): boolean {
  return detectWsl(probe) !== null
}

/**
 * Undo the octal escaping the kernel applies to mount paths in /proc/mounts
 * (space → \040, tab → \011, newline → \012, backslash → \134).
 */
function unescapeMountPath(raw: string): string {
  return raw.replace(/\\(\d{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)))
}

/** Parse /proc/mounts into (mountPoint, fsType) pairs. Empty when unreadable. */
export function readMounts(probe?: WslProbe): MountEntry[] {
  if (probe === undefined && _mounts !== undefined) return _mounts
  const p = defaultProbe(probe)

  let entries: MountEntry[] = []
  try {
    entries = p.readFile('/proc/mounts')
      .split('\n')
      .map(line => line.split(/\s+/))
      // device mountPoint fsType options dump pass
      .filter(parts => parts.length >= 3 && parts[1] && parts[2])
      .map(parts => ({ mountPoint: unescapeMountPath(parts[1]!), fsType: parts[2]!.toLowerCase() }))
  } catch {
    entries = []
  }

  if (probe === undefined) _mounts = entries
  return entries
}

/**
 * Filesystem type backing `path`, by longest-prefix match against /proc/mounts.
 * Returns null when the mount table is unavailable (non-Linux, container without
 * /proc, …) — callers must treat null as "unknown", never as "safe".
 */
export function filesystemTypeOf(path: string, probe?: WslProbe): string | null {
  const mounts = readMounts(probe)
  if (!mounts.length) return null
  const target = resolve(path)

  let best: MountEntry | null = null
  for (const entry of mounts) {
    const isMatch = entry.mountPoint === '/'
      ? true
      : target === entry.mountPoint || target.startsWith(`${entry.mountPoint}/`)
    if (!isMatch) continue
    if (!best || entry.mountPoint.length > best.mountPoint.length) best = entry
  }
  return best?.fsType ?? null
}

/**
 * True when `path` lives on a Windows-side volume proxied into Linux
 * (`/mnt/c/...` and friends) rather than on the distro's own ext4.
 *
 * Falls back to the `/mnt/<single-letter>/` shape when the mount table cannot
 * be read, so detection still works in stripped-down environments.
 */
export function isWindowsBackedPath(path: string, probe?: WslProbe): boolean {
  const fsType = filesystemTypeOf(path, probe)
  if (fsType !== null) return WINDOWS_BACKED_FS.has(fsType)
  return /^\/mnt\/[a-z](\/|$)/i.test(resolve(path))
}

/** Test-only: drop memoised probe results. */
export function resetWslProbeCache(): void {
  _wslKind = undefined
  _mounts = undefined
}
