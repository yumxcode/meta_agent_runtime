/**
 * Sub-Agent Task System — core types
 *
 * A sub-agent is an isolated MetaAgentSession spawned by the main agent to
 * handle a long-running or specialised sub-task.  The main agent communicates
 * with it only through this type-safe status/result layer — never through
 * shared conversation history.
 *
 * Design invariants (§9 of docs/architecture/meta-agent-architecture.md):
 *   1. Sub-agent context is fully isolated (empty mutableMessages on start).
 *   2. Main agent only sees the terminal result by default.
 *   3. Circuit breakers (maxTurns, maxBudgetUsd) are enforced in code, not prompt.
 *   4. Human-approval gate is implemented at the tool-handler layer.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Task ID
// ─────────────────────────────────────────────────────────────────────────────

/** Format: `subtask-{uuid8}` */
export type SubAgentTaskId = string

export type SubAgentWorkspaceMode =
  | 'shared_readonly'
  | 'shared_write'
  | 'isolated_write'
  | 'ephemeral_snapshot'

export function makeSubAgentTaskId(): SubAgentTaskId {
  const uuid8 = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  return `subtask-${uuid8}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Status state machine
// ─────────────────────────────────────────────────────────────────────────────

export type SubAgentStatus =
  | 'pending'    // created, not yet started
  | 'queued'     // waiting for the bridge scheduler to start it
  | 'running'    // MetaAgentSession is active
  | 'completed'  // finished successfully (may still await human approval)
  | 'failed'     // circuit-breaker or unhandled error
  | 'cancelled'  // aborted by cancel_sub_agent or parent AbortSignal

export const TERMINAL_STATUSES = new Set<SubAgentStatus>([
  'completed', 'failed', 'cancelled',
])

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface SubAgentConfig {
  // ── Task ──────────────────────────────────────────────────────────────────
  /** Injected as the first user message in the isolated sub-agent session. */
  taskDescription: string
  /** Sub-agent system prompt.  Defaults to DEFAULT_SYSTEM_PROMPT when omitted. */
  systemPrompt?: string
  /**
   * Names of tools the sub-agent may call.  The SubAgentRunner looks these up
   * in the tool registry passed at spawn time.  When omitted the sub-agent
   * runs in pure-reasoning mode (no tools).
   */
  allowedTools?: string[]

  // ── Circuit breakers ──────────────────────────────────────────────────────
  /** Maximum conversation turns before the sub-agent is force-stopped.  Default: 10 */
  maxTurns: number
  /** Maximum cost in USD before the sub-agent is force-stopped.  Default: 0.5 */
  maxBudgetUsd: number
  /**
   * Maximum wall-clock duration in ms before the sub-agent is force-stopped.
   * Default: 300_000 (5 min). 0 disables the cap. On timeout the runner
   * interrupts the inner session and writes a terminal 'failed' state.
   */
  maxDurationMs?: number

  // ── Notification mode ─────────────────────────────────────────────────────
  /**
   * When true (default): completion events are published to CampaignEventBus
   * and queued as pending notifications for the parent session's next submit().
   * When false: the parent must poll via get_sub_agent_status.
   */
  useEventDriven: boolean
  /**
   * Poll interval in ms — only relevant when useEventDriven=false.
   * Default: 1_800_000 (30 minutes).
   */
  pollIntervalMs: number

  // ── Human-in-the-loop ─────────────────────────────────────────────────────
  /**
   * When true: completion sets pendingHumanApproval=true on the record.
   * The main agent MUST present the result to the user and wait for explicit
   * confirmation before proceeding.  Default: false.
   */
  requireHumanApproval: boolean

  // ── Checkpointing ─────────────────────────────────────────────────────────
  /**
   * Save the latest turn text as a checkpoint every N turns.
   * The main agent can retrieve it via get_sub_agent_intermediate.
   * Default: 3.  Set to 0 to disable checkpointing.
   */
  checkpointEveryNTurns: number

  // ── Provider credentials (forwarded from parent session) ──────────────────
  /**
   * API key forwarded from the parent session.
   * When omitted the sub-agent runner resolves from env vars
   * (ZHIPU_API_KEY → DEEPSEEK_API_KEY → QWEN_API_KEY → ANTHROPIC_API_KEY in priority order).
   */
  apiKey?: string
  /** Provider base URL forwarded from the parent session. */
  baseURL?: string
  /** Model name forwarded from the parent session. */
  model?: string
  /** Fallback model forwarded from the parent session. */
  fallbackModel?: string

  // ── Sandbox ───────────────────────────────────────────────────────────────
  /**
   * Sandbox policy for bash commands executed by this sub-agent.
   *
   * When set, every bash call is wrapped with the platform-appropriate
   * sandboxing tool (sandbox-exec on macOS, bwrap on Linux).
   *
   * When omitted (default), bash commands run without any OS-level isolation.
   * The sub-agent still has logical isolation (circuit breakers, allowedTools)
   * but no filesystem or network enforcement at the kernel level.
   *
   * Example — restrict writes to workspace only, deny network:
   *   sandbox: { network: 'none' }
   *
   * Example — also allow writing to /tmp/artifacts:
   *   sandbox: { writeAllowPaths: ['/tmp/artifacts'], network: 'none' }
   */
  sandbox?: import('../sandbox/types.js').SandboxConfig

  // ── Autonomy (auto mode) ──────────────────────────────────────────────────
  /**
   * Autonomy profile forwarded to the sub-agent's own permission policy, so the
   * workspace jail and auto-approve posture extend transitively to sub-agents.
   * Set by SubAgentBridge when the parent is in auto mode — closes the
   * "run_agent sub-agent escapes the jail" hole.
   */
  autonomy?: import('../core/types.js').AutonomyProfile
  /**
   * Project working directory for the sub-agent (its workspace jail root and
   * sandbox writable root). When the parent is in auto mode this is set to the
   * jail root (or the per-task git worktree). Defaults to process.cwd().
   */
  projectDir?: string

  /**
   * Declares how the task uses its workspace. Only `isolated_write` allocates
   * a durable task worktree and enters the finalize/merge lifecycle.
   */
  workspaceMode?: SubAgentWorkspaceMode

  /**
   * Auto mode retry bookkeeping: how many times this task has already been
   * retried (0 on first dispatch). Incremented on each automatic re-spawn.
   * Internal — callers don't set this.
   */
  retryCount?: number

  /**
   * Auto mode: when true AND the parent armed an AutoWorktreeCoordinator over a
   * git workspace, the sub-agent runs in its OWN git worktree+branch so its
   * writes cannot race other concurrent sub-agents. The main agent merges the
   * branch back serially via the auto worktree tools. Opt-in: read-only / report
   * sub-agents (e.g. research_dispatch) leave this unset and share the tree
   * (protected by the write mutex). Default: false.
   */
  isolateWorktree?: boolean

  /**
   * Internal infrastructure sub-agent — used by the auto-mode SAFETY GATES
   * (verify judge, drift reflection) which run as sub-agents but must never be
   * starved by ordinary research/worker sub-agents that share the bridge.
   *
   * When true the bridge gives this task a reserved "side lane":
   *   - it bypasses the per-bridge total-budget cap (so research spend can never
   *     silently disable the completion gate — the documented failure mode), and
   *     its cost is NOT counted toward that cap;
   *   - it bypasses the outstanding-tasks (queue-full) cap; and
   *   - it is enqueued at the FRONT of the start queue for priority.
   * It still respects maxConcurrent and all per-task circuit breakers.
   *
   * Internal only — ordinary callers leave this unset. Default: false.
   */
  internal?: boolean
}

/** Defaults applied by SubAgentBridge.spawnSubAgent() */
export const DEFAULT_SUB_AGENT_CONFIG: Omit<SubAgentConfig, 'taskDescription'> = {
  systemPrompt:            undefined,
  allowedTools:            undefined,
  maxTurns:                10,
  maxBudgetUsd:            0.5,
  maxDurationMs:           300_000,
  useEventDriven:          true,
  pollIntervalMs:          1_800_000,
  requireHumanApproval:    false,
  checkpointEveryNTurns:   3,
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress state (structured mid-task and terminal progress data)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured progress snapshot for a sub-agent task.
 *
 * Allows the parent agent to understand what the sub-agent accomplished without
 * having to parse the free-text summary.  Populated by SubAgentRunner at the
 * result event; also saved to checkpoints so the parent can inspect progress
 * mid-run via get_sub_agent_intermediate.
 *
 * Design: extraction is best-effort and regex-based.  Fields that cannot be
 * determined are left as empty arrays / 0.  The parent must never treat these
 * as authoritative — use them as orientation cues, not ground truth.
 */
export interface SubAgentProgressState {
  /**
   * Number of tool-call rounds completed (proxy for "steps done").
   * Derived from tool_result event count in the agentic loop.
   */
  toolCallsCompleted: number
  /**
   * Provenance IDs (prov-xxxxxxxx) found in the accumulated output text.
   * Enables the parent to call get_provenance() on sub-agent results.
   */
  provenanceIds: string[]
  /**
   * Estimated number of numbered steps completed by the sub-agent.
   * Heuristic: counts "Step N:" / "## Step N" / "**Step N**" patterns.
   * 0 when the sub-agent did not use step markers.
   */
  stepsCompleted: number
  /**
   * Last checkpoint text captured before the terminal state.
   * Mirrors SubAgentRecord.latestCheckpoint but included in the result
   * so it is available in the SubAgentCompletedEvent without a disk read.
   */
  lastCheckpoint?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

export interface SubAgentResult {
  success: boolean
  /**
   * Plain-text summary — the last accumulated text from the sub-agent session.
   * Truncated to 2000 characters when stored.
   */
  summary: string
  /** Structured output if the sub-agent emitted one (tool_result or JSON block). */
  output?: unknown
  /** Error message when success=false. */
  error?: string
  turnsUsed: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  durationMs: number
  /**
   * Structured progress state — populated by SubAgentRunner at terminal time.
   * Optional for backward compatibility with records written by older versions.
   */
  progressState?: SubAgentProgressState
}

// ─────────────────────────────────────────────────────────────────────────────
// Persisted record (stored at ~/.meta-agent/subtasks/<taskId>.json)
// ─────────────────────────────────────────────────────────────────────────────

export interface SubAgentRecord {
  schemaVersion: '1.0'
  taskId: SubAgentTaskId
  parentSessionId: string
  status: SubAgentStatus
  config: SubAgentConfig
  createdAt: number        // epoch ms
  startedAt?: number
  completedAt?: number
  result?: SubAgentResult
  /** Latest checkpoint text (updated every checkpointEveryNTurns turns). */
  latestCheckpoint?: string
  latestCheckpointAt?: number
  /**
   * When requireHumanApproval=true and status=completed, this flag is true
   * until the main agent confirms it has presented the result to the user.
   * The main agent clears it by calling approve_sub_agent_result (or by
   * natural language — the tool checks this field before allowing continuation).
   */
  pendingHumanApproval: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// CampaignEventBus event map
// ─────────────────────────────────────────────────────────────────────────────

export interface SubAgentCompletedEvent {
  taskId: SubAgentTaskId
  parentSessionId: string
  result: SubAgentResult
}

export interface SubAgentFailedEvent {
  taskId: SubAgentTaskId
  parentSessionId: string
  error: string
}

export interface SubAgentCheckpointEvent {
  taskId: SubAgentTaskId
  parentSessionId: string
  checkpoint: string
  turnNumber: number
}

export interface PhaseTransitionedEvent {
  campaignId: string
  fromPhase: string
  toPhase: string
  triggeredBy: string
}

/** Full event map for CampaignEventBus */
export interface CampaignEventMap {
  'subagent:completed':    SubAgentCompletedEvent
  'subagent:failed':       SubAgentFailedEvent
  'subagent:checkpoint':   SubAgentCheckpointEvent
  'phase:transitioned':    PhaseTransitionedEvent
}
