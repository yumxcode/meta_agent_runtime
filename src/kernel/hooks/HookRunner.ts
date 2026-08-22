/**
 * HookRunner — matches hooks to an event, runs them, folds their answers.
 *
 * Every hook invocation is an external process, so it goes through
 * `runShellCommand`: the same cwd jail, credential-filtered env, OS sandbox and
 * output redaction that every other model-adjacent shell execution gets. A hook
 * is configuration, and configuration can arrive from a checked-in repo file —
 * treating it as trusted because "the user configured it" is exactly how a
 * committed `.meta-agent/config.json` turns into arbitrary execution.
 */

import type {
  HookDecision,
  HookDefinition,
  HookEventName,
  HookOutcome,
  HookPayload,
  HooksConfig,
} from './types.js'
import {
  DECIDING_HOOK_EVENTS,
  EMPTY_HOOK_OUTCOME,
  HOOK_DEFAULT_TIMEOUT_MS,
  HOOK_MAX_TIMEOUT_MS,
  INJECTING_HOOK_EVENTS,
} from './types.js'
import { EVENT_SCHEMA_VERSION } from '../events/schema.js'
import { runShellCommand, ShellCommandRefused } from '../../infra/exec/runShellCommand.js'

export interface HookRunnerOptions {
  config: HooksConfig | undefined
  workspaceRoot?: string
  /** Injectable for tests; production runs the real shell. */
  exec?: (definition: HookDefinition, payload: HookPayload, signal: AbortSignal)
    => Promise<{ stdout: string; failed: boolean; error?: string }>
}

/**
 * Does `definition` apply to `toolName`?
 *
 * Supports exact match and a single trailing `*`. Deliberately not a full glob
 * or a regex: a matcher powerful enough to be subtly wrong is a matcher that
 * silently stops firing, and a hook that silently stops firing is the failure
 * mode an audit hook cannot afford.
 */
export function hookMatchesTool(definition: HookDefinition, toolName: string | undefined): boolean {
  if (!definition.matchTool) return true
  if (toolName === undefined) return false
  if (definition.matchTool.endsWith('*')) {
    return toolName.startsWith(definition.matchTool.slice(0, -1))
  }
  return definition.matchTool === toolName
}

/**
 * Parse a hook's stdout into a decision.
 *
 * Empty output is a no-op, not an error: the overwhelmingly common hook is an
 * observer that logs a line and says nothing. Requiring `{}` from those would
 * make the simplest useful hook the one most likely to be written wrong.
 *
 * Junk output IS an error — it means the hook tried to say something and the
 * runtime could not hear it, which for a deny is the difference between
 * blocking an operation and silently permitting it.
 */
export function parseHookDecision(stdout: string): { decision: HookDecision } | { error: string } {
  const trimmed = stdout.trim()
  if (!trimmed) return { decision: {} }
  // A hook may print progress before its JSON; take the last JSON object so a
  // `set -x` or an echoed banner does not invalidate the decision.
  const start = trimmed.lastIndexOf('{')
  if (start === -1) return { error: `hook output is not JSON: ${truncate(trimmed)}` }
  try {
    const parsed = JSON.parse(trimmed.slice(start)) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return { error: `hook output is not a JSON object: ${truncate(trimmed)}` }
    }
    const raw = parsed as Record<string, unknown>
    const decision: HookDecision = {}
    if (raw['deny'] === true) decision.deny = true
    if (typeof raw['reason'] === 'string') decision.reason = raw['reason']
    if (typeof raw['inject'] === 'string') decision.inject = raw['inject']
    return { decision }
  } catch {
    return { error: `hook output is not valid JSON: ${truncate(trimmed)}` }
  }
}

function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

export class HookRunner {
  constructor(private readonly options: HookRunnerOptions) {}

  /** Hooks registered for `event`, filtered by tool matcher, in config order. */
  private matching(event: HookEventName, toolName?: string): HookDefinition[] {
    const all = this.options.config?.hooks ?? []
    return all.filter(h => h.event === event && hookMatchesTool(h, toolName))
  }

  /** True when nothing is registered — lets callers skip building a payload. */
  has(event: HookEventName, toolName?: string): boolean {
    return this.matching(event, toolName).length > 0
  }

  /**
   * Run every hook for `event` and fold the answers.
   *
   * Sequential, not parallel: hooks are a veto chain and the FIRST denial is
   * the one reported, which requires a defined order. Parallelism would also
   * multiply the process count at exactly the moment (a tool batch) when the
   * runtime is already busiest.
   */
  async run(
    event: HookEventName,
    payload: Omit<HookPayload, 'schemaVersion' | 'event' | 'ts'>,
    signal: AbortSignal,
  ): Promise<HookOutcome> {
    const definitions = this.matching(event, payload.toolName)
    if (definitions.length === 0) return EMPTY_HOOK_OUTCOME

    const full: HookPayload = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      event,
      ts: Date.now(),
      ...payload,
    }

