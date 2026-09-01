/**
 * sandboxPolicyConfig — operator-controlled sandbox policy, read from the
 * layered `config.json` (`sandbox.*`).
 *
 * This is the ONLY place a host path outside the workspace can be granted. The
 * model cannot widen it, charter/campaign data cannot widen it, and a tool's
 * own `permission.sandbox` declaration cannot widen it — they may only require
 * a path the operator has already granted.
 *
 * Schema (`~/.meta-agent/config.json` or `<project>/.meta-agent/config.json`):
 *
 *   {
 *     "sandbox": {
 *       "toolAccess": ["gh", "git"],
 *       "envAllowlist": ["GH_ENTERPRISE_TOKEN"],
 *       "modes": { "auto": { "toolAccess": ["git"] } },
 *       "writeAllowPaths": ["~/scratch", "/data/shared"],
 *       "readAllowPaths":  ["~/datasets", "/opt/models"],
 *       "writeDenyPaths":  ["/data/shared/golden"],
 *       "readDenyPaths":   ["~/private-notes"],
 *       "network": "unrestricted",
 *       "protectCredentials": true,
 *       "allowUnsandboxedFallback": true
 *     }
 *   }
 *
 * Semantics
 * ---------
 *   toolAccess       Capability presets (see toolAccessPresets.ts). One name
 *                    expands into read/write/env/network grants, so an operator
 *                    states the INTENT ("gh should work") instead of rederiving
 *                    which three config keys that intent needs.
 *   envAllowlist     Extra env var names allowed past the 'filtered' policy.
 *                    Cannot unlock EXPLICIT_ENV_BLOCKLIST — see childProcessEnv.
 *   modes            Per-mode overrides. A field present under
 *                    `modes.<mode>` REPLACES the top-level field of the same
 *                    name for that mode; absent fields inherit. Overrides may
 *                    only widen within the autonomy floor — they can never
 *                    unlock `lockWorkspace` (that lives in PermissionPolicy and
 *                    reads no config).
 *   writeAllowPaths  Readable AND writable outside the workspace. Write implies
 *                    read: a directory you can write but not read is useless.
 *   readAllowPaths   Readable only. Use for datasets, model weights, reference
 *                    checkouts you must not modify.
 *   writeDenyPaths   Carved out of an allow (including the workspace itself).
 *   readDenyPaths    Carved out of an allow, on top of the credential defaults.
 *   network          'none' unshares the network namespace / denies all sockets.
 *   protectCredentials
 *                    Default TRUE. Adds DEFAULT_CREDENTIAL_DENY_PATHS to the
 *                    read-deny set. Set false only if you understand that the
 *                    sandboxed shell can then read ~/.ssh and ~/.aws and has
 *                    unrestricted network egress to send them somewhere.
 *   allowUnsandboxedFallback
 *                    Whether to degrade to plain `bash -c` on a host with no
 *                    sandbox backend. Auto modes force this to false regardless.
 *
 * Diagnostics
 * -----------
 * Every entry this resolver drops — a path that does not exist, an unknown
 * preset, a blocklisted env var, a credential default lifted by an explicit
 * grant — is recorded in `diagnostics`. Dropping is often correct; dropping
 * SILENTLY is what left operators unable to tell "my config never loaded" from
 * "my config loaded and the tool is still broken". `sandbox_probe` renders it.
 *
 * Precedence when a path appears in both an allow and a deny list: the OPERATOR'S
 * OWN allow wins over the credential DEFAULTS (that is the documented way to
 * say "yes, this agent really does need ~/.aws"), but an operator's explicit
 * deny always wins over an operator's allow.
 *
 * The grants resolved here feed TWO layers, and both are required for an
 * external path to actually work:
 *
 *   1. The OS sandbox (bwrap binds / Seatbelt rules) — enforcement.
 *   2. The kernel PermissionPolicy workspace jail — without this the command is
 *      denied for "references path outside workspace" long before the sandbox
 *      would have allowed it.
 */

import { existsSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, resolve, relative, sep } from 'path'
import { getValue as getConfigValue } from '../core/config/ConfigService.js'
import { expandToolAccess, type ToolAccessName } from './toolAccessPresets.js'
import { isBlockedEnvName } from '../infra/env/childProcessEnv.js'
import type { SandboxConfig } from './types.js'

