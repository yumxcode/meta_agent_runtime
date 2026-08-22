/**
 * External lifecycle hooks — the extension point that does not require writing
 * TypeScript.
 *
 * Why this exists alongside PhaseHooks
 * ------------------------------------
 * `PhaseHooks` is an in-process TS callback with four transition points and two
 * possible actions. It is the right shape for what it does — the auto
 * orchestrator injects itself through it — and it stays. But it is reachable
 * only by an embedder who imports the runtime as a library and compiles against
 * it. Someone using the CLI cannot extend the runtime at all without forking it.
 *
 * That is the gap this closes: a JSON contract over stdin/stdout, configured in
 * a file, so "log every shell command to an audit file" or "refuse to touch
 * anything under /etc" is a config change rather than a code change.
 *
 * The composition rule (the important part)
 * -----------------------------------------
 * Hooks that can affect a permission decision may only ever **tighten** it.
 * A hook runs AFTER the built-in policy has allowed something and can turn that
 * allow into a deny; it can never turn a deny into an allow. Two reasons, and
 * both matter:
 *
 *   1. A config file that can grant capability is a privilege-escalation
 *      primitive: anything that can write it (a malicious repo's committed
 *      `.meta-agent/config.json`, a compromised dependency's postinstall) gains
 *      the ability to unlock the workspace jail.
 *   2. The permission policy's denials are the ones with a security argument
 *      behind them — path containment, the autonomy capability boundary. A hook
 *      overriding those would silently move the security boundary into a
 *      user-supplied shell script.
 *
 * So hooks are a veto, never a grant. `HookDecision` has no `allow` variant on
 * purpose — the type makes the escalation unrepresentable rather than merely
 * discouraged.
 */

/**
 * When a hook fires.
 *
 * Named for the transition, not the subsystem, so the set reads as a lifecycle
 * a reader can follow top to bottom.
 */
export type HookEventName =
  /** A session began. Fires once, before the first prompt is processed. */
  | 'session_start'
  /** A user message was accepted, before the model sees it. May inject context. */
  | 'user_prompt_submit'
  /** A tool is about to run, after the permission policy allowed it. May deny. */
  | 'pre_tool_use'
  /** A tool finished. Observe only — the effect already happened. */
  | 'post_tool_use'
  /** The policy is asking for approval. May deny; may not approve. */
  | 'permission_request'
  /** Compaction is about to run. Observe only. */
  | 'pre_compact'
  /** Compaction finished. Observe only. */
  | 'post_compact'
  /** The run reached a terminal result. Observe only. */
  | 'stop'
  /** The session is being disposed. Fires once. Observe only. */
  | 'session_end'

export const HOOK_EVENT_NAMES: readonly HookEventName[] = [
  'session_start',
  'user_prompt_submit',
  'pre_tool_use',
  'post_tool_use',
  'permission_request',
  'pre_compact',
  'post_compact',
  'stop',
  'session_end',
]

/** Events whose decision the kernel acts on. All others are observe-only. */
export const DECIDING_HOOK_EVENTS: ReadonlySet<HookEventName> = new Set([
  'pre_tool_use',
  'permission_request',
])

/** Events that may contribute extra context to the conversation. */
export const INJECTING_HOOK_EVENTS: ReadonlySet<HookEventName> = new Set([
  'user_prompt_submit',
])

/**
 * What the hook receives on stdin, as JSON.
 *
 * Deliberately flat and self-describing: the consumer is often a five-line
 * shell script with `jq`, not a typed client. Every payload carries the event
 * name and session id so one script can serve several hooks.
 */
export interface HookPayload {
  /** Contract version — see kernel/events/schema.ts for the versioning rule. */
  schemaVersion: string
  event: HookEventName
  sessionId: string
  ts: number
  /** Workspace root, so a hook can resolve relative paths. */
  workspaceRoot?: string
  /** Tool name, for the tool-related events. */
  toolName?: string
  /** Tool input, for pre_tool_use / permission_request. */
  toolInput?: unknown
  /** Tool result text, for post_tool_use. */
  toolResult?: { content: string; isError: boolean }
  /** The user's message, for user_prompt_submit. */
  prompt?: string
  /** Why approval is being requested, for permission_request. */
  reason?: string
  /** Terminal result subtype, for stop. */
  outcome?: string
}

/**
 * What the hook writes to stdout, as JSON. An empty stdout is a valid no-op.
 *
 * Note the absence of `allow`. See the composition rule in the module header:
 * a hook is a veto, and the type is what enforces it.
 */
export interface HookDecision {
  /** Deny the operation. Ignored for observe-only events. */
  deny?: boolean
  /** Why — surfaced to the model and to the user. Required when denying. */
  reason?: string
  /**
   * Extra context to add to the conversation. Only honoured for
   * `user_prompt_submit`; ignored elsewhere so a post-hoc hook cannot silently
   * rewrite history.
   */
  inject?: string
}

/** One configured hook. */
export interface HookDefinition {
  /** Which lifecycle event this fires on. */
  event: HookEventName
  /**
   * Shell command. Receives the payload on stdin; may write a decision to
   * stdout. Runs through the same guard stack as any other shell execution.
   */
  command: string
  /**
   * Only fire when the tool name matches. Exact match, or `*` suffix for a
   * prefix match (`mcp_*`). Absent = every tool. Ignored for non-tool events.
   */
  matchTool?: string
  /** Per-invocation wall-clock cap. Default 5000ms, hard ceiling 60000ms. */
  timeoutMs?: number
  /**
   * What a hook failure means for a DECIDING event.
   *
   * `open` (default): a broken hook is ignored and the operation proceeds.
   * `closed`: a broken hook denies. Choose this when the hook IS the control —
   * an audit hook that fails silently is an audit hook that is not running.
   *
   * Observe-only events ignore this: there is no decision to fail toward.
   */
  onFailure?: 'open' | 'closed'
}

export interface HooksConfig {
  /** Hook definitions, evaluated in order. Absent/empty = no hooks run. */
  hooks?: HookDefinition[]
  /**
   * Ignore hooks from project/user config and honour only those supplied
   * programmatically by the host.
   *
   * The escape hatch for a team that distributes a managed configuration and
   * must not let a checked-in repo file add execution to every session. Mirrors
   * the intent of codex's `allow_managed_hooks_only`.
   */
  managedOnly?: boolean
}

/** Outcome of running every hook registered for one event. */
export interface HookOutcome {
  /** True when at least one hook denied. */
  denied: boolean
  /** Reason from the first denying hook. */
  reason?: string
  /** Concatenated injections, in hook order. */
  inject: string[]
  /** Diagnostics: hooks that failed to run or returned junk. */
  errors: string[]
}

export const EMPTY_HOOK_OUTCOME: HookOutcome = Object.freeze({
  denied: false,
  inject: [],
  errors: [],
})

/** Default and ceiling for a single hook invocation. */
export const HOOK_DEFAULT_TIMEOUT_MS = 5_000
export const HOOK_MAX_TIMEOUT_MS = 60_000
