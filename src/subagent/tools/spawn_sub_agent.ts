/**
 * spawn_sub_agent — tool for the main agent to delegate a sub-task
 *
 * Returns immediately with a taskId.  The sub-agent runs asynchronously.
 * The main agent will be notified on completion via the D-SubAgent
 * dynamic prompt section (event-driven) or by polling get_sub_agent_status.
 */

import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../core/types.js'
import type { SubAgentBridge } from '../SubAgentBridge.js'
import { withReturnResultHint } from './return_result.js'

export function makeSpawnSubAgentTool(bridge: SubAgentBridge): MetaAgentTool {
  return {
    name: 'spawn_sub_agent',
    abortSupport: 'cooperative',
    // Enqueue-only: this call writes a queued task record and returns immediately
    // without touching the workspace, so issuing several in ONE turn is safe and
    // SHOULD run as a parallel batch. The actual sub-agents then run concurrently
    // in the background (bounded by the bridge's maxConcurrent).
    isConcurrencySafe: true,
    description: `Delegate a sub-task to an isolated sub-agent — ASYNCHRONOUS (parallel) delegation.

Returns IMMEDIATELY with a task_id; the sub-agent runs in the background. To fan out
work in parallel, issue SEVERAL spawn_sub_agent calls in the same turn — they run
concurrently. You are NOT blocked: continue with other work, and you will be notified
on completion via a "Sub-Agent Notifications" section at the top of a later system
prompt (event-driven), or poll get_sub_agent_status. Retrieve the full result with
get_sub_agent_status(task_id).

The sub-agent has its OWN empty conversation context (it does NOT inherit this
session's history) — put everything it needs into task_description.

WHEN TO USE (async / parallel):
- Independent sub-tasks that can run at the same time (e.g., research 3 options at once)
- Long-running work you want to overlap with other work
- Tasks whose failure should NOT block your main flow

WHEN NOT TO USE — use run_agent (synchronous) instead when:
- The very next step depends on this result (you must wait for it)
- The sub-tasks have a strict order / data dependency between them
Or do it inline when it is short (< 3 turns).

ISOLATION: defaults to shared_readonly (safe for concurrent reads/analysis). For a
task that WRITES files, you MUST pass workspace_mode="isolated_write" so it runs in
its own git branch (merge afterwards) — concurrent shared writes are NOT allowed and
would corrupt the tree.`,

    inputSchema: {
      type: 'object' as const,
      properties: {
        task_description: {
          type: 'string',
          description: 'Natural-language description of the sub-task. ' +
            'This is injected as the first user message in the sub-agent session. ' +
            'Be specific — include all context the sub-agent needs (it cannot see your history).',
        },
        system_prompt: {
          type: 'string',
          description: '(Optional) System prompt for the sub-agent. ' +
            'If omitted, the default engineering assistant prompt is used.',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: '(Optional) Names of tools the sub-agent may use. ' +
            'If omitted, the sub-agent runs in pure-reasoning mode (no tools).',
        },
        max_turns: {
          type: 'number',
          description: 'Maximum conversation turns before force-stop. Default: 10.',
        },
        max_budget_usd: {
          type: 'number',
          description: 'Maximum cost in USD before force-stop. Default: 0.5.',
        },
        workspace_mode: {
          type: 'string',
          enum: ['shared_readonly', 'isolated_write'],
          description:
            'shared_readonly (DEFAULT): the sub-agent may read the workspace but not write it — ' +
            'safe to run many in parallel. Use for research, analysis, inspection. ' +
            'isolated_write: the sub-agent gets its OWN git worktree+branch for code-producing ' +
            'tasks; you merge the branch afterwards (auto_merge_subagent). Required for ANY task ' +
            'that writes files. Concurrent shared writes are intentionally not offered here — ' +
            'for a single in-place write that must block, use run_agent instead.',
        },
        require_human_approval: {
          type: 'boolean',
          description: 'If true, you MUST present the result to the user and wait ' +
            'for explicit confirmation before proceeding. Default: false.',
        },
        use_event_driven: {
          type: 'boolean',
          description: 'If true (default), you will be notified automatically on completion. ' +
            'If false, you must poll with get_sub_agent_status every ~30 minutes.',
        },
        poll_interval_ms: {
          type: 'number',
          description: 'Poll interval in ms — only relevant when use_event_driven=false. ' +
            'Default: 1800000 (30 minutes).',
        },
        checkpoint_every_n_turns: {
          type: 'number',
          description: 'Save a checkpoint every N turns (for get_sub_agent_intermediate). ' +
            'Default: 3. Set to 0 to disable.',
        },
        sandbox: {
          type: 'object',
          description:
            '(Optional) OS-level sandbox policy for bash commands in this sub-agent. ' +
            'When set, bash is wrapped with sandbox-exec (macOS) or bwrap (Linux). ' +
            'When omitted, bash runs without OS-level isolation (logical isolation still applies).',
          properties: {
            write_allow_paths: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Extra absolute paths the sub-agent may write to, in addition to its workspace root. ' +
                'Example: ["/tmp/artifacts", "/data/output"]',
            },
            read_deny_paths: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Absolute paths the sub-agent may NOT read. ' +
                'Useful for hiding secrets or sibling project directories. ' +
                'Example: ["~/.ssh", "~/.aws"]',
            },
            network: {
              type: 'string',
              enum: ['none', 'unrestricted'],
              description:
                '"none" — unshare the network namespace (no outbound connections). ' +
                '"unrestricted" — inherit parent network access (default).',
            },
            command_timeout_ms: {
              type: 'number',
              description:
                'Per-command timeout override in ms (max 120000). ' +
                'Overrides the bash tool default of 30000 ms.',
            },
          },
          additionalProperties: false,
        },
      },
      required: ['task_description'],
    },

    async call(
      input: Record<string, unknown>,
      ctx: ToolCallContext,
    ): Promise<ToolResult> {
      const taskDescription = String(input['task_description'] ?? '')
      if (!taskDescription.trim()) {
        return { content: 'Error: task_description is required and must not be empty', isError: true }
      }

      try {
        // Parse optional sandbox config from input
        const sandboxInput = input['sandbox'] as Record<string, unknown> | undefined
        const sandboxConfig = sandboxInput
          ? {
              writeAllowPaths:  sandboxInput['write_allow_paths'] as string[] | undefined,
              readDenyPaths:    sandboxInput['read_deny_paths']   as string[] | undefined,
              network:          sandboxInput['network']           as 'none' | 'unrestricted' | undefined,
              commandTimeoutMs: typeof sandboxInput['command_timeout_ms'] === 'number'
                ? sandboxInput['command_timeout_ms']
                : undefined,
            }
          : undefined

        const record = await bridge.spawnSubAgent({
          config: {
            taskDescription:       withReturnResultHint(taskDescription),
            systemPrompt:          input['system_prompt'] as string | undefined,
            allowedTools:          input['allowed_tools'] as string[] | undefined,
            maxTurns:              typeof input['max_turns']        === 'number' ? input['max_turns']        : 10,
            maxBudgetUsd:          typeof input['max_budget_usd']   === 'number' ? input['max_budget_usd']   : 0.5,
            requireHumanApproval:  typeof input['require_human_approval'] === 'boolean' ? input['require_human_approval'] : false,
            useEventDriven:        typeof input['use_event_driven'] === 'boolean' ? input['use_event_driven'] : true,
            pollIntervalMs:        typeof input['poll_interval_ms'] === 'number' ? input['poll_interval_ms'] : 1_800_000,
            checkpointEveryNTurns: typeof input['checkpoint_every_n_turns'] === 'number' ? input['checkpoint_every_n_turns'] : 3,
            sandbox:               sandboxConfig,
            // Default shared_readonly (concurrency-safe). Writes must opt into
            // isolated_write so each concurrent writer gets its own git branch —
            // shared_write is deliberately NOT exposed on this async tool.
            workspaceMode:
              input['workspace_mode'] === 'isolated_write'
                ? 'isolated_write'
                : 'shared_readonly',
            isolateWorktree: input['workspace_mode'] === 'isolated_write',
          },
          abortSignal: ctx.abortSignal,
        })

        const mode = record.config.useEventDriven
          ? 'event-driven (you will be notified automatically)'
          : `poll mode (call get_sub_agent_status every ${Math.round(record.config.pollIntervalMs / 60_000)} minutes)`

        return {
          isError: false,
          content: JSON.stringify({
            task_id: record.taskId,
            status:  'pending',
            mode,
            limits: {
              max_turns:      record.config.maxTurns,
              max_budget_usd: record.config.maxBudgetUsd,
            },
            require_human_approval: record.config.requireHumanApproval,
            workspace_mode: record.config.workspaceMode,
            message: `Sub-agent started. Task ID: ${record.taskId}. ` +
              (record.config.useEventDriven
                ? 'You will see a notification in your next system prompt when it completes.'
                : `Poll with get_sub_agent_status("${record.taskId}") every ${Math.round(record.config.pollIntervalMs / 60_000)} minutes.`),
          }, null, 2),
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `Error spawning sub-agent: ${msg}`, isError: true }
      }
    },
  }
}
