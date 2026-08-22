/**
 * Shared plumbing for the persistent-shell tools (exec_session / write_stdin /
 * close_session).
 *
 * The three tools differ only in which store method they call; everything that
 * makes them SAFE — the sandbox handle precedence, the operator-granted
 * external roots, the env policy, the output budget, the error mapping — is
 * identical and lives here, so a future fourth tool cannot get a subset of it.
 */

import type { SandboxConfig, SandboxHandle } from '../../sandbox/types.js'
import type { ToolCallContext, ToolResult } from '../../core/types.js'
import { resolveSandboxPolicy } from '../../sandbox/sandboxPolicyConfig.js'
import { RuntimeEnv } from '../../infra/env/RuntimeEnv.js'
import type { ShellEnvPolicy } from '../../infra/env/childProcessEnv.js'
import { ShellCommandRefused } from '../../infra/exec/runShellCommand.js'
import {
  shellSessionStore,
  ShellSessionExited,
  ShellSessionNotFound,
  type ShellReadResult,
  type ShellSessionInfo,
} from '../../infra/exec/ShellSessionStore.js'

const DEFAULT_MAX_OUT = 100 * 1024

/**
 * Default OS-sandbox policy for main-agent shell sessions.
 *
 * Mirrors the bash tool's `DEFAULT_MAIN_SANDBOX` — including
 * `allowUnsandboxedFallback: true` — so opening a session is neither more nor
 * less privileged than running the same command one-shot. A session that
 * sandboxed differently from `bash` would be a way to pick the weaker of two
 * policies by choosing a tool.
 */
export const DEFAULT_SESSION_SANDBOX: SandboxConfig = { allowUnsandboxedFallback: true }

export interface ShellSessionToolOptions {
  /** Closure-captured handle for the sub-agent path (SubAgentRunner). */
  sandboxHandle?: SandboxHandle
  envPolicy?: ShellEnvPolicy
  sandbox?: boolean | SandboxConfig
}

export function resolveSessionSandboxPolicy(
  opts: ShellSessionToolOptions,
): true | SandboxConfig | undefined {
  if (opts.sandbox === false) return undefined
  if (opts.sandbox === undefined || opts.sandbox === true) return DEFAULT_SESSION_SANDBOX
  return opts.sandbox
}

/**
 * External host roots the operator granted in config.json.
 *
 * Memoised per workspace for the same reason the bash tool memoises it:
 * resolving the policy stats every configured path, and a session-heavy turn
 * would repeat that work on every read.
 */
const _rootsCache = new Map<string, string[]>()

export function sessionExternalRoots(workspaceRoot: string | undefined): string[] {
  const key = workspaceRoot ?? ''
  const cached = _rootsCache.get(key)
  if (cached) return cached
  const roots = resolveSandboxPolicy(workspaceRoot).allowedRoots
  _rootsCache.set(key, roots)
  return roots
}

/** Tests, and after a config write. */
export function resetSessionGrantCache(): void {
  _rootsCache.clear()
}

export function maxSessionOutputChars(): number {
  return RuntimeEnv.maxToolOutputChars(DEFAULT_MAX_OUT)
}

/** Sandbox handle precedence — identical to the bash tool's. */
export function activeSandboxHandle(
  ctx: ToolCallContext,
  closureHandle?: SandboxHandle,
): SandboxHandle | undefined {
  return ctx.sandboxHandle ?? closureHandle
}

/**
 * Owner scope for a session.
 *
 * `agentId` (not `sessionId`) is the isolation boundary: a sub-agent runs
 * inside the parent's Node process and shares its store, so keying on the
 * conversation id would let a sub-agent read and write the main agent's live
 * REPL. `agentId` falls back to `sessionId` for the main agent, where the two
 * are the same thing.
 */
export function ownerOf(ctx: ToolCallContext): string {
  return ctx.agentId || ctx.sessionId
}

/**
 * Render a read result for the model.
 *
 * Three facts must survive into the text, because each one changes what the
 * caller should do next and none is inferable from the output alone:
 *   - the process EXITED (open a new session; do not keep writing),
 *   - the read YIELDED while still running (there may be more; read again),
 *   - bytes were DROPPED (the transcript has a hole; the ring buffer wrapped).
 */
export function renderReadResult(
  sessionId: string,
  res: ShellReadResult,
  opts: { includeHeader?: boolean } = {},
): string {
  const limit = maxSessionOutputChars()
  const parts: string[] = []

  if (res.droppedBytes > 0) {
    parts.push(
      `[${res.droppedBytes} earlier chars dropped — output exceeded the session buffer; ` +
        `read more often or redirect verbose output to a file]`,
    )
  }

  const body =
    res.output.length > limit
      ? res.output.slice(res.output.length - limit) +
        `\n[Truncated — kept the last ${limit} of ${res.output.length} chars]`
      : res.output
  if (body) parts.push(body)

  if (!res.running) {
    parts.push(`[session ${sessionId} exited with code ${res.exitCode ?? 'unknown'}]`)
  } else if (res.yielded) {
    parts.push(
      `[still running — yielded after the read window; call write_stdin with an empty ` +
        `input (or a longer yield_time_ms) to keep reading session ${sessionId}]`,
    )
  }

  if (opts.includeHeader) parts.unshift(`session_id: ${sessionId}`)
  return parts.join('\n') || '(no output yet)'
}

export function renderSessionInfo(info: ShellSessionInfo): string {
  const state = info.running
    ? 'running'
    : `exited(${info.exitCode ?? (info.killed ? 'killed' : 'unknown')})`
  const age = Math.round((Date.now() - info.createdAt) / 1000)
  return (
    `${info.id}  ${state}  shell=${info.shell}  cwd=${info.cwd}  age=${age}s` +
    (info.sandboxed ? '  sandboxed' : '') +
    (info.label ? `  label=${info.label}` : '')
  )
}

/**
 * Map store/guard exceptions onto tool results.
 *
 * Every one of these is a normal, actionable outcome the model should read and
 * respond to — not a crash. Letting them propagate would surface as an opaque
 * tool failure and lose the remediation hint each message carries.
 */
export function toToolError(err: unknown): ToolResult {
  if (err instanceof ShellSessionNotFound || err instanceof ShellSessionExited) {
    return { content: `Error: ${err.message}`, isError: true }
  }
  if (err instanceof ShellCommandRefused) {
    return { content: `Error: ${err.message}`, isError: true }
  }
  return {
    content: `Error: ${err instanceof Error ? err.message : String(err)}`,
    isError: true,
  }
}

export { shellSessionStore }