/**
 * Credential stores hidden from the sandboxed shell by default.
 *
 * Rationale: both sandbox backends are write-oriented — Seatbelt starts from
 * `(allow default)` and bwrap does `--ro-bind / /`, so the entire host
 * filesystem is READABLE inside the sandbox and the network is unrestricted.
 * That combination plus untrusted content in the model's context (web_fetch,
 * MCP tool results) is a complete exfiltration path for long-lived credentials.
 * Blocking reads of the well-known credential directories closes the cheap
 * version of it without getting in the way of ordinary engineering work.
 *
 * `~/.gitconfig` is deliberately NOT here: git needs it, and it holds
 * configuration rather than secrets. `~/.git-credentials` (which does hold
 * secrets) IS here.
 */
export const DEFAULT_CREDENTIAL_DENY_PATHS: readonly string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.netrc',
  '~/.git-credentials',
  '~/.npmrc',
  '~/.docker/config.json',
  '~/.kube',
  '~/.config/gh',
  '~/.config/gcloud',
  '~/.config/op',
  '~/.azure',
  '~/.terraform.d/credentials.tfrc.json',
  '~/Library/Keychains',
]

export type SandboxDiagnosticKind =
  | 'dropped-path'
  | 'dropped-preset'
  | 'blocked-env'
  | 'credential-deny-lifted'
  | 'malformed-config'

export interface SandboxDiagnostic {
  kind: SandboxDiagnosticKind
  subject: string
  detail: string
}

export interface ResolvedSandboxPolicy {
  /** External roots that are readable and writable. */
  writeAllowPaths: string[]
  /** External roots that are readable only. */
  readAllowPaths: string[]
  writeDenyPaths: string[]
  readDenyPaths: string[]
  network: 'none' | 'unrestricted' | undefined
  allowUnsandboxedFallback: boolean | undefined
  /**
   * Every externally granted root (write ∪ read). This is the list the
   * PermissionPolicy jail widens by, and the list `runShellCommand` accepts as
   * a legal cwd.
   */
  allowedRoots: string[]
  /**
   * Env var names allowed past the 'filtered' child-env policy, from
   * `sandbox.envAllowlist` plus the `env` field of every granted preset.
   * Feeds `setEnvAllowlist`. Never contains a blocklisted name.
   */
  envAllowlist: string[]
  /** Presets that actually took effect, after autonomy narrowing. */
  toolAccess: ToolAccessName[]
  /** Everything dropped or lifted while resolving. Never a reason to fail. */
  diagnostics: SandboxDiagnostic[]
}

/** Expand `~`, resolve to absolute. Returns null for a non-absolute result. */
export function expandHostPath(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const home = homedir()
  let path = trimmed
  if (path === '~') path = home
  else if (path.startsWith('~/')) path = resolve(home, path.slice(2))
  if (!isAbsolute(path)) return null
  return resolve(path)
}

/**
 * Read `sandbox.<field>`, letting `sandbox.modes.<mode>.<field>` replace it.
 *
 * REPLACE, not merge: an operator writing `modes.auto.toolAccess: ["git"]` is
 * saying "under auto, only git" — silently unioning the top-level list back in
 * would grant exactly what they were trying to withhold. Absent fields inherit.
 */
function readSandboxField(
  field: string,
  projectDir: string | undefined,
  mode: string | undefined,
): { value: unknown; fromMode: boolean } {
  const opts = projectDir ? { projectDir } : {}
  if (mode) {
    try {
      const scoped = getConfigValue(`sandbox.modes.${mode}.${field}`, opts)
      if (scoped !== undefined) return { value: scoped, fromMode: true }
    } catch {
      /* fall through to the top-level field */
    }
  }
  try {
    return { value: getConfigValue(`sandbox.${field}`, opts), fromMode: false }
  } catch {
    return { value: undefined, fromMode: false }
  }
}

/** Coerce a config value to a string[]; anything else yields []. */
function asStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

function readPathList(
  field: string,
  projectDir: string | undefined,
  mode?: string,
): string[] {
  const { value } = readSandboxField(field, projectDir, mode)
  const out: string[] = []
  for (const entry of asStringList(value)) {
    const path = expandHostPath(entry)
    if (path && !out.includes(path)) out.push(path)
  }
  return out
}

/**
 * Existence-filter that records what it drops.
 *
 * Bind-mount sources must exist on the host (bwrap fails the whole command on a
 * missing `--bind` source), so dropping is the correct behaviour and is
 * unchanged. What is new is that the operator can now find out it happened.
 */
function filterExisting(
  paths: readonly string[],
  field: string,
  diagnostics: SandboxDiagnostic[],
): string[] {
  const kept: string[] = []
  for (const path of paths) {
    if (existsSync(path)) kept.push(path)
    else {
      diagnostics.push({
        kind: 'dropped-path',
        subject: path,
        detail: `sandbox.${field}: path does not exist on this host; grant ignored.`,
      })
    }
  }
  return kept
}

