import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import { makeSubAgentTaskId } from '../../../subagent/types.js'
import { withReturnResultHint } from '../../../subagent/tools/return_result.js'
import type { GitWorkspaceManager } from '../../../infra/git/GitWorkspaceManager.js'
import { RoboticsProjectStore } from '../../persistence/RoboticsProjectStore.js'
import type { ExperimentSpec } from '../../types.js'

const EXPERIMENT_AGENT_SYSTEM = `\
You are an ExperimentAgent running inside an isolated sub-agent session.
Your task is to execute the assigned robotics experiment faithfully and report results.

Rules:
1. Work ONLY within your designated working directory. Do not access files outside it.
2. After completion, call experience_write to propose what you learned (success OR failure).
   The tool returns a pending ID; the main session user must approve it with /experience review
   before it becomes a committed ExperienceStore entry.
3. Return a structured ExperimentSummary JSON block in your final message:
   \`\`\`json
   {
     "specTitle": "<title>",
     "outcome": "success" | "partial" | "failure" | "timeout",
     "metrics": { "<key>": <value> },
     "keyFindings": ["..."],
     "failureAnalysis": "<optional>",
     "nextSuggestions": ["..."],
     "pendingExperienceId": "<pending id from experience_write, if queued>",
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
  sessionId: string,
): MetaAgentTool {
  return {
    name: 'experiment_dispatch',
    abortSupport: 'cooperative',
    // Opt out of the kernel's per-tool timeout: with await_completion=true this
    // blocks on the ExperimentAgent sub-agent, bounded by its own 5-min cap.
    timeoutMs: 0,
    description:
      'Dispatch an experiment to an isolated ExperimentAgent sub-agent. ' +
      'The sub-agent runs in its own git worktree (if git is enabled) so changes do not pollute main. ' +
      'Set await_completion=false to run experiments in parallel. ' +
      'The sub-agent will call experience_write automatically on completion, creating a pending review entry. ' +
      'REQUIRED: purpose (why you are dispatching) and on_complete (what YOU will do with the result). ' +
      'These fields prevent orphan tasks and ensure results are always processed.',
    inputSchema: {
      type: 'object',
      required: ['title', 'hypothesis', 'environment', 'procedure', 'success_criteria', 'purpose', 'on_complete'],
      properties: {
        title: { type: 'string', description: 'Short experiment title (≤ 60 chars)' },
        hypothesis: { type: 'string', description: 'What you expect to happen / prove' },
        environment: { type: 'string', description: 'Simulation environment or hardware setup' },
        procedure: { type: 'string', description: 'Step-by-step procedure for the experiment' },
        success_criteria: { type: 'string', description: 'Quantitative success criteria (e.g. "success_rate ≥ 90%")' },
        purpose: {
          type: 'string',
          description: 'One sentence: WHY you are dispatching this sub-agent (causal context from your plan).',
        },
        on_complete: {
          type: 'string',
          description: 'What YOU (the orchestrator) will do once this task completes — e.g. "call get_sub_agent_status, extract joint anomaly list, then propose DR parameter changes". This is your binding commitment.',
        },
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
        agent_instructions: {
          type: 'string',
          description:
            'Optional domain-specific instructions appended to the sub-agent system prompt. ' +
            'Use to inject analysis methods, required output format, domain constraints, or ' +
            'task-specific rules that go beyond the generic experiment template. ' +
            'Example: "统计每列NaN比例；检测关节角速度超出±5 rad/s的帧；输出markdown表格".',
        },
      },
    },
    async call(input, ctx): Promise<ToolResult> {
      // Hard-validate required continuation fields
      const purpose    = String(input['purpose']    ?? '').trim()
      const on_complete = String(input['on_complete'] ?? '').trim()
      if (!purpose) {
        return {
          content: 'experiment_dispatch requires a non-empty "purpose" field. ' +
            'Explain WHY you are dispatching this sub-agent before calling.',
          isError: true,
        }
      }
      if (!on_complete) {
        return {
          content: 'experiment_dispatch requires a non-empty "on_complete" field. ' +
            'Describe what YOU will do with the result before dispatching.',
          isError: true,
        }
      }

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
        let forkPoint: string | undefined
        const taskId = makeSubAgentTaskId()

        if (gitMgr.enabled) {
          try {
            const worktreeRecord = await gitMgr.createWorktreeForTask(taskId, 'experiment')
            worktreePath = worktreeRecord.worktreePath
            branchName = worktreeRecord.branchName
            forkPoint = worktreeRecord.forkPoint

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

        const agentInstructions = String(input['agent_instructions'] ?? '').trim()

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
          agentInstructions
            ? `\n## Additional Instructions (from orchestrator)\n${agentInstructions}`
            : '',
          gitContext,
        ].filter(s => s !== '').join('\n')

        const record = await bridge.spawnSubAgent({
          taskId,
          config: {
            taskDescription: withReturnResultHint(taskDescription),
            ...(worktreePath ? { projectDir: worktreePath } : {}),
            allowedTools: (input['allowed_tools'] as string[] | undefined) ?? [
              'bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'experience_write',
            ],
            maxTurns: spec.maxTurns,
          },
          abortSignal: ctx.abortSignal,
        })

        // Persist git state if a worktree was created
        if (branchName && worktreePath) {
          await RoboticsProjectStore.updateGitState(projectDir, sessionId, {
            subAgentBranches: { [record.taskId]: branchName },
            forkPoints: { [record.taskId]: forkPoint ?? '' },
          })
        }
        // Always register the task record (even without git) to track purpose + on_complete
        await RoboticsProjectStore.registerSubAgentTask(projectDir, sessionId, {
          taskId: record.taskId,
          role: 'experiment',
          title: spec.title,
          branchName,
          worktreePath,
          spawnedAt: Date.now(),
          purpose,
          on_complete,
        })

        const awaitCompletion = input['await_completion'] as boolean | undefined
        if (awaitCompletion) {
          // Wait for the sub-agent to finish
          let status = record.status
          while (!['completed', 'failed', 'cancelled'].includes(status)) {
            if (ctx.abortSignal?.aborted) { status = 'cancelled'; break }
            await new Promise(r => setTimeout(r, 2_000))
            const latest = await bridge.getStatus(record.taskId)
            status = latest?.status ?? 'failed'
          }
          const final = await bridge.getStatus(record.taskId)
          if (final?.status === 'completed') {
            await RoboticsProjectStore.completeSubAgentTask(projectDir, sessionId, record.taskId)
            return {
              content: `✅ Experiment completed.\n\nTask ID: ${record.taskId}\n\n${final.result?.summary ?? ''}`,
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
            `**Purpose**: ${purpose}`,
            ``,
            `⚠️  YOUR COMMITTED NEXT ACTION:`,
            `${on_complete}`,
            ``,
            `When ready: \`get_sub_agent_status task_id="${record.taskId}"\` — this returns the ExperimentSummary.`,
            `Do NOT use experience_search to find results — use get_sub_agent_status.`,
          ].join('\n'),
          isError: false,
        }
      } catch (err) {
        return { content: `experiment_dispatch failed: ${String(err)}`, isError: true }
      }
    },
  }
}
