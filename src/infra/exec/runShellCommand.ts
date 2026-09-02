/**
 * runShellCommand — the SINGLE entry point for running a model-supplied shell
 * command as a child process.
 *
 * Why this module exists
 * ----------------------
 * The runtime used to have one hardened spawn site (the bash tool) and several
 * unhardened ones. `cron_create` was the worst of them: it took an arbitrary
 * command string, handed it to `execFile('bash', ['-c', cmd])` with the FULL
 * `process.env` (every provider key, AWS credentials, GITHUB_TOKEN), no OS
 * sandbox, no workspace-jailed cwd, and no output redaction — then ran it on a
 * repeating timer. Every control the bash tool carefully applied was absent,
 * not because anyone decided to skip them, but because the code path simply
 * did not go through the place where they live.
 *
 * `infra/env/childProcessEnv.ts` already collapsed the ENV half of this problem
 * into one policy. This module collapses the other four halves — process-group
 * lifecycle, workspace-jailed cwd, OS sandbox wrapping, and output
 * capture/redaction — so a new caller gets all five by construction.
 *
 * Rule of thumb: if a command string originates from a model or a config file
 * and ends up in a shell, it goes through here. Fixed-argv internal tooling
 * (`git`, `rg`) may keep using execFile directly — it has no shell to inject
 * into and no model-controlled argv.
 */

import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import type { SandboxHandle } from '../../sandbox/types.js'
import { buildChildEnv, type ChildEnvPolicy } from '../env/childProcessEnv.js'
import { redactSecrets } from '../redaction/secretRedaction.js'
import { resolveInsideWorkspace } from '../../tools/fs/workspaceGuard.js'

export interface RunShellCommandOptions {
  /** The raw command string handed to the shell. */
  command: string
  /** Working directory. Validated against `workspaceRoot` unless `allowedRoots` covers it. */
  cwd: string
  /**
   * Workspace jail root. When set, `cwd` must resolve inside it (or inside one
   * of `allowedRoots`); otherwise the call is refused before anything spawns.
   * Pass `undefined` only for callers that genuinely have no workspace.
   */
  workspaceRoot?: string
  /**
   * Extra absolute roots the cwd may live under, on top of `workspaceRoot`.
   * Sourced from the operator's `sandbox.writeAllowPaths` config — this is how
   * an external directory becomes a legal working directory.
   */
  allowedRoots?: readonly string[]
  timeoutMs: number
  signal: AbortSignal
  /** Credential-hygiene policy for the child's env. Default: 'filtered'. */
  envPolicy?: ChildEnvPolicy
  /**
   * Variables applied AFTER filtering, so they survive any policy.
   *
   * This is how a caller hands one specific value to one specific child on
   * purpose — the eval runner uses it to tell a verifier which workspace to
   * inspect without putting the path in the command string, where quoting would
   * be the candidate's problem to exploit. `buildChildEnv` already supports
   * overrides; only the pass-through was missing.
   */
  envOverrides?: Record<string, string>
  /** OS sandbox handle. When present, the command is wrapped via wrapExec(). */
  sandboxHandle?: SandboxHandle
  /** Max characters retained per stream. Output past this is dropped. */
  captureLimit: number
  /**
   * Shell to invoke when no sandbox handle is supplied.
   * Default: `{ file: 'bash', args: ['-c'] }` — the command is appended.
   */
  shell?: { file: string; args: readonly string[] }
}

export interface ShellCommandResult {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  /** The canonical absolute cwd the command actually ran in. */
  cwd: string
}

/** Refusal from the pre-spawn guards — nothing was executed. */
export class ShellCommandRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShellCommandRefused'
  }
}

const DEFAULT_SHELL = { file: 'bash', args: ['-c'] as const }

/**
 * Validate a cwd against the workspace jail plus any operator-granted external
 * roots. Returns the canonical absolute path.
 *
 * Grants are checked with the same segment-wise containment test the jail uses,
 * so `/data/shared-backup` is NOT accepted because `/data/shared` was granted.
 */
export function resolveJailedCwd(
  cwd: string,
  workspaceRoot: string | undefined,
  allowedRoots: readonly string[] = [],
): { ok: true; path: string } | { ok: false; error: string } {
  if (!workspaceRoot && allowedRoots.length === 0) {
    return { ok: true, path: cwd }
  }
  if (workspaceRoot) {
    const inWorkspace = resolveInsideWorkspace(cwd, workspaceRoot)
    if (inWorkspace.ok) return inWorkspace
  }
  for (const root of allowedRoots) {
    const inGrant = resolveInsideWorkspace(cwd, root)
    if (inGrant.ok) return inGrant
  }
  return {
    ok: false,
    error:
      `cwd is outside the workspace: ${cwd}` +
      (allowedRoots.length
        ? ` (granted external roots: ${allowedRoots.join(', ')})`
        : ' (grant external directories via config.json sandbox.writeAllowPaths)'),
  }
}

/**
 * Grace period between killing the process group and giving up on `close`.
 *
 * `close` fires only after every stdio stream has ended, which requires every
 * holder of the inherited fds to be gone. A grandchild that escaped the group
 * (`setsid`, a daemonising installer, `nohup`) keeps the pipe open forever, so
 * without this second fuse the promise never settles and `timeoutMs` is
 * decorative — the tool hangs, and with it the kernel loop.
 *
 * `exit` does not have that problem: it fires when the direct child terminates,
 * regardless of who still holds the pipes. So after the kill we wait a short
 * grace for the ordinary `close` (which carries the last buffered output) and
 * otherwise settle from whatever `exit` reported.
 */
