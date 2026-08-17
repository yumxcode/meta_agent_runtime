/**
 * secretRedaction — last-resort transcript guard for credentials that reach
 * tool output despite the filtered child environment.
 *
 * This is defence in depth, NOT a boundary. Anything reversible (base64, hex,
 * split-and-join, writing to a file the model then reads) defeats it. The real
 * controls are: don't put the credential in the child's env at all
 * (`infra/env/childProcessEnv.ts`), and don't let the sandbox read the
 * credential file (`sandbox.readDenyPaths`).
 *
 * Two independent rule families, because each covers the other's blind spot:
 *
 *   1. NAME=VALUE / "name": "value" shapes — catches `env`, `printenv`,
 *      `cat .env`, JSON config dumps. Blind to a bare value.
 *   2. VALUE SHAPE — catches the bare value. This family exists because the
 *      name-based rules missed the single most likely leak in this runtime:
 *      `GITHUB_TOKEN` is deliberately forwarded to children (git push over
 *      HTTPS needs it), so `echo $GITHUB_TOKEN` printed a bare `ghp_…` with no
 *      surrounding name, matched nothing, and landed verbatim in model context,
 *      debug logs and long-lived lineage sessions.
 */

/** Field names whose value is redacted in `name: value` / `name=value` shapes. */
const SENSITIVE_FIELD_NAMES =
  'api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential|private[_-]?key|auth[_-]?token|session[_-]?key'

const NAMED_VALUE_RE = new RegExp(
  `(["']?(?:${SENSITIVE_FIELD_NAMES})["']?\\s*[:=]\\s*)["']?[^\\s,"'}]+["']?`,
  'gi',
)

/**
 * ENV_ASSIGNMENT_RE — `SOME_TOKEN=value` for credential-shaped variable names.
 *
 * Deliberately provider-agnostic: the previous version hard-coded a prefix list
 * (GM|OPENAI|ANTHROPIC|…), so every provider it had not heard of leaked, and
 * `GH_TOKEN` / `GIT_TOKEN` were missing even though the runtime forwards them.
 * Matching on the credential-shaped SUFFIX covers providers we have never seen.
 */
const ENV_ASSIGNMENT_RE =
  /\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PAT|DSN))=(\S+)/g

/**
 * Value-shaped credentials, keyed on issuer prefixes that are unambiguous
 * enough not to fire on ordinary text.
 *
 *   ghp_/gho_/ghu_/ghs_/ghr_ · github_pat_   GitHub PATs and app tokens
 *   glpat-                                    GitLab PAT
 *   sk-/sk-ant-                               OpenAI / Anthropic style keys
 *   AKIA/ASIA + 16 upper-alnum                AWS access key IDs
 *   xox[abposr]-                              Slack tokens
 *   AIza + 35                                 Google API keys
 *   npm_ + 36                                 npm automation tokens
 *   ey…​.ey…​.…                                 JWTs (three base64url segments)
 */
const VALUE_SHAPED_RES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9\-_]{16,}/g,
  /\bsk-(?:ant-)?[A-Za-z0-9\-_]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9\-]{10,}/g,
  /\bAIza[0-9A-Za-z\-_]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // URLs carrying inline credentials: https://user:token@host
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
]

/**
 * Redact credential-shaped content from text that is about to enter model
 * context, a log, or a persisted transcript.
 */
export function redactSecrets(value: string): string {
  if (!value) return value
  let out = value
    .replace(NAMED_VALUE_RE, '$1[REDACTED]')
    .replace(ENV_ASSIGNMENT_RE, '$1=[REDACTED]')
  for (const re of VALUE_SHAPED_RES) {
    out = out.replace(re, match => (match.endsWith('@') ? redactUrlCredential(match) : '[REDACTED]'))
  }
  return out
}

/** `https://user:token@` → `https://[REDACTED]@` (scheme preserved for readability). */
function redactUrlCredential(match: string): string {
  const schemeEnd = match.indexOf('://')
  return schemeEnd === -1 ? '[REDACTED]@' : `${match.slice(0, schemeEnd + 3)}[REDACTED]@`
}

/**
 * Back-compat alias — the bash tool exported this name publicly before the
 * logic moved here to be shared with every other subprocess call site.
 */
export const redactSensitiveShellOutput = redactSecrets
