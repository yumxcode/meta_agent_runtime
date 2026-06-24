import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { dynamicDescription } from '../../util.js'
import { resolveInsideWorkspace } from '../../fs/workspaceGuard.js'
import type { SandboxConfig, SandboxHandle } from '../../../sandbox/types.js'

const DEFAULT_MAX_OUT = 100 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MIN_TIMEOUT_MS = 1_000

/**
 * Lazy getter so tests can set META_AGENT_MAX_TOOL_OUTPUT_CHARS after importing
 * and immediately see the new value (no module-load-time snapshot).
 */
function getMaxOut(): number {
  const raw = process.env['META_AGENT_MAX_TOOL_OUTPUT_CHARS']
  if (raw === undefined) return DEFAULT_MAX_OUT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_OUT
  return Math.min(1024 * 1024, Math.max(1024, parsed))
}

/**
 * H4: Validate timeout_ms input. Accepts only finite numbers; out-of-range
 * values are clamped to [1s, 120s]. Returns DEFAULT_TIMEOUT_MS for everything
 * non-numeric / NaN / Infinity.
 */
function resolveTimeoutMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, raw))
}

/**
 * H5: Build the env passed to the spawned shell.
 *
 *   'inherit'  → forward process.env verbatim (legacy behaviour)
 *   'filtered' → drop common credential-bearing variables (default)
 *   'empty'    → start with PATH / HOME / LANG only
 *
 * The "filtered" policy strips anything matching /(_API_KEY|_TOKEN|_SECRET|
 * _PASSWORD|_CREDENTIALS|_AUTH)$/i plus a small explicit blocklist.
 */
const SENSITIVE_ENV_PATTERN =
  /(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|SESSION_KEY|ACCESS_KEY|REFRESH_TOKEN|AUTH)$/i
const EXPLICIT_ENV_BLOCKLIST = new Set([
  'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'QWEN_API_KEY', 'OPENAI_API_KEY',
  'GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
])
const MINIMAL_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'SHELL', 'TMPDIR', 'TEMP', 'TMP']

export type ShellEnvPolicy = 'inherit' | 'filtered' | 'empty'

function buildShellEnv(policy: ShellEnvPolicy): NodeJS.ProcessEnv {
  const src = process.env
  if (policy === 'inherit') return { ...src }
  if (policy === 'empty') {
    const out: NodeJS.ProcessEnv = {}
    for (const key of MINIMAL_ENV_KEYS) {
      if (src[key] !== undefined) out[key] = src[key]
    }
    return out
  }
  // 'filtered' (default)
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(src)) {
    if (EXPLICIT_ENV_BLOCKLIST.has(key)) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    out[key] = value
  }
  return out
}

export interface BashToolOptions {
  /**
   * When provided, every bash command is wrapped via sandboxHandle.wrapExec()
   * before execution, applying the OS-level sandbox policy configured for
   * the sub-agent session.
   */
  sandboxHandle?: SandboxHandle

  /**
   * H5: Controls what env vars are forwarded to the spawned shell.
   *
   *   'inherit'  — forward process.env verbatim (legacy behaviour)
   *   'filtered' — strip API keys / tokens / credentials (default)
   *   'empty'    — only PATH / HOME / LANG and a handful of basics
   *
   * Defaults to 'filtered' so models cannot exfiltrate API keys via shell.
   * Override to 'inherit' for trusted workflows that need full env access.
   */
  envPolicy?: ShellEnvPolicy

  /**
   * M1: OS-level sandbox policy for MAIN-AGENT bash commands.
   *
   * When set, the bash tool declares `permission.sandbox`, which makes
   * MetaAgentSession lazily create a SandboxHandle (bwrap on Linux,
   * sandbox-exec on macOS) and inject it into ctx for every call — so the
   * shell runs inside a read-only-root + writable-workspace jail.
   *
   * Benchmarked overhead is a fixed ~1.5–5 ms of namespace setup per command,
   * negligible next to model latency and the command's own runtime, so this
   * defaults to ON.
   *
   *   true / SandboxConfig → enforce the policy
   *   false                → legacy unsandboxed execution
   *
   * The default policy sets `allowUnsandboxedFallback: true` so hosts without
   * a sandbox backend (no bwrap / sandbox-exec) degrade to direct execution
   * instead of hard-failing. Pass an explicit config to tighten this.
   */
  sandbox?: boolean | SandboxConfig
}

