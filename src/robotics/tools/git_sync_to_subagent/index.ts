import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { GitWorkspaceManager } from '../../../infra/git/GitWorkspaceManager.js'
import { RoboticsProjectStore } from '../../persistence/RoboticsProjectStore.js'
import type { SubAgentTaskId } from '../../../subagent/types.js'

export function createGitSyncToSubAgentTool(
  gitMgr: GitWorkspaceManager,
  projectDir: string,
  sessionId: string,
): MetaAgentTool {
  return {
    name: 'git_sync_to_subagent',
    description:
      'Push the latest main branch commits to a running sub-agent\'s worktree via rebase. ' +
      'Use this when you (main agent) have made significant code changes that a running sub-agent should build on. ' +
      'Typical case: CodeAgent finishes a core library, then you sync it to ExperimentAgent.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: {
          type: 'string',
          description: 'Sub-agent task ID to sync',
        },
      },
    },
    async call(input): Promise<ToolResult> {
      if (!gitMgr.enabled) {
        return { content: 'Git is not enabled for this project.', isError: true }
      }
      const taskId = String(input['task_id'] ?? '') as SubAgentTaskId
      if (!taskId) return { content: 'task_id is required', isError: true }

      try {
        const state = await RoboticsProjectStore.findBySession(projectDir, sessionId)
        const branchName = state?.git.subAgentBranches[taskId]
        if (!branchName) {
          return { content: `No git branch registered for task ${taskId}. Sync not needed.`, isError: true }
        }

        const result = await gitMgr.syncMainToTask(taskId, branchName)

        if (result.hasConflicts) {
          return {
            content: [
              `⚠ Sync failed — rebase conflicts detected on branch \`${result.branchName}\`.`,
              `The rebase was aborted; the sub-agent's branch is unchanged.`,
              ``,
              `Options:`,
              `1. Resolve manually in the worktree and re-run sync`,
              `2. Let the sub-agent finish on its current base, then cherry-pick specific commits`,
              `3. Discard the sub-agent branch if the experiment is no longer valid`,
            ].join('\n'),
            isError: true,
          }
        }

        return {
          content: [
            `✅ Synced main → \`${result.branchName}\``,
            `Sub-agent is now **${result.commitsAhead}** commit(s) ahead of main.`,
            result.commitsBehind > 0
              ? `(${result.commitsBehind} main commit(s) were rebased in)`
              : `(Sub-agent was already up-to-date)`,
          ].join('\n'),
          isError: false,
        }
      } catch (err) {
        return { content: `git_sync_to_subagent failed: ${String(err)}`, isError: true }
      }
    },
  }
}
