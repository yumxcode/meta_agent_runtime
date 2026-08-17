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
  /(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|SESSION_KEY|ACCESS_KEY|REFRESH_TOKEN|AUTH|_KEY|_PAT|_DSN|_URI|_URL)$/i

/**
 * Names matching SENSITIVE_ENV_PATTERN that are NOT credentials and must keep
 * flowing, because the suffix list above deliberately over-matches.
 *
 * `_URL`/`_URI` are on the sensitive list because connection strings routinely
 * embed a password (`DATABASE_URL=postgres://user:pw@host/db`), and stripping a
 * credential-bearing URL matters more than forwarding a plain endpoint. But
 * `OPENAI_BASE_URL` and friends are how a user points the runtime at a proxy or
 * a self-hosted gateway — stripping those breaks the runtime's own
 * configuration, so they are named here explicitly.
 */
const ENV_PATTERN_EXEMPTIONS = new Set([
  'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'DEEPSEEK_BASE_URL', 'QWEN_BASE_URL',
  'GLM_BASE_URL', 'ZHIPU_BASE_URL', 'ZAI_BASE_URL', 'OLLAMA_BASE_URL',
  'META_AGENT_BASE_URL', 'BASE_URL',
  'NPM_CONFIG_REGISTRY', 'NPM_REGISTRY_URL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'SSH_AUTH_SOCK',
])

/** Names that don't match the suffix pattern but must still be stripped. */
const EXPLICIT_ENV_BLOCKLIST = new Set([
  'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'QWEN_API_KEY', 'OPENAI_API_KEY',
  'ZHIPU_API_KEY', 'ZAI_API_KEY', 'GLM_API_KEY', 'TAVILY_API_KEY',
  'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
])

/**
 * Git remote credentials allowed through the 'filtered' policy so auto-mode
 * `git push` over HTTPS works. These names take precedence over BOTH the
 * explicit blocklist and SENSITIVE_ENV_PATTERN (which would otherwise strip
 * anything ending in _TOKEN).
 *
 * KNOWN RESIDUAL RISK, and why it is still on by default: a forwarded token is
 * readable by anything the child runs — including a command the model wrote, so
 * `echo $GITHUB_TOKEN` puts the value in model context. Two things bound that:
 * `infra/redaction/secretRedaction.ts` now matches the token's VALUE SHAPE
 * (`ghp_…`, `github_pat_…`, `glpat-…`) rather than only `NAME=value`, so the
 * bare-echo leak is caught on the way out; and an operator who does not need
 * `git push` can turn the passthrough off entirely with
 * `sandbox.gitCredentialPassthrough: false` in config.json.
 *
 * The properly scoped fix is a credential helper / GIT_ASKPASS that hands the
 * token to one `git` invocation instead of to every descendant of the session;
 * that is tracked separately because it changes how auto-mode push is wired.
 */
const GIT_CREDENTIAL_ALLOWLIST = new Set([
  'GITHUB_TOKEN', 'GH_TOKEN', 'GIT_TOKEN', 'GITLAB_TOKEN',
])

/**
 * Operator switch for the allowlist above, resolved lazily so a config change
 * does not require a restart. Defaults to ON for back-compat with auto-mode push.
 */
let _gitPassthrough: boolean | undefined
export function setGitCredentialPassthrough(enabled: boolean | undefined): void {
  _gitPassthrough = enabled
}
function gitCredentialPassthroughEnabled(): boolean {
  return _gitPassthrough !== false
}

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
      const gitAllowed = GIT_CREDENTIAL_ALLOWLIST.has(key) && gitCredentialPassthroughEnabled()
      if (!gitAllowed) {
        if (EXPLICIT_ENV_BLOCKLIST.has(key)) continue
        // The suffix pattern deliberately over-matches (it must cover providers
        // we have never heard of), so named non-credentials are exempted.
        if (SENSITIVE_ENV_PATTERN.test(key) && !ENV_PATTERN_EXEMPTIONS.has(key)) continue
      }
      out[key] = value
    }
  }

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) out[key] = value
  }
  return out
}