const DEFAULT_MAIN_SANDBOX: SandboxConfig = { allowUnsandboxedFallback: true }

interface RunResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  aborted: boolean
}

/**
 * M4-fix: run a command in its OWN PROCESS GROUP and, on timeout/abort, kill
 * the whole group (`kill(-pid)`), not just the direct child.  The previous
 * execFile({ timeout }) only SIGTERM'd the bash wrapper, so pipelines and
 * backgrounded children (`npm install`, training scripts, …) survived as
 * orphans and accumulated on the machine.
 */
function runProcessGroup(
  file: string,
  args: string[],
  opts: {
    timeoutMs: number
    cwd: string
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    /** Per-stream capture cap (bytes kept in memory). */
    captureLimit: number
  },
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const useGroup = process.platform !== 'win32'
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: useGroup,           // own process group → group-killable
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
    // L2: decode incrementally so a multi-byte UTF-8 sequence split across two
    // chunks is not turned into replacement characters at the boundary.
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')

    const killGroup = (): void => {
      if (child.pid === undefined) return
      try {
        if (useGroup) {
          process.kill(-child.pid, 'SIGKILL')   // negative pid = whole group
        } else {
          child.kill('SIGKILL')
        }
      } catch { /* already exited */ }
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

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < opts.captureLimit) stdout += outDecoder.write(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < opts.captureLimit) stderr += errDecoder.write(chunk)
    })

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      fn()
    }

    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) =>
      finish(() => {
        // Flush any bytes the decoders held back at a chunk boundary.
        if (stdout.length < opts.captureLimit) stdout += outDecoder.end()
        if (stderr.length < opts.captureLimit) stderr += errDecoder.end()
        resolve({ stdout, stderr, code, timedOut, aborted })
      }),
    )
  })
}

