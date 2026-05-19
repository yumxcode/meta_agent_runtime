import { RoboticsProjectStore } from '../../persistence/RoboticsProjectStore.js';
export function createGitDiffSubAgentTool(gitMgr, projectDir) {
    return {
        name: 'git_diff_subagent',
        isConcurrencySafe: true,
        description: 'Show the diff between a sub-agent\'s branch and main. ' +
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
        async call(input) {
            if (!gitMgr.enabled) {
                return { content: 'Git is not enabled for this project.', isError: true };
            }
            const taskId = String(input['task_id'] ?? '');
            if (!taskId)
                return { content: 'task_id is required', isError: true };
            try {
                const state = await RoboticsProjectStore.findByProjectDir(projectDir);
                const branchName = state?.git.subAgentBranches[taskId];
                if (!branchName) {
                    return {
                        content: `No git branch registered for task ${taskId}. The sub-agent may not have used git.`,
                        isError: true,
                    };
                }
                const branchStatus = await gitMgr.getTaskBranchStatus(taskId, branchName);
                const diff = await gitMgr.getTaskDiff(taskId, branchName);
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
                };
            }
            catch (err) {
                return { content: `git_diff_subagent failed: ${String(err)}`, isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map