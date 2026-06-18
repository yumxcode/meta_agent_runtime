import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { GitWorkspaceManager } from '../../../infra/git/GitWorkspaceManager.js'
import { RoboticsProjectStore } from '../../persistence/RoboticsProjectStore.js'
import type { SubAgentTaskId } from '../../../subagent/types.js'

export function createGitDiffSubAgentTool(
  gitMgr: GitWorkspaceManager,
  projectDir: string,
  sessionId: string,
): MetaAgentTool {
  return {
    name: 'git_diff_subagent',
    isConcurrencySafe: true,
    description:
      'Show the diff between a sub-agent\'s branch and main. ' +
      'Run this before git_merge_subagent to review what the sub-agent changed. ' +
      'Returns a --stat summary (file names + line counts).',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: {
          type: 'string',
          description: 'Sub-agent task ID to diff',
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
          return {
            content: `No git branch registered for task ${taskId}. The sub-agent may not have used git.`,
            isError: true,
          }
        }

        const branchStatus = await gitMgr.getTaskBranchStatus(taskId, branchName)
        const diff = await gitMgr.getTaskDiff(taskId, branchName)

        return {
          content: [
            `## Diff: \`${branchName}\` vs main`,
            `**Commits ahead of main**: ${branchStatus.commitsAhead}`,
            `**Commits behind main**: ${branchStatus.commitsBehind}`,
            `**Last commit**: "${branchStatus.lastCommitMessage}" (${new Date(branchStatus.lastCommitAt).toLocaleString()})`,
            ``,
            `### Changed Files`,
            diff || '(no changes)',
          ].join('\n'),
          isError: false,
        }
      } catch (err) {
        return { content: `git_diff_subagent failed: ${String(err)}`, isError: true }
      }
    },
  }
}
