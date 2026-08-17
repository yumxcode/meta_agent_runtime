import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { dynamicDescription } from '../../util.js'
import type { SandboxConfig, SandboxHandle } from '../../../sandbox/types.js'
import { resolveSandboxPolicy } from '../../../sandbox/sandboxPolicyConfig.js'
import { RuntimeEnv } from '../../../infra/env/RuntimeEnv.js'
import type { ShellEnvPolicy } from '../../../infra/env/childProcessEnv.js'
import { runShellCommand, ShellCommandRefused } from '../../../infra/exec/runShellCommand.js'
import { timeout } from '../../../core/timeouts.js'

const DEFAULT_MAX_OUT = 100 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MIN_TIMEOUT_MS = 1_000

/**
 * Absolute ceiling for one shell command, regardless of configuration.
 *
 * Was a flat 120s. Too tight for robotics work — a build, a sim run or a test
 * suite routinely exceeds two minutes — and, worse, it CONTRADICTED the layer
 * above it: the kernel's own per-tool budget (`timeouts.toolMs`) defaults to
 * 180s, so raising this constant alone changed nothing; ToolExecution would
 * abort the call first and the model would see a bare "Command aborted"
 * instead of bash's own message with the captured output.
 *
 * So the effective cap is now DERIVED from that budget (see maxTimeoutMs), and
 * this constant is only the hard ceiling an operator cannot exceed even by
 * raising `timeouts.toolMs`.
 */
const HARD_MAX_TIMEOUT_MS = 600_000

/**
 * Headroom left between bash's own timer and the kernel's abort.
 *
 * Both bound the same call, and we want BASH's timer to be the one that fires:
 * it kills the whole process group and returns the output captured so far, so
 * the model learns how far the command got. The kernel's abort is a blunter
 * fallback. One second is enough — these are the same event loop.
 */
const KERNEL_ABORT_MARGIN_MS = 1_000

/**
 * The largest timeout a single command may request right now.
 *
 * Read lazily, not captured at module load, so a config-file / env override of
 * `timeouts.toolMs` takes effect without a restart — same rule as every other
 * timeout in this codebase.
 */
function maxTimeoutMs(): number {
  const kernelBudget = timeout('toolMs')
  // toolMs = 0 means "no kernel timeout"; only the hard ceiling applies then.
  if (!Number.isFinite(kernelBudget) || kernelBudget <= 0) return HARD_MAX_TIMEOUT_MS
  return Math.min(
    HARD_MAX_TIMEOUT_MS,
    Math.max(MIN_TIMEOUT_MS, kernelBudget - KERNEL_ABORT_MARGIN_MS),
  )
}

/**
 * Lazy getter so tests can set META_AGENT_MAX_TOOL_OUTPUT_CHARS after importing
 * and immediately see the new value (no module-load-time snapshot).
 */
function getMaxOut(): number {
  return RuntimeEnv.maxToolOutputChars(DEFAULT_MAX_OUT)
}

/**
 * External host roots the operator granted in config.json
 * (`sandbox.writeAllowPaths` / `sandbox.readAllowPaths`).
 *
 * Memoised per workspace: resolving the policy stats every configured path, and
 * a shell-heavy turn would otherwise repeat that work on every single command.
 * A config change takes effect on the next session, which matches how the rest
 * of the sandbox settings behave.
 */
const _externalRootsCache = new Map<string, string[]>()
function externalRoots(workspaceRoot: string | undefined): string[] {
  const key = workspaceRoot ?? ''
  const cached = _externalRootsCache.get(key)
  if (cached) return cached
  const roots = resolveSandboxPolicy(workspaceRoot).allowedRoots
  _externalRootsCache.set(key, roots)
  return roots
}

/** Drop the memoised grants (tests, and after a config write). */
export function resetSandboxGrantCache(): void {
  _externalRootsCache.clear()
}

/**
 * H4: Validate timeout_ms input. Accepts only finite numbers; out-of-range
 * values are clamped to [MIN_TIMEOUT_MS, maxTimeoutMs()]. Returns the default
 * for everything non-numeric / NaN / Infinity.
 */
