/**
 * childProcessEnv — the single credential-hygiene policy for every child
 * process this runtime spawns.
 *
 * This logic used to live inside the bash tool, where it protected exactly one
 * spawn site. Meanwhile `StdioMcpClient` handed the FULL `process.env` — every
 * provider key, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY` — to an arbitrary
 * third-party binary named in `~/.meta-agent/mcp.json`. Two spawn sites, two
 * opposite policies, one of them silently undoing the other's stated goal
 * ("models cannot exfiltrate API keys via shell").
 *
 * So the policy lives here now and both call sites import it. Any new child
 * process should too.
 *
 * Policies:
 *   'inherit'  → forward process.env verbatim (opt-in, for trusted workflows)
 *   'filtered' → drop credential-bearing variables (DEFAULT)
 *   'empty'    → PATH / HOME / LANG and a handful of basics only
 */

/**
 * Suffix pattern for the "filtered" policy — strips anything whose NAME ends in
 * a credential-shaped word, so provider keys we've never heard of are covered
 * too.
 */
const SENSITIVE_ENV_PATTERN =
  /(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|SESSION_KEY|ACCESS_KEY|REFRESH_TOKEN|AUTH)$/i

/** Names that don't match the suffix pattern but must still be stripped. */
const EXPLICIT_ENV_BLOCKLIST = new Set([
  'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'QWEN_API_KEY', 'OPENAI_API_KEY',
  'ZHIPU_API_KEY', 'ZAI_API_KEY', 'GLM_API_KEY', 'TAVILY_API_KEY',
  'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
])

/**
 * Git remote credentials are deliberately allowed through the 'filtered' policy
 * so auto-mode `git push` over HTTPS works. These names take precedence over
 * BOTH the explicit blocklist and SENSITIVE_ENV_PATTERN (which would otherwise
 * strip anything ending in _TOKEN). Scope is intentionally narrow: only
 * git-remote auth — npm / AWS / model-provider keys stay stripped, and SSH key
 * auth (~/.ssh) is unaffected since it never travels through the env.
 */
const GIT_CREDENTIAL_ALLOWLIST = new Set([
  'GITHUB_TOKEN', 'GH_TOKEN', 'GIT_TOKEN', 'GITLAB_TOKEN',
])

const MINIMAL_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'SHELL',
  'TMPDIR', 'TEMP', 'TMP',
]

export type ChildEnvPolicy = 'inherit' | 'filtered' | 'empty'

/** Back-compat alias — the bash tool exported this name publicly. */
export type ShellEnvPolicy = ChildEnvPolicy

/**
 * Build the environment for a child process under `policy`.
 *
 * `overrides` are applied AFTER filtering and are never stripped: that is how a
 * caller hands a specific secret to a specific child on purpose (e.g. an
 * mcp.json entry declaring `"env": {"API_KEY": "${MY_API_KEY}"}`). This makes
 * the config file the audit point for "which child sees which credential".
 */
export function buildChildEnv(
  policy: ChildEnvPolicy,
  overrides?: Record<string, string>,
): NodeJS.ProcessEnv {
  const src = process.env
  let out: NodeJS.ProcessEnv

  if (policy === 'inherit') {
    out = { ...src }
  } else if (policy === 'empty') {
    out = {}
    for (const key of MINIMAL_ENV_KEYS) {
      if (src[key] !== undefined) out[key] = src[key]
    }
  } else {
    out = {}
    for (const [key, value] of Object.entries(src)) {
      // Git remote credentials are allowed through (see GIT_CREDENTIAL_ALLOWLIST):
      // checked first so the blocklist / sensitive-pattern below cannot strip them.
      if (!GIT_CREDENTIAL_ALLOWLIST.has(key)) {
        if (EXPLICIT_ENV_BLOCKLIST.has(key)) continue
        if (SENSITIVE_ENV_PATTERN.test(key)) continue
      }
      out[key] = value
    }
  }

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) out[key] = value
  }
  return out
}