/** Segment-wise containment, so `/data/shared-backup` is not "under" `/data/shared`. */
function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Resolve the effective sandbox policy for a project.
 *
 * Bind-mount sources must exist on the host (bwrap fails the whole command on a
 * missing `--bind` source, and a `--tmpfs` over a missing path fails the same
 * way), so non-existent entries are dropped rather than left to blow up every
 * shell call. Dropping a non-existent DENY path is safe by definition: there is
 * nothing there to protect.
 */
export function resolveSandboxPolicy(
  projectDir?: string,
  mode?: string,
): ResolvedSandboxPolicy {
  const diagnostics: SandboxDiagnostic[] = []

  // ── toolAccess presets ──────────────────────────────────────────────────────
  // Expanded first so their paths join the allow lists BEFORE the credential
  // defaults are computed: every preset except `git` targets a directory in
  // DEFAULT_CREDENTIAL_DENY_PATHS (~/.config/gh, ~/.aws, ~/.kube, ~/.npmrc,
  // ~/.docker/config.json), and the "explicit grant lifts the default deny"
  // rule below is what makes `toolAccess: ["gh"]` actually work.
  const rawToolAccess = readSandboxField('toolAccess', projectDir, mode)
  const expanded = expandToolAccess(asStringList(rawToolAccess.value), {
    autonomous: mode === 'auto' || mode === 'simple_auto',
    explicitForMode: rawToolAccess.fromMode,
  })
  for (const drop of expanded.dropped) {
    diagnostics.push({
      kind: drop.reason === 'env-blocklisted' ? 'blocked-env' : 'dropped-preset',
      subject: drop.subject,
      detail: drop.detail,
    })
  }

  const presetRead = expanded.read
    .map(expandHostPath)
    .filter((p): p is string => p !== null)
  const presetWrite = expanded.write
    .map(expandHostPath)
    .filter((p): p is string => p !== null)

  const writeAllow = filterExisting(
    [...new Set([...readPathList('writeAllowPaths', projectDir, mode), ...presetWrite])],
    'writeAllowPaths', diagnostics,
  )
  const readAllow = filterExisting(
    [...new Set([...readPathList('readAllowPaths', projectDir, mode), ...presetRead])],
    'readAllowPaths', diagnostics,
  )
  const writeDeny = filterExisting(
    readPathList('writeDenyPaths', projectDir, mode), 'writeDenyPaths', diagnostics,
  )
  const explicitReadDeny = filterExisting(
    readPathList('readDenyPaths', projectDir, mode), 'readDenyPaths', diagnostics,
  )

  let protectCredentials = true
  let network: 'none' | 'unrestricted' | undefined
  let allowUnsandboxedFallback: boolean | undefined
  try {
    const rawProtect = readSandboxField('protectCredentials', projectDir, mode).value
    if (typeof rawProtect === 'boolean') protectCredentials = rawProtect
    const rawNetwork = readSandboxField('network', projectDir, mode).value
    if (rawNetwork === 'none' || rawNetwork === 'unrestricted') network = rawNetwork
    const rawFallback = readSandboxField('allowUnsandboxedFallback', projectDir, mode).value
    if (typeof rawFallback === 'boolean') allowUnsandboxedFallback = rawFallback
  } catch {
    /* malformed config — fall back to the safe defaults above */
  }

  // A preset declaring `network: 'unrestricted'` states a REQUIREMENT, it does
  // not override an operator or tool that asked for 'none' (applySandboxPolicy
  // keeps 'none' sticky). Record the conflict so "I enabled toolAccess:gh but
  // it still cannot reach the network" is answerable.
  if (expanded.network === 'unrestricted') {
    if (network === 'none') {
      diagnostics.push({
        kind: 'malformed-config',
        subject: 'network',
        detail:
          `toolAccess [${expanded.granted.join(', ')}] needs network egress, but ` +
          "sandbox.network is 'none'. 'none' wins; these tools will fail to reach the network.",
      })
    } else if (network === undefined) {
      network = 'unrestricted'
    }
  }

  // Credential defaults are a FLOOR, not a ceiling: an operator who explicitly
  // grants ~/.aws in readAllowPaths has opted in, so that grant is honoured and
  // the corresponding default deny is dropped. An explicit readDenyPaths entry
  // is never dropped.
  const credentialDeny: string[] = []
  if (protectCredentials) {
    for (const raw of DEFAULT_CREDENTIAL_DENY_PATHS) {
      const denied = expandHostPath(raw)
      if (denied === null || !existsSync(denied)) continue
      const granted = [...writeAllow, ...readAllow].find(
        g => isUnder(denied, g) || isUnder(g, denied),
      )
      if (granted === undefined) {
        credentialDeny.push(denied)
        continue
      }
      diagnostics.push({
        kind: 'credential-deny-lifted',
        subject: denied,
        detail:
          `Default credential protection removed because "${granted}" was ` +
          'explicitly granted (toolAccess preset or writeAllow/readAllowPaths). ' +
          'The sandboxed shell can now read it.',
      })
    }
  }

  const readDeny = [...new Set([...credentialDeny, ...explicitReadDeny])]
  const allowedRoots = [...new Set([...writeAllow, ...readAllow])]

  // Operator escape hatch, unioned with the preset env sets. Blocklisted names
  // are stripped here as well as in childProcessEnv — belt and braces, and it
  // keeps `policy.envAllowlist` honest for anything that reads it directly.
  const envAllowlist: string[] = []
  for (const name of [
    ...asStringList(readSandboxField('envAllowlist', projectDir, mode).value),
    ...expanded.env,
  ]) {
    if (isBlockedEnvName(name)) {
      diagnostics.push({
        kind: 'blocked-env',
        subject: name,
        detail:
          'On the explicit credential blocklist; no operator config may forward it. ' +
          'Pass it to one specific child via an mcp.json env entry instead.',
      })
      continue
    }
    if (!envAllowlist.includes(name)) envAllowlist.push(name)
  }

  return {
    writeAllowPaths: writeAllow,
    readAllowPaths: readAllow,
    writeDenyPaths: writeDeny,
    readDenyPaths: readDeny,
    network,
    allowUnsandboxedFallback,
    allowedRoots,
    envAllowlist,
    toolAccess: expanded.granted,
    diagnostics,
  }
}