function resolveTimeoutMs(raw: unknown): number {
  const max = maxTimeoutMs()
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return Math.min(DEFAULT_TIMEOUT_MS, max)
  return Math.min(max, Math.max(MIN_TIMEOUT_MS, raw))
}

/**
 * Last-resort transcript guard for CLIs that print credentials despite the
 * filtered environment.
 *
 * The implementation moved to `infra/redaction/secretRedaction.ts` so that every
 * subprocess call site shares it — `runShellCommand` now applies it to stdout
 * and stderr for all callers, which is why this tool no longer calls it
 * per-stream. Re-exported because it was part of this module's public surface.
 */
export { redactSecrets as redactSensitiveShellOutput } from '../../../infra/redaction/secretRedaction.js'

/**
 * H5: the env passed to the spawned shell.
 *
 * The policy itself now lives in infra/env/childProcessEnv.ts so that EVERY
 * child process this runtime spawns shares one credential-hygiene rule — the
 * MCP stdio client used to hand out the full `process.env`, quietly undoing the
 * protection this tool was written to provide. `ShellEnvPolicy` is re-exported
 * here because it was part of this module's public surface.
 */
export type { ShellEnvPolicy } from '../../../infra/env/childProcessEnv.js'

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

/**
 * Default OS-sandbox policy for MAIN-AGENT bash.
 *
 * `readDenyPaths` is left empty HERE on purpose: the credential deny list is
 * resolved per-session from the operator's config (`sandbox.protectCredentials`,
 * default on) and merged in by ToolRuntimeGuards.applySandboxPolicy. Baking a
 * hard-coded list into the tool would make it unconfigurable, and an operator
 * whose agent legitimately needs `~/.aws` would have no way to grant it.
 */
const DEFAULT_MAIN_SANDBOX: SandboxConfig = { allowUnsandboxedFallback: true }

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
    if (ctx.toolNames.has('append_file'))   hints.push('- Append files: use `append_file` tool (NOT echo >>/tee -a)')
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
      // Subscribes this tool to the kernel's command-level guards (absolute-path
      // workspace scan, ~/$HOME/../ escape scan, sensitive-command detection).
      // See ToolPermissionDeclaration.commandField.
      commandField: 'command',
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
        timeout_ms: {
          type: 'number',
          // Rendered at construction time so the number the model sees is the one
          // actually enforced — a hard-coded literal here drifted the moment
          // the cap became derived from timeouts.toolMs.
          description: `Timeout ms. Default: ${Math.min(DEFAULT_TIMEOUT_MS, maxTimeoutMs())}, max: ${maxTimeoutMs()}`,
        },
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
      const limit = getMaxOut()
      // runShellCommand already redacted the streams; this only bounds length.
      const trunc = (s: string) =>
        s.length > limit ? s.slice(0, limit) + `\n[Truncated — ${s.length} bytes]` : s

      // Sandbox handle priority:
      //   1. ctx.sandboxHandle  injected by MetaAgentSession._wrapTool() for main-agent calls
      //   2. sandboxHandle      closure-captured for sub-agent calls (SubAgentRunner path)
      //   3. none               no sandboxing configured
      const activeHandle = ctx.sandboxHandle ?? sandboxHandle

      try {
        const res = await runShellCommand({
          command,
          cwd: rawCwd,
          workspaceRoot: ctx.workspaceRoot,
          // External directories the operator granted in config.json. Without
          // this a granted path would be refused here even though the OS sandbox
          // was configured to allow it.
          allowedRoots: externalRoots(ctx.workspaceRoot),
          timeoutMs,
          signal: ctx.abortSignal,
          envPolicy,
          ...(activeHandle ? { sandboxHandle: activeHandle } : {}),
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
        if (err instanceof ShellCommandRefused) {
          return { content: `Error: ${err.message}`, isError: true }
        }
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        }
      }
    },
  }
}