const POST_KILL_GRACE_MS = 3_000

/**
 * Run `command` in its OWN PROCESS GROUP and, on timeout/abort, kill the whole
 * group (`kill(-pid)`), not just the direct child.
 *
 * `execFile({ timeout })` only SIGTERMs the shell wrapper, so pipelines and
 * backgrounded children (`npm install`, training scripts, …) survive as orphans
 * and accumulate on the machine.
 */
function runProcessGroup(
  file: string,
  args: string[],
  opts: {
    timeoutMs: number
    cwd: string
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    captureLimit: number
  },
): Promise<Omit<ShellCommandResult, 'cwd'>> {
  return new Promise((resolve, reject) => {
    const useGroup = process.platform !== 'win32'
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: useGroup, // own process group → group-killable
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      reject(err)
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    // Decode incrementally so a multi-byte UTF-8 sequence split across two
    // chunks is not turned into replacement characters at the boundary.
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')

    // Populated by 'exit'; used by the post-kill fuse when 'close' never comes.
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    let graceTimer: ReturnType<typeof setTimeout> | undefined

    /**
     * Second fuse. Armed the moment we kill, because from then on the only
     * thing that can still hold `close` back is a process we cannot reach.
     */
    const armPostKillGrace = (): void => {
      if (graceTimer || settled) return
      graceTimer = setTimeout(() => {
        finish(() => resolve({
          ...flushDecoders(),
          code: exitCode,
          signal: exitSignal,
          timedOut,
          aborted,
        }))
      }, POST_KILL_GRACE_MS)
      graceTimer.unref?.()
    }

    const killGroup = (): void => {
      // Armed unconditionally, before the kill attempt: once we have decided to
      // stop this command there must be an exit from this promise no matter
      // what the kill does (or whether there was a pid to kill at all).
      armPostKillGrace()
      if (child.pid === undefined) return
      try {
        if (useGroup) process.kill(-child.pid, 'SIGKILL') // negative pid = whole group
        else child.kill('SIGKILL')
      } catch {
        /* already exited */
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, opts.timeoutMs)

    const onAbort = (): void => {
      aborted = true
      killGroup()
    }
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })

    // Cap each stream at captureLimit EXACTLY rather than "stop once the limit
    // is already exceeded" — the check must run before the append, or one chunk
    // overshoots by a whole pipe buffer (~64 KB). Decoding continues past the
    // cap (cheap, and keeps the decoder's multi-byte state consistent); only
    // the retained text is bounded.
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = outDecoder.write(chunk)
      if (!text || stdout.length >= opts.captureLimit) return
      stdout += text.slice(0, opts.captureLimit - stdout.length)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = errDecoder.write(chunk)
      if (!text || stderr.length >= opts.captureLimit) return
      stderr += text.slice(0, opts.captureLimit - stderr.length)
    })

    /** Flush any bytes the decoders held back at a chunk boundary. */
    const flushDecoders = (): { stdout: string; stderr: string } => {
      const outTail = outDecoder.end()
      const errTail = errDecoder.end()
      if (outTail && stdout.length < opts.captureLimit) {
        stdout += outTail.slice(0, opts.captureLimit - stdout.length)
      }
      if (errTail && stderr.length < opts.captureLimit) {
        stderr += errTail.slice(0, opts.captureLimit - stderr.length)
      }
      return { stdout, stderr }
    }

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      opts.signal.removeEventListener('abort', onAbort)
      fn()
    }

    child.on('error', err => finish(() => reject(err)))
    // Recorded, not settled on: `close` is still preferred because it means the
    // output really is complete. This only feeds the post-kill fuse above.
    child.on('exit', (code, signal) => {
      exitCode = code
      exitSignal = signal
    })
    child.on('close', (code, signal) =>
      finish(() => resolve({ ...flushDecoders(), code, signal, timedOut, aborted })),
    )
  })
}

/**
 * Execute a model-supplied shell command under the full guard stack:
 * cwd jail → credential-filtered env → OS sandbox → process group → bounded,
 * redacted capture.
 *
 * Throws `ShellCommandRefused` when a pre-spawn guard rejects the call (nothing
 * ran); propagates spawn errors otherwise.
 */
export async function runShellCommand(
  opts: RunShellCommandOptions,
): Promise<ShellCommandResult> {
  if (!opts.command) throw new ShellCommandRefused('command is required')

  const jailed = resolveJailedCwd(opts.cwd, opts.workspaceRoot, opts.allowedRoots)
  if (!jailed.ok) throw new ShellCommandRefused(jailed.error)
  const cwd = jailed.path

  const shell = opts.shell ?? DEFAULT_SHELL
  const spec = opts.sandboxHandle
    ? opts.sandboxHandle.wrapExec(opts.command, cwd)
    : { file: shell.file, args: [...shell.args, opts.command] }

  const res = await runProcessGroup(spec.file, spec.args, {
    timeoutMs: opts.timeoutMs,
    cwd,
    env: buildChildEnv(opts.envPolicy ?? 'filtered', opts.envOverrides),
    signal: opts.signal,
    captureLimit: opts.captureLimit,
  })

  // Redact on the way out, once, for every caller. A tool that formats the
  // streams itself can no longer forget this step.
  return {
    ...res,
    stdout: redactSecrets(res.stdout),
    stderr: redactSecrets(res.stderr),
    cwd,
  }
}
