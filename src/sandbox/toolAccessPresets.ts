/**
 * toolAccessPresets — the knowledge base behind `sandbox.toolAccess`.
 *
 * An operator who wants `gh` to work inside a sandboxed session should not have
 * to know that it needs `~/.config/gh` readable AND writable, `GH_TOKEN` past
 * the env filter, and network egress — three grants spread across two unrelated
 * config keys. `"toolAccess": ["gh"]` says the intent; this table says what the
 * intent expands to.
 *
 * These presets are DATA, not policy. What they produce is fed through the exact
 * same `resolveSandboxPolicy` → `applySandboxPolicy` path as a hand-written
 * `writeAllowPaths` entry, so nothing here can bypass a check that a manual
 * grant would have to pass. In particular:
 *
 *   - `EXPLICIT_ENV_BLOCKLIST` still wins (see `isBlockedEnvName`); a preset
 *     naming a blocklisted variable has that ONE name dropped and reported.
 *   - `network: 'unrestricted'` is a REQUIREMENT ("this tool needs the net"),
 *     not an override. `applySandboxPolicy` keeps `'none'` sticky from either
 *     side, so a tool or operator that said `none` still wins.
 *   - Autonomous modes narrow the table further (see AUTONOMOUS_RESTRICTED).
 *
 * Paths are kept in their `~/…` form. Expansion and existence filtering happen
 * in sandboxPolicyConfig, which owns `expandHostPath` — keeping it there avoids
 * an import cycle and keeps ONE definition of "how a configured path is read".
 */

import { isBlockedEnvName } from '../infra/env/childProcessEnv.js'

export const TOOL_ACCESS_NAMES = [
  'gh', 'git', 'docker', 'kubectl', 'aws', 'npm', 'keychain',
] as const
export type ToolAccessName = (typeof TOOL_ACCESS_NAMES)[number]

export interface ToolAccessPreset {
  /** Readable outside the workspace. */
  read?: readonly string[]
  /**
   * Readable AND writable. Only for paths the tool genuinely writes back to —
   * `gh` rewrites hosts.yml and its cache, `git` does not rewrite user config.
   * Narrow first; widening later is a one-line change, narrowing is a breakage.
   */
  write?: readonly string[]
  /**
   * Environment variables the tool reads. Names that do not match
   * SENSITIVE_ENV_PATTERN already pass the 'filtered' policy on their own; they
   * are listed anyway so `sandbox_probe` can show the operator the full set the
   * tool actually consults, rather than only the subset that needed rescuing.
   */
  env?: readonly string[]
  network?: 'unrestricted'
  /** Shown by sandbox_probe to explain why these grants exist. */
  rationale: string
}

export const TOOL_ACCESS_PRESETS: Record<ToolAccessName, ToolAccessPreset> = {
  gh: {
    read: ['~/.config/gh'],
    write: ['~/.config/gh'],
    env: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR', 'GH_ENTERPRISE_TOKEN', 'GH_REPO'],
    network: 'unrestricted',
    rationale:
      'gh reads hosts.yml from ~/.config/gh and writes back tokens/cache there; ' +
      'all subcommands beyond --help reach api.github.com.',
  },

  git: {
    read: ['~/.gitconfig', '~/.config/git'],
    // No write: git does not rewrite user-level config during ordinary use, and
    // `git config --global` is exactly the operation we do not want a sandboxed
    // session performing implicitly.
    env: [
      'GIT_TOKEN', 'GITLAB_TOKEN',
      'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
      'GIT_SSH_COMMAND', 'SSH_AUTH_SOCK',
    ],
    network: 'unrestricted',
    rationale:
      'git reads user identity and http/ssh settings from ~/.gitconfig; ' +
      'remote operations need network egress.',
  },

  docker: {
    read: ['~/.docker/config.json'],
    env: ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'],
    network: 'unrestricted',
    rationale:
      'docker reads registry auth from ~/.docker/config.json. NOTE: DOCKER_HOST ' +
      'can point at a remote daemon, which is equivalent to root on that host — ' +
      'this is why the preset is restricted in autonomous modes.',
  },

  kubectl: {
    read: ['~/.kube/config'],
    write: ['~/.kube/cache'],
    env: ['KUBECONFIG', 'KUBE_CONTEXT'],
    network: 'unrestricted',
    rationale:
      'kubectl reads cluster credentials from ~/.kube/config and writes a ' +
      'discovery cache. Effects are cluster-wide, not workspace-scoped.',
  },

  aws: {
    read: ['~/.aws'],
    write: ['~/.aws/cli/cache'],
    env: [
      'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
      'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
    ],
    network: 'unrestricted',
    rationale:
      'aws reads long-lived credentials from ~/.aws. AWS_ACCESS_KEY_ID and ' +
      'AWS_SECRET_ACCESS_KEY are deliberately NOT listed: they are on the ' +
      'explicit blocklist and no operator config may forward them.',
  },

  /**
   * The OS credential store itself, not any one tool.
   *
   * WHY IT IS SEPARATE FROM `gh`: on macOS, `gh auth login` stores its token in
   * the login keychain rather than in hosts.yml ("keyring" mode). A sandboxed
   * `gh` then reads hosts.yml successfully, finds no oauth_token, and falls
   * back to anonymous — so granting `~/.config/gh` alone produces a session
   * that looks configured and still gets 401 on every write. `~/Library/
   * Keychains` is in DEFAULT_CREDENTIAL_DENY_PATHS, which is what blocks it.
   *
   * This is the ONLY way to reach a keyring-stored credential from config
   * alone. The alternative — exporting GH_TOKEN into the launching shell —
   * forwards a bare token to every descendant of the session (see the residual
   * risk note on GIT_CREDENTIAL_ALLOWLIST). This preset is arguably the safer
   * of the two: the token stays in the keychain, and securityd still enforces
   * per-item ACLs on top of this filesystem grant.
   *
   * But it is also the widest grant in this table. The login keychain holds
   * every secret the user has ever saved, not just a GitHub token, which is
   * why it is separately named (so `sandbox_probe` can show it as its own
   * line) and why it is restricted under autonomous modes.
   *
   * No `env`: the entire point is that no credential passes through the
   * environment. No `network`: the keychain is local.
   */
  keychain: {
    read: ['~/Library/Keychains'],
    rationale:
      'macOS login keychain, for tools that store credentials there instead of ' +
      'in a dotfile (gh in keyring mode, git-credential-osxkeychain). Grants the ' +
      'whole keychain database, not one entry — securityd still applies per-item ACLs.',
  },

  npm: {
    read: ['~/.npmrc'],
    write: ['~/.npm/_cacache'],
    // NPM_TOKEN is listed on purpose even though it is blocklisted: expansion
    // drops it and reports the drop, which tells the operator WHY their npm
    // auth still does not work. Silently omitting it would recreate exactly the
    // "configured but nothing happened" failure this feature exists to kill.
    env: ['NPM_TOKEN', 'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_USERCONFIG'],
    network: 'unrestricted',
    rationale:
      'npm reads registry + auth config from ~/.npmrc and writes a content cache.',
  },
}

