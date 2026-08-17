import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { createCronJob } from '../cronStore.js'
import { runShellCommand, ShellCommandRefused } from '../../../infra/exec/runShellCommand.js'
import { resolveSandboxPolicy } from '../../../sandbox/sandboxPolicyConfig.js'
import { RuntimeEnv } from '../../../infra/env/RuntimeEnv.js'

const CRON_COMMAND_TIMEOUT_MS = 30_000
const CRON_CAPTURE_LIMIT = 8 * 1024

/**
 * cron_create — schedule a command to run on a recurring tick.
 *
 * SECURITY NOTE (this tool used to be a complete sandbox bypass)
 * -------------------------------------------------------------
 * The previous implementation built its callback like this:
 *
 *   const execFileAsync = promisify(execFile)
 *   callback = async () => { await execFileAsync('bash', ['-c', command], …) }
 *
 * which meant a model-supplied string reached a shell with:
 *   - the FULL process.env (every provider key, AWS credentials, GITHUB_TOKEN),
 *     because execFile inherits by default and this path never called
 *     buildChildEnv();
 *   - no OS sandbox — ctx.sandboxHandle was never consulted;
 *   - no workspace-jailed cwd — it ran wherever the process happened to be;
 *   - no approval prompt and no path scanning, because the tool declared no
 *     `permission` block and the kernel's command guards were gated on
 *     `tool.name === 'bash'`;
 *   - no output redaction;
 *   - and it ran REPEATEDLY, on a timer, long after the turn that created it.
 *
 * Every one of those controls existed and worked for the `bash` tool. None of
 * them applied here, purely because this code path did not go through the place
 * where they live. So it goes through it now: `runShellCommand` is the single
 * hardened entry point, and the `permission` block below subscribes this tool to
 * the kernel's command-level guards via `commandField`.
 *
 * The tool remains in AUTO_DENIED_TOOL_NAMES for unattended modes: a scheduled
 * command outlives the turn that authorised it, which is a poor fit for a run
 * with nobody watching.
 */
export async function createCronCreateTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'cron_create',
    description,
    permission: {
      category: 'execute',
      // Subscribes to the absolute-path workspace scan, the ~/$HOME/../ escape
      // scan, and sensitive-command detection — the same guards `bash` gets.
      commandField: 'command',
      requiresWorkspace: true,
      sensitive: true,
      planMode: 'ask',
      // Scheduled commands are sandboxed exactly like interactive ones. The
      // operator's config.json `sandbox.*` policy (external read/write grants,
      // credential deny list, network) is merged in by ToolRuntimeGuards.
      sandbox: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'Cron expression (6 fields: second minute hour dom month dow). E.g. "0 */5 * * * *" = every 5 minutes.',
        },
        description: {
          type: 'string',
          description: 'Human-readable description of what this job does.',
        },
        command: {
          type: 'string',
          description:
            '(Optional) Shell command to run on each tick. Runs under the same ' +
            'workspace jail, credential filter and OS sandbox as the bash tool.',
        },
      },
      required: ['expression', 'description'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const expression = String(input['expression'] ?? '').trim()
      const desc = String(input['description'] ?? '').trim()
      const command = input['command'] ? String(input['command']) : undefined

      if (!expression) return { content: 'Error: expression is required', isError: true }
      if (!desc) return { content: 'Error: description is required', isError: true }

      // Capture the session's execution context ONCE, at authorisation time.
      //
      // The tick fires long after this call returns, when there is no live
      // ToolCallContext to read. Resolving the jail, the grants and the sandbox
      // handle now — and closing over them — means the scheduled command runs
      // under exactly the policy that was in force when a human (or the plan-mode
      // gate) approved it. Re-resolving at tick time would let a later config
      // change silently widen a job that was approved under a narrower policy.
      const workspaceRoot = ctx.workspaceRoot
      const allowedRoots = resolveSandboxPolicy(workspaceRoot).allowedRoots
      const sandboxHandle = ctx.sandboxHandle
      const captureLimit = RuntimeEnv.maxToolOutputChars(CRON_CAPTURE_LIMIT)

      try {
        let callback: () => void | Promise<void>

        if (command) {
          callback = async () => {
            try {
              const res = await runShellCommand({
                command,
                cwd: workspaceRoot ?? process.cwd(),
                ...(workspaceRoot ? { workspaceRoot } : {}),
                allowedRoots,
                timeoutMs: CRON_COMMAND_TIMEOUT_MS,
                // Each tick gets a fresh signal: the turn's AbortSignal is long
                // dead by the time the job fires, and reusing it would abort
                // every run instantly.
                signal: AbortSignal.timeout(CRON_COMMAND_TIMEOUT_MS),
                envPolicy: 'filtered',
                ...(sandboxHandle ? { sandboxHandle } : {}),
                captureLimit,
              })
              if (res.code !== 0 && !res.timedOut) {
                process.stderr.write(
                  `[meta-agent/cron] "${desc}" exited ${res.code ?? 'unknown'}: ` +
                  `${res.stderr.slice(0, 500) || res.stdout.slice(0, 500)}\n`,
                )
              }
            } catch (err) {
              // A refusal (jail violation) or spawn failure must be visible —
              // a silently dead scheduled job is worse than a noisy one — but it
              // must not propagate: cronStore swallows callback errors, and a
              // throw here would be lost entirely.
              process.stderr.write(
                `[meta-agent/cron] "${desc}" failed: ` +
                `${err instanceof Error ? err.message : String(err)}\n`,
              )
            }
          }
        } else {
          callback = () => { /* no-op tick */ }
        }

        const job = createCronJob(expression, desc, ctx.sessionId, callback)
        return {
          content: JSON.stringify({
            job_id: job.id,
            expression: job.expression,
            description: job.description,
            created_at: job.createdAt.toISOString(),
            message: `Cron job scheduled. Use cron_delete with id "${job.id}" to cancel.`,
          }, null, 2),
          isError: false,
        }
      } catch (err) {
        if (err instanceof ShellCommandRefused) {
          return { content: `Error: ${err.message}`, isError: true }
        }
        return {
          content: `Error creating cron job: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  }
}
