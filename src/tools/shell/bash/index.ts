import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, realpathSync } from 'fs'
import { resolve, sep } from 'path'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { dynamicDescription } from '../../util.js'
import type { SandboxHandle } from '../../../sandbox/types.js'

const execFileAsync = promisify(execFile)
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

function isInsideWorkspace(path: string, workspaceRoot = process.cwd()): boolean {
  const workspace = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot)
  const target = existsSync(path) ? realpathSync(path) : resolve(workspace, path)
  return target === workspace || target.startsWith(workspace.endsWith(sep) ? workspace : workspace + sep)
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
}

export async function createBashTool(opts: BashToolOptions = {}): Promise<MetaAgentTool> {
  const { sandboxHandle } = opts
  const envPolicy: ShellEnvPolicy = opts.envPolicy ?? 'filtered'
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
    description,
    permission: {
      category: 'execute',
      cwdField: 'cwd',
      requiresWorkspace: true,
      sensitive: true,
      planMode: 'ask',
      // sandbox: undefined — main agent bash runs unsandboxed for now.
      // Set sandbox: true (or a SandboxConfig) here when ready to enforce
      // OS-level isolation for main-agent shell commands.
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
      const cwd = (input['cwd'] as string | undefined) ?? process.cwd()
      if (!command) return { content: 'Error: command is required', isError: true }
      if (!isInsideWorkspace(cwd, ctx.workspaceRoot)) return { content: `Error: cwd is outside workspace: ${cwd}`, isError: true }
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
        const { stdout, stderr } = await execFileAsync(execSpec.file, execSpec.args, {
          timeout: timeoutMs, cwd, maxBuffer: limit * 2,
          signal: ctx.abortSignal, env: buildShellEnv(envPolicy),
        })
        const parts: string[] = []
        if (stdout) parts.push(trunc(stdout))
        if (stderr) parts.push(`STDERR:\n${trunc(stderr)}`)
        return { content: parts.join('\n') || '(no output)', isError: false }
      } catch (err: unknown) {
        const e = err as { killed?: boolean; stdout?: string; stderr?: string; code?: number; message?: string }
        if (e.killed) {
          // M9: surface any captured output BEFORE the kill so the model can
          // see how far the command got before timing out.
          const parts: string[] = [`Command timed out after ${timeoutMs}ms`]
          if (e.stdout) parts.push(trunc(e.stdout))
          if (e.stderr) parts.push(`STDERR:\n${trunc(e.stderr)}`)
          return { content: parts.join('\n'), isError: true }
        }
        const parts: string[] = []
        if (e.stdout) parts.push(trunc(e.stdout))
        if (e.stderr) parts.push(`STDERR:\n${trunc(e.stderr)}`)
        if (e.code !== undefined) parts.push(`Exit code: ${e.code}`)
        return { content: parts.join('\n') || e.message || String(err), isError: true }
      }
    },
  }
}