    const canDecide = DECIDING_HOOK_EVENTS.has(event)
    const canInject = INJECTING_HOOK_EVENTS.has(event)
    const inject: string[] = []
    const errors: string[] = []

    for (const definition of definitions) {
      const result = await this.invoke(definition, full, signal)

      if (result.failed) {
        errors.push(`hook "${definition.command}" failed: ${result.error ?? 'unknown error'}`)
        // Only a DECIDING event has a decision to fail toward. An observer that
        // crashes has already missed its chance to observe; denying the user's
        // work over it would be punishing the wrong party.
        if (canDecide && definition.onFailure === 'closed') {
          return {
            denied: true,
            reason: `hook failed and is configured fail-closed: ${result.error ?? 'unknown error'}`,
            inject,
            errors,
          }
        }
        continue
      }

      const parsed = parseHookDecision(result.stdout)
      if ('error' in parsed) {
        errors.push(`hook "${definition.command}": ${parsed.error}`)
        if (canDecide && definition.onFailure === 'closed') {
          return { denied: true, reason: `hook returned unreadable output`, inject, errors }
        }
        continue
      }

      const { decision } = parsed
      // `deny` is honoured ONLY for deciding events. A post_tool_use hook
      // denying an effect that already happened would be theatre, and honouring
      // it would imply a rollback the runtime cannot perform.
      if (decision.deny && canDecide) {
        return {
          denied: true,
          reason: decision.reason ?? `denied by hook: ${definition.command}`,
          inject,
          errors,
        }
      }
      if (decision.inject && canInject) inject.push(decision.inject)
    }

    return { denied: false, inject, errors }
  }

  /** Execute one hook, capturing stdout. Never throws. */
  private async invoke(
    definition: HookDefinition,
    payload: HookPayload,
    signal: AbortSignal,
  ): Promise<{ stdout: string; failed: boolean; error?: string }> {
    if (this.options.exec) {
      try {
        return await this.options.exec(definition, payload, signal)
      } catch (err) {
        return { stdout: '', failed: true, error: err instanceof Error ? err.message : String(err) }
      }
    }

    const timeoutMs = Math.min(
      HOOK_MAX_TIMEOUT_MS,
      Math.max(100, definition.timeoutMs ?? HOOK_DEFAULT_TIMEOUT_MS),
    )
    // The payload reaches the hook on stdin via a heredoc rather than as an
    // argv element: a tool input can be megabytes and contain anything, and
    // interpolating it into a command line would be both a length limit and an
    // injection surface.
    const json = JSON.stringify(payload)
    const command = `${definition.command} <<'META_AGENT_HOOK_EOF'\n${json}\nMETA_AGENT_HOOK_EOF`

    try {
      const res = await runShellCommand({
        command,
        cwd: this.options.workspaceRoot ?? process.cwd(),
        ...(this.options.workspaceRoot ? { workspaceRoot: this.options.workspaceRoot } : {}),
        timeoutMs,
        signal,
        envPolicy: 'filtered',
        captureLimit: 64 * 1024,
      })
      if (res.timedOut) {
        return { stdout: '', failed: true, error: `timed out after ${timeoutMs}ms` }
      }
      if (res.aborted) return { stdout: '', failed: true, error: 'aborted' }
      if (res.code !== 0) {
        // A non-zero exit is a FAILURE, not a deny. Conflating them would make
        // every `set -e` mishap in a hook script look like a deliberate veto.
        return {
          stdout: res.stdout,
          failed: true,
          error: `exited with code ${res.code}${res.stderr ? `: ${truncate(res.stderr)}` : ''}`,
        }
      }
      return { stdout: res.stdout, failed: false }
    } catch (err) {
      if (err instanceof ShellCommandRefused) {
        return { stdout: '', failed: true, error: `refused: ${err.message}` }
      }
      return { stdout: '', failed: true, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

/**
 * Build a runner, or null when no hooks are configured.
 *
 * Null rather than an empty runner so the call sites stay a nullish check —
 * hooks are off for almost every session and must cost nothing when they are.
 */
export function createHookRunner(
  config: HooksConfig | undefined,
  workspaceRoot?: string,
): HookRunner | null {
  if (!config?.hooks?.length) return null
  return new HookRunner({ config, ...(workspaceRoot ? { workspaceRoot } : {}) })
}