export async function createBashTool(opts: BashToolOptions = {}): Promise<MetaAgentTool> {
  const { sandboxHandle } = opts
  const envPolicy: ShellEnvPolicy = opts.envPolicy ?? 'filtered'
  // Resolve the declared sandbox policy. `undefined` (option omitted) and
  // `true` both map to the safe default; `false` disables; an object is used
  // verbatim. A closure-provided sandboxHandle (sub-agent path) takes
  // precedence at call time and does not need this declaration.
  const sandboxPolicy: true | SandboxConfig | undefined =
    opts.sandbox === false
      ? undefined
      : opts.sandbox === undefined || opts.sandbox === true
        ? DEFAULT_MAIN_SANDBOX
        : opts.sandbox
  // Dynamic description: tells the model to prefer sibling tools over shell
  // equivalents — but only lists the ones actually registered in the session.
  // Mirrors CC's BashTool.prompt() which injects tool names at resolution time.
  const description = dynamicDescription(import.meta.url, (base, ctx) => {
    const hints: string[] = []
    if (ctx.toolNames.has('grep'))          hints.push('- Search file contents: use `grep` tool (NOT rg/grep commands)')
    if (ctx.toolNames.has('glob'))          hints.push('- Find files by pattern: use `glob` tool (NOT find/ls)')
    if (ctx.toolNames.has('read_file'))     hints.push('- Read files: use `read_file` tool (NOT cat/head/tail)')
    if (ctx.toolNames.has('edit_file'))     hints.push('- Edit files: use `edit_file` tool (NOT sed/awk)')
    if (ctx.toolNames.has('write_file'))    hints.push('- Write files: use `write_file` tool (NOT echo >/tee)')
    if (ctx.toolNames.has('notebook_edit')) hints.push('- Edit Jupyter cells: use `notebook_edit` tool')
    return hints.length
      ? `${base}\n\nPrefer these tools over shell equivalents when available:\n${hints.join('\n')}`
      : base
  })
  return {
    name: 'bash',
    abortSupport: 'cooperative',
    description,
    permission: {
      category: 'execute',
      cwdField: 'cwd',
      requiresWorkspace: true,
      sensitive: true,
      planMode: 'ask',
      // M1: main-agent bash now runs inside the OS sandbox by default.
      // MetaAgentSession reads this to inject a SandboxHandle into ctx.
      // The closure-captured sandboxHandle (sub-agent path) still overrides
      // ctx.sandboxHandle at call time, so this declaration only affects the
      // main-agent path.
      sandbox: sandboxPolicy,
    },
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Bash command to execute' },
        timeout_ms: { type: 'number', description: 'Timeout ms. Default: 30000, max: 120000' },
        cwd: { type: 'string', description: 'Working directory. Default: process.cwd()' },
      },
      required: ['command'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const command = input['command'] as string
      const timeoutMs = resolveTimeoutMs(input['timeout_ms'])
      // Default cwd to the session's workspace root, NOT process.cwd(): sub-agents
      // run inside the PARENT's Node process, so process.cwd() can sit OUTSIDE the
      // sub-agent's own workspace (e.g. a verify snapshot is a SUBDIR of the launch
      // cwd). That made every cwd-less bash call fail the workspace-jail check with
      // "cwd is outside workspace" and silently crippled snapshot-bound judges.
      // Falling back to workspaceRoot keeps the default cwd inside the jail.
      const rawCwd = (input['cwd'] as string | undefined) ?? ctx.workspaceRoot ?? process.cwd()
      if (!command) return { content: 'Error: command is required', isError: true }
      const resolvedCwd = resolveInsideWorkspace(rawCwd, ctx.workspaceRoot)
      if (!resolvedCwd.ok) return { content: `Error: cwd is outside workspace: ${rawCwd}`, isError: true }
      // Run on the canonical absolute cwd the guard approved — a relative cwd
      // must not be re-resolved against process.cwd() at spawn time.
      const cwd = resolvedCwd.path
      const limit = getMaxOut()
      const trunc = (s: string) => s.length > limit ? s.slice(0, limit) + `\n[Truncated — ${s.length} bytes]` : s

      // Resolve exec spec — priority order:
      //   1. ctx.sandboxHandle  injected by MetaAgentSession._wrapTool() for main-agent calls
      //   2. sandboxHandle      closure-captured for sub-agent calls (SubAgentRunner path)
      //   3. plain bash         no sandboxing configured
      const activeHandle = ctx.sandboxHandle ?? sandboxHandle
      const execSpec = activeHandle
        ? activeHandle.wrapExec(command, cwd)
        : { file: 'bash', args: ['-c', command] }

      try {
        const res = await runProcessGroup(execSpec.file, execSpec.args, {
          timeoutMs,
          cwd,
          env: buildShellEnv(envPolicy),
          signal: ctx.abortSignal,
          captureLimit: limit * 2,
        })

        if (res.timedOut || res.aborted) {
          // M9: surface any captured output BEFORE the kill so the model can
          // see how far the command got before timing out.
          const parts: string[] = [
            res.timedOut
              ? `Command timed out after ${timeoutMs}ms`
              : 'Command aborted',
          ]
          if (res.stdout) parts.push(trunc(res.stdout))
          if (res.stderr) parts.push(`STDERR:\n${trunc(res.stderr)}`)
          return { content: parts.join('\n'), isError: true }
        }

        if (res.code === 0) {
          const parts: string[] = []
          if (res.stdout) parts.push(trunc(res.stdout))
          if (res.stderr) parts.push(`STDERR:\n${trunc(res.stderr)}`)
          return { content: parts.join('\n') || '(no output)', isError: false }
        }

        const parts: string[] = []
        if (res.stdout) parts.push(trunc(res.stdout))
        if (res.stderr) parts.push(`STDERR:\n${trunc(res.stderr)}`)
        parts.push(`Exit code: ${res.code ?? 'unknown'}`)
        return { content: parts.join('\n'), isError: true }
      } catch (err: unknown) {
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        }
      }
    },
  }
}
