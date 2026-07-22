import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import { SubAgentBudgetExceededError } from '../../../subagent/SubAgentBridge.js'
import { makeTimerTool, type TimerIntent } from '../../../subagent/tools/timer.js'
import { spawnAndWaitDetailed, type SpawnWaitOptions } from '../../seatSpawn.js'
import type { ActivationUsage, JsonValue } from '../spec/GraphTypes.js'
import type {
  GraphAgentExecutionRequest,
  GraphAgentExecutionResult,
  GraphAgentExecutor,
  GraphAgentParkIntent,
} from './GraphAgentExecutor.js'
import { GRAPH_AGENT_PROFILE } from './GraphAgentExecutor.js'

export const META_AGENT_GRAPH_AGENT_EXECUTOR_ID = 'meta-agent/graph-agent-kernel@1'

/**
 * Current graph_agent substrate: MetaAgentSession -> AgenticSession -> KernelLoop.
 *
 * This adapter deliberately does not enable Auto's Verify/Drift orchestration;
 * the durable Graph Kernel already owns orchestration. An Auto-configured
 * SubAgentBridge may still supply its unattended workspace jail.
 */
export class MetaAgentGraphAgentExecutor implements GraphAgentExecutor {
  readonly id = META_AGENT_GRAPH_AGENT_EXECUTOR_ID

  constructor(
    private readonly dispatcher: ISubAgentDispatcher,
    private readonly spawnOptions?: SpawnWaitOptions,
  ) {}

  async execute(request: GraphAgentExecutionRequest): Promise<GraphAgentExecutionResult> {
    if (request.profile !== GRAPH_AGENT_PROFILE) {
      throw new Error(`unsupported Graph Agent profile '${String(request.profile)}'`)
    }
    let timerIntent: TimerIntent | undefined
    const parkSignal = { requested: false }
    const extraTools = request.timer
      ? [makeTimerTool(intent => {
          timerIntent = intent
          parkSignal.requested = true
        }, { maxDelayMs: request.timer.maxDelayMs })]
      : []

    let outcome: Awaited<ReturnType<typeof spawnAndWaitDetailed>>
    try {
      outcome = await spawnAndWaitDetailed(this.dispatcher, {
        taskDescription: request.prompt.user,
        systemPrompt: request.prompt.system,
        resultSchema: request.outputSchema,
        externalPromptAssembly: true,
        skipMemoryRecall: true,
        allowedTools: request.allowedTools,
        maxTurns: request.limits.turns,
        maxBudgetUsd: request.limits.usd,
        maxDurationMs: request.limits.wallTimeMs,
        requireHumanApproval: false,
        useEventDriven: false,
        pollIntervalMs: 500,
        checkpointEveryNTurns: 0,
        projectDir: request.workspace.projectDir,
        workspaceMode: request.workspace.mode,
        sandbox: {
          readonlyWorkspace: true,
          writeAllowPaths: request.workspace.writeAllowPaths,
          writeDenyPaths: request.workspace.writeDenyPaths,
        },
        lineageSessionId: request.continuity.lineageSessionId,
        workspaceId: request.continuity.workspaceId,
        loopInstanceId: request.continuity.loopInstanceId,
        hostCoordinatorRoot: request.hostCoordinatorRoot,
        hostMaxConcurrentModelCalls: request.maxConcurrentModelCalls,
        ...(extraTools.length ? { extraTools, parkSignal } : {}),
      }, request.signal, withOuterPollDeadline(this.spawnOptions, request.limits.wallTimeMs))
    } catch (error) {
      if (error instanceof SubAgentBudgetExceededError) {
        return {
          kind: 'exhausted',
          reason: error.message,
          usage: { turns: 0, costUsd: 0, durationMs: 0 },
        }
      }
      throw error
    }

    const usage = usageFromRecord(outcome.record)
    const park = toParkIntent(timerIntent)
    if (outcome.kind !== 'terminal') {
      return {
        kind: outcome.kind,
        taskId: outcome.taskId,
        usage,
        ...(park ? { park } : {}),
      }
    }
    const record = outcome.record
    return {
      kind: 'completed',
      taskId: outcome.taskId,
      success: record?.status === 'completed' && record.result?.success === true,
      output: record?.result?.output,
      summary: record?.result?.summary ?? '',
      ...(record?.result?.error ? { error: record.result.error } : {}),
      usage,
      ...(park ? { park } : {}),
    }
  }
}

function usageFromRecord(record: Awaited<ReturnType<ISubAgentDispatcher['getStatus']>>): ActivationUsage {
  return {
    turns: record?.result?.turnsUsed ?? 0,
    costUsd: record?.result?.costUsd ?? 0,
    durationMs: record?.result?.durationMs ?? 0,
  }
}

function toParkIntent(intent: TimerIntent | undefined): GraphAgentParkIntent | undefined {
  if (!intent) return undefined
  return {
    afterMs: intent.afterMs,
    reason: intent.reason,
    ...(intent.checkpoint !== undefined ? { checkpoint: intent.checkpoint as JsonValue } : {}),
  }
}

function withOuterPollDeadline(options: SpawnWaitOptions | undefined, wallTimeMs: number | undefined): SpawnWaitOptions | undefined {
  if (wallTimeMs === undefined) return options
  const required = wallTimeMs + 60_000
  return { ...options, maxWaitMs: Math.max(options?.maxWaitMs ?? 0, required) }
}
