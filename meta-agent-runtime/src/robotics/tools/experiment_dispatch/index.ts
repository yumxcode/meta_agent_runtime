import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { GitWorkspaceManager } from '../../git/GitWorkspaceManager.js'
import { RoboticsProjectStore } from '../../persistence/RoboticsProjectStore.js'
import type { ExperimentSpec } from '../../types.js'

const EXPERIMENT_AGENT_SYSTEM = `\
You are an ExperimentAgent running inside an isolated sub-agent session.
Your task is to execute the assigned robotics experiment faithfully and report results.

Rules:
1. Work ONLY within your designated working directory. Do not access files outside it.
2. After completion, call experience_write to record what you learned (success OR failure).
3. Return a structured ExperimentSummary JSON block in your final message:
   \`\`\`json
   {
     "specTitle": "<title>",
     "outcome": "success" | "partial" | "failure" | "timeout",
     "metrics": { "<key>": <value> },
     "keyFindings": ["..."],
     "failureAnalysis": "<optional>",
     "nextSuggestions": ["..."],
     "experienceId": "<id from experience_write>",
     "branchName": "<git branch if applicable>",
     "durationMs": <number>,
     "turnsUsed": <number>
   }
   \`\`\`
4. Commit your code changes regularly with descriptive messages.
5. Never push to remote, switch branches, or merge branches — the main agent handles that.
`

export function createExperimentDispatchTool(
  bridge: ISubAgentDispatcher,
  gitMgr: GitWorkspaceManager,
  projectDir: string,
): MetaAgentTool {
  return {
    name: 'experiment_dispatch',
    description:
      'Dispatch an experiment to an isolated ExperimentAgent sub-agent. ' +
      'The sub-agent runs in its own git worktree (if git is enabled) so changes do not pollute main. ' +
      'Set await_completion=false to run experiments in parallel. ' +
      'The sub-agent will call experience_write automatically on completion.',
    inputSchema: {
      type: 'object',
      required: ['title', 'hypothesis', 'environment', 'procedure', 'success_criteria'],
      properties: {
        title: { type: 'string', description: 'Short experiment title (≤ 60 chars)' },
        hypothesis: { type: 'string', description: 'What you expect to happen / prove' },
        environment: { type: 'string', description: 'Simulation environment or hardware setup' },
        procedure: { type: 'string', description: 'Step-by-step procedure for the experiment' },
        success_criteria: { type: 'string', description: 'Quantitative success criteria (e.g. "success_rate ≥ 90%")' },
        max_turns: {
          type: 'number',
          description: 'Maximum agent turns (default 60)',
        },
        await_completion: {
          type: 'boolean',
          description: 'If false (default), returns immediately with task ID for polling. Set true for sequential experiments.',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra tools to grant (default: bash, read_file, write_file, glob, grep, experience_write)',
        },
      },
    },
    async call(input, ctx): Promise<ToolResult> {
      const spec: ExperimentSpec = {
        title: String(input['title'] ?? ''),
        hypothesis: String(input['hypothesis'] ?? ''),
        environment: String(input['environment'] ?? ''),
        procedure: String(input['procedure'] ?? ''),
        successCriteria: String(input['success_criteria'] ?? ''),
        maxTurns: (input['max_turns'] as number | undefined) ?? 60,
      }

      try {
        // Create git worktree if git is available
        let gitContext = ''
        let worktreePath: string | undefined
        let branchName: string | undefined

        if (gitMgr.enabled) {
          try {
            // We need a task ID before we can create the worktree
            // Generate a temporary ID based on timestamp
            const tempTaskId = `exp_${Date.now().toString(36)}` as import('../../../subagent/types.js').SubAgentTaskId
            const worktreeRecord = await gitMgr.createWorktreeForTask(tempTaskId, 'experiment')
            worktreePath = worktreeRecord.worktreePath
            branchName = worktreeRecord.branchName

            gitContext = `\n\n## Git Context for This Experiment
You are working on branch: \`${branchName}\`
Working directory: \`${worktreePath}\`
Forked from main at commit: \`${worktreeRecord.forkPoint}\`

Rules:
- All file changes MUST be made in your worktree: ${worktreePath}
- Commit your changes with descriptive messages (git add + git commit)
- Do NOT run git push, git checkout, git merge, or create new branches
- The main agent decides whether to merge your branch`
          } catch {
            // Git not available or worktree creation failed — continue without git
            gitContext = ''
          }
        }

        const taskDescription = [
          `# Experiment: ${spec.title}`,
          '',
          `## Hypothesis\n${spec.hypothesis}`,
          '',
          `## Environment\n${spec.environment}`,
          '',
          `## Procedure\n${spec.procedure}`,
          '',
          `## Success Criteria\n${spec.successCriteria}`,
          '',
          EXPERIMENT_AGENT_SYSTEM,
          gitContext,
        ].join('\n')

        const record = await bridge.spawnSubAgent({
          config: {
            taskDescription,
            allowedTools: (input['allowed_tools'] as string[] | undefined) ?? [
              'bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'experience_write',
            ],
            maxTurns: spec.maxTurns,
          },
          abortSignal: ctx.abortSignal,
        })

        // Persist git state if a worktree was created
        if (branchName && worktreePath) {
          await RoboticsProjectStore.updateGitState(projectDir, {
            subAgentBranches: { [record.taskId]: branchName },
            forkPoints: { [record.taskId]: '' },
          })
          await RoboticsProjectStore.registerSubAgentTask(projectDir, {
            taskId: record.taskId,
            role: 'experiment',
            title: spec.title,
            branchName,
            worktreePath,
            spawnedAt: Date.now(),
          })
        }

        const awaitCompletion = input['await_completion'] as boolean | undefined
        if (awaitCompletion) {
          // Wait for the sub-agent to finish
          let status = record.status
          while (!['completed', 'failed', 'cancelled'].includes(status)) {
            await new Promise(r => setTimeout(r, 2_000))
            const latest = await bridge.getStatus(record.taskId)
            status = latest?.status ?? 'failed'
          }
          const final = await bridge.getStatus(record.taskId)
          if (final?.status === 'completed') {
            await RoboticsProjectStore.completeSubAgentTask(projectDir, record.taskId)
            return {
              content: `✅ Experiment completed.\n\nTask ID: ${record.taskId}\n\n${final.result ?? ''}`,
              isError: false,
            }
          }
          return {
            content: `❌ Experiment ${final?.status ?? 'failed'}. Task ID: ${record.taskId}`,
            isError: true,
          }
        }

        return {
          content: [
            `🔬 Experiment dispatched.`,
            `**Task ID**: ${record.taskId}`,
            `**Title**: ${spec.title}`,
            ...(branchName ? [`**Branch**: \`${branchName}\``] : []),
            ``,
            `Use \`get_sub_agent_status task_id="${record.taskId}"\` to check progress.`,
            `Use \`git_diff_subagent task_id="${record.taskId}"\` to preview code changes.`,
            `Use \`git_merge_subagent task_id="${record.taskId}"\` to merge successful results.`,
          ].join('\n'),
          isError: false,
        }
      } catch (err) {
        return { content: `experiment_dispatch failed: ${String(err)}`, isError: true }
      }
    },
  }
}