/**
 * Merge the operator policy into a tool's declared SandboxConfig.
 *
 * Direction of the merge matters:
 *   - allow lists are UNIONED (the operator adds capability),
 *   - deny lists are UNIONED (either side may remove capability),
 *   - `network: 'none'` is sticky — if either side wants no network, there is
 *     no network. An operator cannot be silently downgraded by a tool
 *     declaration, and vice versa.
 */
export function applySandboxPolicy(
  base: SandboxConfig,
  policy: ResolvedSandboxPolicy,
): SandboxConfig {
  const union = (a: readonly string[] = [], b: readonly string[] = []): string[] | undefined => {
    const merged = [...new Set([...a, ...b])]
    return merged.length ? merged : undefined
  }
  const merged: SandboxConfig = { ...base }

  const writeAllow = union(base.writeAllowPaths, policy.writeAllowPaths)
  if (writeAllow) merged.writeAllowPaths = writeAllow
  // Read-only grants are not writable, so they are NOT folded into
  // writeAllowPaths. They matter to the backends only on Linux, where the
  // `--ro-bind / /` base already exposes them; the field is carried through so
  // a future backend with a deny-by-default read model has what it needs, and
  // so read-deny carve-outs can be reconciled against it.
  const readAllow = union(base.readAllowPaths, policy.readAllowPaths)
  if (readAllow) merged.readAllowPaths = readAllow

  const writeDeny = union(base.writeDenyPaths, policy.writeDenyPaths)
  if (writeDeny) merged.writeDenyPaths = writeDeny

  const readDeny = union(base.readDenyPaths, policy.readDenyPaths)
  if (readDeny) merged.readDenyPaths = readDeny

  if (base.network === 'none' || policy.network === 'none') merged.network = 'none'
  else if (policy.network) merged.network = policy.network

  if (policy.allowUnsandboxedFallback !== undefined) {
    merged.allowUnsandboxedFallback = policy.allowUnsandboxedFallback
  }
  return merged
}

// ── Back-compat ───────────────────────────────────────────────────────────────

/**
 * Legacy accessor kept so existing call sites keep compiling.
 * Prefer `resolveSandboxPolicy().writeAllowPaths`.
 */
export function resolveConfiguredWriteAllowPaths(projectDir: string): string[] {
  return resolveSandboxPolicy(projectDir).writeAllowPaths
}

/** Expand an absolute/`~` requirement without checking whether it is granted. */
export function resolveHostPathRequirement(value: string): string {
  return expandHostPath(value) ?? resolve(value.trim())
}
