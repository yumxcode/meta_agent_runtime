import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { GitWorkspaceManager } from '../../../infra/git/GitWorkspaceManager.js'
import { RoboticsProjectStore } from '../../persistence/RoboticsProjectStore.js'
import type { SubAgentTaskId } from '../../../subagent/types.js'

export function createGitMergeSubAgentTool(
  gitMgr: GitWorkspaceManager,
  projectDir: string,
  sessionId: string,
): MetaAgentTool {
  return {
    name: 'git_merge_subagent',
    description:
      'Merge a completed sub-agent\'s branch into main. ' +
      'Run git_diff_subagent first to review the changes. ' +
      'Default strategy is squash (keeps main history clean). ' +
      'Only merge sub-agents whose experiment outcome was success or partial with valuable code changes.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: {
          type: 'string',
          description: 'Sub-agent task ID whose branch to merge',
        },
        strategy: {
          type: 'string',
          enum: ['squash', 'merge', 'cherry-pick'],
          description: 'Merge strategy. squash (default): one clean commit. merge: preserve history. cherry-pick: specific commits only.',
        },
        message: {
          type: 'string',
          description: 'Commit message for the merge (defaults to auto-generated from task)',
        },
        commit_hashes: {
          type: 'array',
          items: { type: 'string' },
          description: 'For cherry-pick strategy: specific commit hashes to pick',
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
          return { content: `No git branch registered for task ${taskId}.`, isError: true }
        }

        const strategy = (input['strategy'] as 'squash' | 'merge' | 'cherry-pick' | undefined) ?? 'squash'
        const result = await gitMgr.mergeTaskBranch(taskId, branchName, {
          strategy,
          message: input['message'] as string | undefined,
          commitHashes: input['commit_hashes'] as string[] | undefined,
        })

        // Clean up the worktree after merge. clearGitRefs drops the now-finalized
        // task's subAgentBranches/forkPoints entries (read above) so per-project
        // git state doesn't grow one entry per completed task (P1-3 residual).
        await gitMgr.removeWorktree(taskId, { deleteBranch: false })
        await RoboticsProjectStore.completeSubAgentTask(projectDir, sessionId, taskId, { clearGitRefs: true })

        return {
          content: [
            `✅ Merged \`${branchName}\` → main (strategy: ${strategy})`,
            `**Merge commit**: ${result.commitHash.slice(0, 12)}`,
            ``,
            `Worktree cleaned up. Branch \`${branchName}\` is preserved for reference.`,
            `To remove the branch: run \`git branch -D ${branchName}\``,
          ].join('\n'),
          isError: false,
        }
      } catch (err) {
        return { content: `git_merge_subagent failed: ${String(err)}`, isError: true }
      }
    },
  }
}
