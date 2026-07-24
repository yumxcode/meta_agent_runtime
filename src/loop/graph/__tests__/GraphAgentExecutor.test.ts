import { describe, expect, it } from 'vitest'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SpawnSubAgentOptions } from '../../../subagent/SubAgentBridge.js'
import type { SubAgentRecord } from '../../../subagent/types.js'
import { SubAgentBudgetExceededError } from '../../../subagent/SubAgentBridge.js'
import {
  GRAPH_AGENT_PROFILE,
  GRAPH_AGENT_SYSTEM_PROMPT,
  buildGraphAgentSystemPrompt,
  MetaAgentGraphAgentExecutor,
  buildGraphAgentUserPrompt,
} from '../index.js'

function completedRecord(config: SubAgentRecord['config']): SubAgentRecord {
  return {
    schemaVersion: '1.0',
    taskId: 'subtask-graphagent',
    parentSessionId: 'parent',
    status: 'completed',
    config,
    createdAt: 1,
    completedAt: 2,
    pendingHumanApproval: false,
    result: {
      success: true,
      summary: 'done',
      output: { ok: true },
      turnsUsed: 3,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.25,
      durationMs: 50,
    },
  }
}

describe('graph_agent execution boundary', () => {
  it('owns a protected system prompt and a sectioned user prompt', () => {
    const user = buildGraphAgentUserPrompt({
      workspace: { read: ['requirements.md'], write: [], deny: ['.git'] },
      instruction: 'Perform this activation.',
      outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
    })
    expect(GRAPH_AGENT_SYSTEM_PROMPT).toContain('Graph Kernel exclusively owns routing')
    expect(GRAPH_AGENT_SYSTEM_PROMPT).toContain('operator-facing')
    expect(GRAPH_AGENT_SYSTEM_PROMPT).toContain('being awaited')
    expect(buildGraphAgentSystemPrompt({ laneInstructions: 'Maintain continuity.' })).toContain('graph_authored_system_instructions')
    expect(user).toContain('"name": "activation_instruction"')
    expect(user).toContain('"name": "lane_workspace_contract"')
    expect(user).toContain('"role": "contract"')
    expect(user).toContain('"role": "invariant"')
    expect(user).toContain('"trust": "trusted_graph"')
  })

  it('adapts graph_agent to the current MetaAgent KernelLoop without leaking dispatcher records', async () => {
    let captured: SpawnSubAgentOptions | undefined
    const dispatcher: ISubAgentDispatcher = {
      async spawnSubAgent(options) {
        captured = options
        return completedRecord(options.config as SubAgentRecord['config'])
      },
      async getStatus() { return null },
      async cancelTask() { return true },
    }
    const executor = new MetaAgentGraphAgentExecutor(dispatcher)
    const outputSchema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } as const
    const result = await executor.execute({
      profile: GRAPH_AGENT_PROFILE,
      prompt: { system: GRAPH_AGENT_SYSTEM_PROMPT, user: 'current activation' },
      outputSchema,
      allowedTools: ['read_file'],
      workspace: {
        projectDir: '/workspace',
        mode: 'shared_readonly',
        writeAllowPaths: [],
        writeDenyPaths: ['/workspace/.loop'],
      },
      continuity: {
        lineageSessionId: 'lane-lineage',
        workspaceId: 'workspace-id',
        loopInstanceId: 'loop-id',
      },
      limits: { turns: 5, usd: 1, wallTimeMs: 10_000 },
      signal: new AbortController().signal,
    })

    expect(captured?.config).toMatchObject({
      taskDescription: 'current activation',
      systemPrompt: GRAPH_AGENT_SYSTEM_PROMPT,
      externalPromptAssembly: true,
      skipMemoryRecall: true,
      lineageSessionId: 'lane-lineage',
      workspaceId: 'workspace-id',
      loopInstanceId: 'loop-id',
      maxTurns: 5,
      maxBudgetUsd: 1,
      retryOwner: 'caller',
      resultSchema: outputSchema,
    })
    expect(result).toMatchObject({
      kind: 'completed',
      success: true,
      output: { ok: true },
      usage: { turns: 3, costUsd: 0.25, durationMs: 50 },
    })
  })

  it('maps typed dispatcher budget admission failures to exhausted', async () => {
    const dispatcher: ISubAgentDispatcher = {
      async spawnSubAgent() {
        throw new SubAgentBudgetExceededError('graph segment exceeds operator cap', 'bridge')
      },
      async getStatus() { return null },
      async cancelTask() { return true },
    }
    const result = await new MetaAgentGraphAgentExecutor(dispatcher).execute({
      profile: GRAPH_AGENT_PROFILE,
      prompt: { system: GRAPH_AGENT_SYSTEM_PROMPT, user: 'current activation' },
      allowedTools: [],
      workspace: {
        projectDir: '/workspace', mode: 'shared_readonly', writeAllowPaths: [], writeDenyPaths: [],
      },
      continuity: { workspaceId: 'workspace-id', loopInstanceId: 'loop-id' },
      limits: { turns: 30, usd: 15 },
      signal: new AbortController().signal,
    })

    expect(result).toEqual({
      kind: 'exhausted',
      reason: 'graph segment exceeds operator cap',
      usage: { turns: 0, costUsd: 0, durationMs: 0 },
    })
  })

  it('preserves structured provider failures from dispatcher records', async () => {
    const dispatcher: ISubAgentDispatcher = {
      async spawnSubAgent(options) {
        const record = completedRecord(options.config as SubAgentRecord['config'])
        return {
          ...record,
          status: 'failed',
          result: {
            ...record.result!,
            success: false,
            error: 'status=402 subscription expired',
            failure: {
              category: 'provider_blocked' as const,
              message: 'status=402 subscription expired',
              retryable: false,
              providerId: 'zhipu' as const,
              status: 402,
            },
          },
        }
      },
      async getStatus() { return null },
      async cancelTask() { return true },
    }
    const result = await new MetaAgentGraphAgentExecutor(dispatcher).execute({
      profile: GRAPH_AGENT_PROFILE,
      prompt: { system: GRAPH_AGENT_SYSTEM_PROMPT, user: 'current activation' },
      allowedTools: [],
      workspace: {
        projectDir: '/workspace', mode: 'shared_readonly', writeAllowPaths: [], writeDenyPaths: [],
      },
      continuity: { workspaceId: 'workspace-id', loopInstanceId: 'loop-id' },
      limits: { turns: 5, usd: 1 },
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({
      kind: 'completed',
      success: false,
      error: 'status=402 subscription expired',
      failure: {
        category: 'provider_blocked',
        providerId: 'zhipu',
        status: 402,
      },
    })
  })

  it('propagates timeout phase diagnostics without exposing dispatcher records', async () => {
    const dispatcher: ISubAgentDispatcher = {
      async spawnSubAgent(options) {
        const record = completedRecord(options.config as SubAgentRecord['config'])
        return {
          ...record,
          status: 'failed',
          result: {
            ...record.result!,
            success: false,
            error: 'Sub-agent exceeded 120000ms wall-clock limit',
            diagnostics: {
              timedOut: true,
              timeoutPhase: 'model_admission',
              runtimeEventCount: 0,
            },
          },
        }
      },
      async getStatus() { return null },
      async cancelTask() { return true },
    }
    const result = await new MetaAgentGraphAgentExecutor(dispatcher).execute({
      profile: GRAPH_AGENT_PROFILE,
      prompt: { system: GRAPH_AGENT_SYSTEM_PROMPT, user: 'current activation' },
      allowedTools: [],
      workspace: {
        projectDir: '/workspace', mode: 'shared_readonly', writeAllowPaths: [], writeDenyPaths: [],
      },
      continuity: { workspaceId: 'workspace-id', loopInstanceId: 'loop-id' },
      limits: { turns: 5, usd: 1, wallTimeMs: 120_000 },
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      kind: 'completed',
      success: false,
      diagnostics: { timeoutPhase: 'model_admission', runtimeEventCount: 0 },
    })
  })

  it('normalizes the MetaAgent timer tool into a substrate-neutral park intent', async () => {
    const dispatcher: ISubAgentDispatcher = {
      async spawnSubAgent(options) {
        const timer = options.config.extraTools?.find(tool => tool.name === 'timer')
        await timer?.call(
          { afterMs: 1_000, reason: 'external work pending', checkpoint: { jobId: 'j1' } },
          { sessionId: 'test', agentId: 'graph-agent', abortSignal: new AbortController().signal },
        )
        return completedRecord(options.config as SubAgentRecord['config'])
      },
      async getStatus() { return null },
      async cancelTask() { return true },
    }
    const result = await new MetaAgentGraphAgentExecutor(dispatcher).execute({
      profile: GRAPH_AGENT_PROFILE,
      prompt: { system: GRAPH_AGENT_SYSTEM_PROMPT, user: 'wait when needed' },
      allowedTools: [],
      workspace: {
        projectDir: '/workspace', mode: 'shared_readonly', writeAllowPaths: [], writeDenyPaths: [],
      },
      continuity: { workspaceId: 'workspace-id', loopInstanceId: 'loop-id' },
      limits: { turns: 5, usd: 1 },
      timer: { maxDelayMs: 2_000 },
      signal: new AbortController().signal,
    })
    expect(result.park).toEqual({
      afterMs: 1_000,
      reason: 'external work pending',
      checkpoint: { jobId: 'j1' },
    })
  })
})