/**
 * Presets denied by default under `auto` / `simple_auto`.
 *
 * Same rationale as AUTO_DENIED_TOOL_NAMES in core/modes.ts: their effects
 * cannot be proven to stay inside the workspace. A remote docker daemon, a
 * kube cluster, a set of long-lived AWS keys and the OS keychain are all host-
 * or fleet-level blast radius, and an unattended run has nobody to notice.
 *
 * `keychain` is here for reach rather than for blast radius: it is read-only
 * and securityd still gates each item, but it is the one grant that exposes
 * secrets belonging to applications that have nothing to do with this session.
 *
 * An operator who really wants them must repeat the name under
 * `sandbox.modes.<mode>.toolAccess` — a deliberate second act, not an
 * inherited default.
 */
export const AUTONOMOUS_RESTRICTED: readonly ToolAccessName[] = [
  'aws', 'docker', 'kubectl', 'keychain',
]

export type ToolAccessDropReason =
  | 'unknown-preset'
  | 'autonomous-restricted'
  | 'env-blocklisted'

export interface ToolAccessDrop {
  /** Preset name, or the offending env var for 'env-blocklisted'. */
  subject: string
  reason: ToolAccessDropReason
  detail: string
}

export interface ExpandedToolAccess {
  /** `~/…` forms; caller expands and existence-filters. */
  read: string[]
  write: string[]
  env: string[]
  network: 'unrestricted' | undefined
  granted: ToolAccessName[]
  dropped: ToolAccessDrop[]
}

export function isToolAccessName(value: string): value is ToolAccessName {
  return (TOOL_ACCESS_NAMES as readonly string[]).includes(value)
}

export interface ExpandToolAccessOptions {
  /** True for `auto` / `simple_auto`. */
  autonomous?: boolean
  /**
   * True when `names` came from `sandbox.modes.<mode>.toolAccess` rather than
   * being inherited from the top-level list. Only an explicit per-mode
   * declaration unlocks AUTONOMOUS_RESTRICTED presets.
   */
  explicitForMode?: boolean
}

/**
 * Expand preset names into the four grant categories.
 *
 * Never throws: an unusable entry is dropped and recorded. A config typo must
 * degrade to "this one grant did not apply, and here is why", never to a failed
 * session start — the operator is usually not watching when this resolves.
 */
export function expandToolAccess(
  names: readonly string[],
  options: ExpandToolAccessOptions = {},
): ExpandedToolAccess {
  const read: string[] = []
  const write: string[] = []
  const env: string[] = []
  const granted: ToolAccessName[] = []
  const dropped: ToolAccessDrop[] = []
  let network: 'unrestricted' | undefined

  const push = (into: string[], values: readonly string[] | undefined): void => {
    for (const v of values ?? []) if (!into.includes(v)) into.push(v)
  }

  for (const raw of names) {
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    if (!name) continue

    if (!isToolAccessName(name)) {
      dropped.push({
        subject: name,
        reason: 'unknown-preset',
        detail: `Unknown preset. Known: ${TOOL_ACCESS_NAMES.join(', ')}.`,
      })
      continue
    }

    if (
      options.autonomous &&
      AUTONOMOUS_RESTRICTED.includes(name) &&
      !options.explicitForMode
    ) {
      dropped.push({
        subject: name,
        reason: 'autonomous-restricted',
        detail:
          'Restricted under auto/simple_auto. Repeat it under ' +
          `sandbox.modes.<mode>.toolAccess to grant it deliberately.`,
      })
      continue
    }

    const preset = TOOL_ACCESS_PRESETS[name]
    granted.push(name)
    push(read, preset.read)
    push(write, preset.write)
    // Write implies read — a directory you may write but not read is useless,
    // and this mirrors the writeAllowPaths semantics documented in
    // sandboxPolicyConfig.
    push(read, preset.write)
    if (preset.network === 'unrestricted') network = 'unrestricted'

    for (const varName of preset.env ?? []) {
      if (isBlockedEnvName(varName)) {
        dropped.push({
          subject: varName,
          reason: 'env-blocklisted',
          detail:
            `Required by preset "${name}" but on the explicit credential ` +
            'blocklist, which no operator config may unlock.',
        })
        continue
      }
      if (!env.includes(varName)) env.push(varName)
    }
  }

  return { read, write, env, network, granted, dropped }
}
