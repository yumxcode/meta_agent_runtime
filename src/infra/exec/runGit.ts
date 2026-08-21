/**
 * runGit — the single entry point for invoking `git` as a child process.
 *
 * Why this module exists
 * ----------------------
 * `runShellCommand` collapsed the "model-supplied command string → shell" paths
 * into one hardened site. It deliberately left fixed-argv internal tooling
 * alone, on the reasoning that `git` has no shell to inject into and no
 * model-controlled argv. That reasoning is correct — and it covered only half
 * of the problem.
 *
 * The other half is the environment and the OUTPUT:
 *
 *   1. Every `git` call in the codebase used `execFile('git', args, { cwd })`
 *      with no `env`, which inherits `process.env` in full — every provider
 *      key, `GITHUB_TOKEN`, `AWS_*`. Four separate files did this
 *      independently (GitWorkspaceManager, AutoWorktreeCoordinator,
 *      JudgeSnapshot, TeamStore), so "git sees all credentials" was a property
 *      of the codebase, not a decision anyone made.
 *
 *   2. git's stdout goes straight into the model context. `getTaskDiff()` feeds
 *      `git diff` output to the `git_diff_subagent` tool result verbatim. If a
 *      sub-agent committed a config file containing a token, the diff carries
 *      it into the context window, the transcript, the debug log and the
 *      lineage record. `runShellCommand` redacts for exactly this reason; the
 *      git paths never did.
 *
 * Both halves are now applied by construction. Callers keep passing plain argv
 * arrays; they cannot forget the env policy or the redaction because they no
 * longer choose either.
 *
 * NOTE ON ARGV: `git` treats a leading `-` as an option. Callers building argv
 * from stored state (branch names, refs) should keep using `--` separators as
 * they already do; this module does not attempt to sanitise argv, because doing
 * it generically would break legitimate flags.
 */

import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { buildChildEnv } from '../env/childProcessEnv.js'
import { redactSecrets } from '../redaction/secretRedaction.js'

const execFileAsync = promisify(execFile)

export interface RunGitOptions {
  cwd?: string
  timeout?: number
  maxBuffer?: number
  /**
   * Skip output redaction. Only for callers that parse machine-readable output
   * where `[REDACTED]` substitution would corrupt the parse (e.g. `ls-files -z`
   * NUL-delimited records, `rev-list --count` integers). Those outputs are
   * structurally incapable of carrying a credential, which is the whole reason
   * the exemption is safe — it is NOT a general escape hatch.
   */
  raw?: boolean
  /**
   * Explicit per-call env grants, layered on top of the filtered base. This is
   * how a caller hands ONE specific variable to ONE specific git invocation on
   * purpose (the same shape mcp.json uses), which keeps "who sees which
   * credential" a decision recorded at the call site rather than a property of
   * the ambient process environment.
   */
  extraEnv?: NodeJS.ProcessEnv
}

function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = buildChildEnv('filtered')
  return extra ? { ...base, ...extra } : base
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024

/**
 * Run `git` with the credential-filtered environment and redacted output.
 * Rejects the way `execFile` does, so existing `.catch()` handlers still work.
 */
export async function runGit(
  args: readonly string[],
  opts: RunGitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', [...args], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      env: gitEnv(opts.extraEnv),
    })
    return opts.raw
      ? { stdout: String(stdout), stderr: String(stderr) }
      : { stdout: redactSecrets(String(stdout)), stderr: redactSecrets(String(stderr)) }
  } catch (err) {
    // git failures surface the failing command line and often its stderr; a
    // remote URL with an embedded token lives in both. Redact before it reaches
    // a log or an error message shown to the model.
    throw redactExecError(err)
  }
}

/**
 * Synchronous variant. Prefer `runGit`; this exists for the handful of probe
 * sites that run during construction and genuinely cannot await.
 */
export function runGitSync(args: readonly string[], opts: RunGitOptions = {}): string {
  try {
    const out = execFileSync('git', [...args], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      env: gitEnv(opts.extraEnv),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return opts.raw ? String(out) : redactSecrets(String(out))
  } catch (err) {
    throw redactExecError(err)
  }
}

/** Redact the message/stdout/stderr an execFile rejection carries. */
function redactExecError(err: unknown): unknown {
  if (!(err instanceof Error)) return err
  const e = err as Error & { stdout?: unknown; stderr?: unknown }
  e.message = redactSecrets(e.message)
  if (typeof e.stdout === 'string') e.stdout = redactSecrets(e.stdout)
  if (typeof e.stderr === 'string') e.stderr = redactSecrets(e.stderr)
  return e
}
