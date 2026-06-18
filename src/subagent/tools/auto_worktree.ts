/**
 * Auto-mode worktree tools — let the main agent integrate isolated sub-agent
 * worktrees back into the workspace SERIALLY.
 *
 * Concurrent writing sub-agents each work in their own git worktree+branch (see
 * AutoWorktreeCoordinator). After a sub-agent completes, the main agent reviews
 * its diff and either merges or discards it. Merges are serialised by
 * GitWorkspaceManager's internal mutation lock, so they never interleave.
 *
 * Only registered in auto mode. All three no-op gracefully when no coordinator
 * is armed or the workspace is not a git repo.
 */
import type { MetaAgentTool, ToolResult } from '../../core/types.js'
import type { SubAgentBridge } from '../SubAgentBridge.js'

const TASK_ID_SCHEMA = {
  type: 'object' as const,
  properties: { task_id: { type: 'string', description: 'The sub-agent task ID.' } },
  required: ['task_id'],
}

function taskId(input: Record<string, unknown>): string {
  return String(input['task_id'] ?? '').trim()
}

export function makeAutoMergeWorktreeTool(bridge: SubAgentBridge): MetaAgentTool {
  return {
    name: 'auto_merge_subagent',
    permission: { category: 'state', checkpointBoundary: 'both' },
    description:
      'Auto mode: merge an isolated sub-agent\'s git worktree branch back into the main branch ' +
      '(squash by default). Review the diff first with auto_diff_subagent. Merges are serialised.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'The sub-agent task ID.' },
        strategy: { type: 'string', enum: ['squash', 'merge'], description: 'Merge strategy. Default: squash.' },
        message: { type: 'string', description: 'Optional commit message.' },
      },
      required: ['task_id'],
    },
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      const id = taskId(input)
      if (!id) return { content: 'Error: task_id is required', isError: true }
      const coord = bridge.getWorktreeCoordinator()
      if (!coord) return { content: 'Error: worktree isolation is not active in this session.', isError: true }
      try {
        const strategy = input['strategy'] === 'merge' ? 'merge' : 'squash'
        const result = await coord.merge(id, { strategy, message: input['message'] as string | undefined })
        if (!result) return { content: `Error: no worktree found for task "${id}".`, isError: true }
        return { content: `Merged sub-agent ${id} (${strategy}) → ${result.commitHash}`, isError: false }
      } catch (err) {
        return {
          content:
            `Merge failed: ${err instanceof Error ? err.message : String(err)}. ` +
            'The main workspace was rolled back when possible; the task branch is preserved for inspection/retry.',
          isError: true,
        }
      }
    },
  }
}

export function makeAutoFinalizeWorktreeTool(bridge: SubAgentBridge): MetaAgentTool {
  return {
    name: 'auto_finalize_subagent',
    permission: { category: 'state', checkpointBoundary: 'both' },
    description:
      'Finalize an isolated-write sub-agent worktree: detect dirty files, stage all changes, ' +
      'and create an idempotent task commit. Usually automatic on completion and before merge.',
    inputSchema: TASK_ID_SCHEMA,
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      const id = taskId(input)
      if (!id) return { content: 'Error: task_id is required', isError: true }
      const coord = bridge.getWorktreeCoordinator()
      if (!coord) {
        return { content: 'Error: worktree isolation is not active in this session.', isError: true }
      }
      try {
        const result = await coord.finalize(id)
        return {
          content: JSON.stringify({
            task_id: id,
            status: result.status,
            commit_hash: result.commitHash,
            changed_files: result.changedFiles,
          }, null, 2),
          isError: false,
        }
      } catch (err) {
        return {
          content: `Finalize failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  }
}

export function makeAutoDiffWorktreeTool(bridge: SubAgentBridge): MetaAgentTool {
  return {
    name: 'auto_diff_subagent',
    description: 'Auto mode: show the diff (stat) of an isolated sub-agent\'s worktree branch vs main before merging.',
    inputSchema: TASK_ID_SCHEMA,
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      const id = taskId(input)
      if (!id) return { content: 'Error: task_id is required', isError: true }
      const coord = bridge.getWorktreeCoordinator()
      if (!coord) return { content: 'Error: worktree isolation is not active in this session.', isError: true }
      return { content: await coord.diff(id), isError: false }
    },
  }
}

export function makeAutoDiscardWorktreeTool(bridge: SubAgentBridge): MetaAgentTool {
  return {
    name: 'auto_discard_subagent',
    description: 'Auto mode: discard an isolated sub-agent\'s worktree and branch without merging (e.g. on conflict or bad output).',
    inputSchema: TASK_ID_SCHEMA,
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      const id = taskId(input)
      if (!id) return { content: 'Error: task_id is required', isError: true }
      const coord = bridge.getWorktreeCoordinator()
      if (!coord) return { content: 'Error: worktree isolation is not active in this session.', isError: true }
      await coord.discard(id)
      return { content: `Discarded worktree for sub-agent ${id}.`, isError: false }
    },
  }
}

export function makeAutoWorktreeTools(bridge: SubAgentBridge): MetaAgentTool[] {
  return [
    makeAutoFinalizeWorktreeTool(bridge),
    makeAutoMergeWorktreeTool(bridge),
    makeAutoDiffWorktreeTool(bridge),
    makeAutoDiscardWorktreeTool(bridge),
  ]
}
