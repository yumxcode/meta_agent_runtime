import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { GitWorkspaceManager } from '../../../infra/git/GitWorkspaceManager.js'
import { RoboticsProjectStore } from '../../persistence/RoboticsProjectStore.js'
import type { SubAgentTaskId } from '../../../subagent/types.js'

export function createGitDiscardSubAgentTool(
  gitMgr: GitWorkspaceManager,
  projectDir: string,
  sessionId: string,
): MetaAgentTool {
  return {
    name: 'git_discard_subagent',
    description:
      'Discard a sub-agent\'s branch (failed or unwanted experiment code). ' +
      'Any experience proposed by the sub-agent remains in the pending review queue; approve it with /experience review to preserve the lesson. ' +
      'Use this when an experiment failed and you do not want to merge its code changes.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: {
          type: 'string',
          description: 'Sub-agent task ID whose branch to discard',
        },
        delete_branch: {
          type: 'boolean',
          description: 'Also delete the git branch (default false — keeps branch for reference)',
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

        const deleteBranch = Boolean(input['delete_branch'])
        await gitMgr.removeWorktree(taskId, { deleteBranch, branchName })
        // clearGitRefs: branch is finalized (discarded), so drop its
        // subAgentBranches/forkPoints entries (read above) — P1-3 residual.
        await RoboticsProjectStore.completeSubAgentTask(projectDir, sessionId, taskId, { clearGitRefs: true })

        return {
          content: [
            `🗑 Sub-agent branch discarded (task: ${taskId})`,
            branchName
              ? deleteBranch
                ? `Branch \`${branchName}\` deleted.`
                : `Branch \`${branchName}\` preserved (run \`git branch -D ${branchName}\` to remove).`
              : '',
            ``,
            `⚡ Any experience proposed by this sub-agent remains pending review.`,
            `Run \`/experience review\` to approve, edit, or discard the lesson.`,
          ].filter(Boolean).join('\n'),
          isError: false,
        }
      } catch (err) {
        return { content: `git_discard_subagent failed: ${String(err)}`, isError: true }
      }
    },
  }
}
