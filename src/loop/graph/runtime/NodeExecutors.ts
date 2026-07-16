import { join, resolve } from 'node:path'
import type {
  CapabilityRegistry,
  EffectProvider,
  FunctionProvider,
} from '../registry/CapabilityRegistry.js'
import { GRAPH_AGENT_PROFILE, type GraphAgentExecutor } from '../agent/GraphAgentExecutor.js'
import { buildGraphAgentSystemPrompt, buildGraphAgentUserPrompt } from '../agent/GraphAgentPrompt.js'
import type {
  ActivationRecord,
  ActivationUsage,
  FrozenLoopGraphSpec,
  GraphInstanceRecord,
  GraphStateSnapshot,
  JsonValue,
  NodeSpec,
} from '../spec/GraphTypes.js'
import { evaluateBindings, evaluateValueExpression } from './GraphExpression.js'
import { isJsonValue, validateShape } from './GraphJson.js'
import type { GraphSnapshot, GraphStore } from './GraphStore.js'
import type { LaneManager } from './LaneManager.js'
import type { ContextAssembler } from './ContextAssembly.js'

export type NodeExecutionResult =
  | { kind: 'completed'; outcome: string; output: JsonValue; summary?: string; usage?: ActivationUsage }
  | { kind: 'retry'; reason: string; usage?: ActivationUsage; consumeAttempt: boolean; delayMs?: number }
  | { kind: 'fatal'; reason: string; usage?: ActivationUsage }
  | {
      kind: 'parked'
      wakeAt?: number
      event?: { name: string; correlation?: JsonValue }
      inputPatch?: Record<string, JsonValue>
      reason: string
      usage?: ActivationUsage
    }

export interface NodeExecutorDeps {
  store: GraphStore
  graph: FrozenLoopGraphSpec
  instance: GraphInstanceRecord
  functions: CapabilityRegistry<FunctionProvider>
  effects?: CapabilityRegistry<EffectProvider>
  graphAgent?: GraphAgentExecutor
  contextAssembler?: ContextAssembler
  lanes?: LaneManager
  signal?: AbortSignal
  now?: () => number
  hostCoordinatorRoot?: string
  maxConcurrentModelCalls?: number
}

export class NodeExecutorRegistry {
  constructor(private readonly deps: NodeExecutorDeps) {}

  async execute(activation: ActivationRecord, snapshot: GraphSnapshot): Promise<NodeExecutionResult> {
    const node = this.deps.graph.nodes[activation.nodeId]
    if (!node) throw new Error(`unknown node '${activation.nodeId}'`)
    switch (node.type) {
      case 'agent': return this.executeAgent(node, activation, snapshot.state)
      case 'function': return this.executeFunction(node, activation, snapshot.state)
      case 'effect': return this.executeEffect(node, activation, snapshot.state)
      case 'wait': return this.executeWait(node, activation, snapshot.state)
      case 'join': return this.executeJoin(node, activation, snapshot)
      case 'terminal': return this.executeTerminal(node, activation, snapshot.state)
    }
  }

  private async executeAgent(node: Extract<NodeSpec, { type: 'agent' }>, activation: ActivationRecord, state: GraphStateSnapshot): Promise<NodeExecutionResult> {
    if (!this.deps.graphAgent || !this.deps.lanes || !this.deps.contextAssembler) {
      throw new Error('Agent node requires graph_agent, ContextAssembler, and LaneManager')
    }
    if (activation.attempt > (node.maxAttempts ?? 3)) return { kind: 'completed', outcome: 'failure', output: { error: 'maxAttempts exceeded' }, summary: 'Agent maxAttempts exceeded' }
    const binding = await this.deps.lanes.bind(node.lane, activation)
    const context = await this.deps.contextAssembler.assemble(node, activation, state, { laneRoot: binding.projectDir })
    const signal = this.deps.signal ?? new AbortController().signal
    const segmentLimits = remainingSegmentLimits(node, activation, this.now())
    if ('error' in segmentLimits) {
      return { kind: 'completed', outcome: 'failure', output: { error: segmentLimits.error }, summary: segmentLimits.error }
    }
    let result: Awaited<ReturnType<GraphAgentExecutor['execute']>>
    try {
      result = await this.deps.graphAgent.execute({
        profile: GRAPH_AGENT_PROFILE,
        prompt: {
          system: buildGraphAgentSystemPrompt({
            laneInstructions: this.deps.graph.lanes[node.lane]?.agentProfile?.systemInstructions,
            nodeInstructions: node.systemInstructions,
          }),
          user: buildGraphAgentUserPrompt({
            contextSections: context.rendered,
            instruction: node.prompt,
            outputSchema: node.outputSchema,
          }),
        },
        allowedTools: node.tools ?? ['read_file', 'edit_file', 'write_file', 'grep', 'glob', 'bash'],
        limits: segmentLimits,
        workspace: {
          projectDir: binding.projectDir,
          mode: binding.workspaceMode,
          writeAllowPaths: binding.workspaceMode === 'shared_write'
            ? (node.writes ?? []).map(path => resolve(binding.projectDir, path))
            : [],
          writeDenyPaths: [
            join(binding.projectDir, '.loop'),
            join(binding.projectDir, '.meta-agent'),
            join(binding.projectDir, '.git'),
            ...(this.deps.graph.lanes[node.lane]?.workspaceAccess?.deny ?? [])
              .map(path => resolve(binding.projectDir, path)),
            ...Object.entries(this.deps.graph.workspaceBindings ?? {})
              .filter(([bindingId, workspaceBinding]) =>
                workspaceBinding.lane === node.lane && !laneMayWriteWorkspaceBinding(this.deps.graph, node.lane, bindingId, workspaceBinding.plane))
              .map(([, workspaceBinding]) => resolve(binding.projectDir, workspaceBinding.path)),
          ],
        },
        continuity: {
          ...(binding.lineageSessionId ? { lineageSessionId: binding.lineageSessionId } : {}),
          workspaceId: this.deps.instance.workspaceId,
          loopInstanceId: this.deps.instance.instanceId,
        },
        ...(node.timerPolicy?.allowHardPark
          ? { timer: { maxDelayMs: node.timerPolicy.maxDelayMs } }
          : {}),
        ...(this.deps.hostCoordinatorRoot ? { hostCoordinatorRoot: this.deps.hostCoordinatorRoot } : {}),
        ...(this.deps.maxConcurrentModelCalls !== undefined
          ? { maxConcurrentModelCalls: this.deps.maxConcurrentModelCalls }
          : {}),
        signal,
      })
    } catch (error) {
      if (signal.aborted) return { kind: 'retry', reason: `Agent execution aborted: ${message(error)}`, consumeAttempt: false }
      return retryableAgentFailure(node, activation, `graph_agent executor error: ${message(error)}`)
    }
    const usage = result.usage
    if (result.kind === 'cancellation_unconfirmed') {
      return {
        kind: 'fatal',
        reason: `Agent cancellation could not be confirmed for task '${result.taskId}'; Lane replay is unsafe`,
        usage: reserveUnknownCost(usage, segmentLimits.usd),
      }
    }
    if (result.park) {
      if (node.timerPolicy?.maxDelayMs !== undefined && result.park.afterMs > node.timerPolicy.maxDelayMs) {
        return { kind: 'completed', outcome: 'failure', output: { error: `timer delay exceeds ${node.timerPolicy.maxDelayMs}`, requestedMs: result.park.afterMs }, summary: `Timer delay exceeds ${node.timerPolicy.maxDelayMs}ms`, usage }
      }
      const checkpoint = result.park.checkpoint
      if (checkpoint !== undefined && !isJsonValue(checkpoint)) {
        return { kind: 'completed', outcome: 'failure', output: { error: 'timer checkpoint is not JSON' }, summary: 'Timer checkpoint is not valid JSON', usage }
      }
      return {
        kind: 'parked',
        wakeAt: this.now() + result.park.afterMs,
        reason: result.park.reason,
        usage,
        inputPatch: {
          __agentTimerReason: result.park.reason,
          ...(checkpoint !== undefined ? { __continuationCheckpoint: checkpoint } : {}),
        },
      }
    }
    if (result.kind !== 'completed') {
      if (result.kind === 'aborted') {
        return {
          kind: 'retry',
          reason: `Agent execution aborted for task '${result.taskId}'`,
          usage,
          consumeAttempt: false,
        }
      }
      return retryableAgentFailure(node, activation, `Agent execution ${result.kind} for task '${result.taskId}'`, usage)
    }
    if (!result.success) {
      if (activation.attempt < (node.maxAttempts ?? 3)) {
        return {
          kind: 'retry',
          reason: result.error ?? 'Agent execution failed',
          usage,
          consumeAttempt: true,
          delayMs: retryDelayMs(activation.attempt),
        }
      }
      return {
        kind: 'completed',
        outcome: 'failure',
        output: { error: result.error ?? 'agent execution failed', summary: result.summary },
        summary: result.summary ?? result.error ?? 'Agent execution failed',
        usage,
      }
    }
    const raw = result.output ?? result.summary
    if (!isJsonValue(raw)) return { kind: 'completed', outcome: 'failure', output: { error: 'agent output is not JSON' }, summary: 'Agent output is not valid JSON', usage }
    if (node.outputSchema) {
      const errors = validateShape(raw, node.outputSchema, '$output')
      if (errors.length) return { kind: 'completed', outcome: 'failure', output: { error: 'output schema mismatch', details: errors }, summary: `Agent output schema mismatch: ${errors.join('; ')}`, usage }
    }
    return { kind: 'completed', outcome: 'success', output: raw, summary: result.summary, usage }
  }

  private async executeFunction(node: Extract<NodeSpec, { type: 'function' }>, activation: ActivationRecord, state: GraphStateSnapshot): Promise<NodeExecutionResult> {
    try {
      const inputs = await evaluateBindings(node.inputs, this.context(activation, state), this.deps.functions)
      const output = await this.deps.functions.get(node.function).execute(inputs)
      if (!isJsonValue(output)) throw new Error('function returned a non-JSON value')
      const errors = node.outputSchema ? validateShape(output, node.outputSchema, '$output') : []
      if (errors.length) throw new Error(errors.join('; '))
      return { kind: 'completed', outcome: 'success', output }
    } catch (error) {
      return { kind: 'completed', outcome: 'failure', output: { error: message(error) } }
    }
  }

  private async executeEffect(node: Extract<NodeSpec, { type: 'effect' }>, activation: ActivationRecord, state: GraphStateSnapshot): Promise<NodeExecutionResult> {
    if (!this.deps.effects) throw new Error('Effect executor requires an Effect registry')
    const provider = this.deps.effects.get(node.effect)
    try {
      const elapsed = activation.firstStartedAt === undefined ? 0 : Math.max(0, this.now() - activation.firstStartedAt)
      if (node.timeoutMs !== undefined && elapsed >= node.timeoutMs) {
        return { kind: 'completed', outcome: 'failure', output: { error: `effect deadline ${node.timeoutMs}ms exceeded` } }
      }
      const inputs = await evaluateBindings(node.inputs, this.context(activation, state), this.deps.functions)
      const idempotencyKey = node.idempotencyKey
        ? String(await evaluateValueExpression(node.idempotencyKey, this.context(activation, state), this.deps.functions))
        : `${this.deps.instance.instanceId}:${activation.id}`
      const operationKey = activation.id
      const intent = await this.deps.store.prepareEffectIntent({
        operationKey,
        activationId: activation.id,
        continuationVersion: activation.continuationVersion,
        effect: node.effect,
        idempotencyKey,
        input: inputs,
      }, this.now())
      if (intent.status === 'succeeded') return { kind: 'completed', outcome: 'success', output: intent.output ?? intent.receipt ?? null }
      if (intent.status === 'failed') return { kind: 'completed', outcome: 'failure', output: { error: intent.error ?? 'effect failed', receipt: intent.receipt ?? null } }
      const existing = activation.input.__effectReceipt ?? intent.receipt
      const receipt = existing ?? await provider.submit(inputs, idempotencyKey)
      await this.deps.store.recordEffectReceipt(operationKey, receipt, this.now())
      if (!provider.inspect) {
        await this.deps.store.completeEffectIntent(operationKey, { status: 'succeeded', output: receipt }, this.now())
        return { kind: 'completed', outcome: 'success', output: receipt }
      }
      const inspection = await provider.inspect(receipt)
      if (inspection.status === 'succeeded') {
        const output = inspection.output ?? receipt
        await this.deps.store.completeEffectIntent(operationKey, { status: 'succeeded', output }, this.now())
        return { kind: 'completed', outcome: 'success', output }
      }
      if (inspection.status === 'failed') {
        const error = inspection.error ?? 'effect failed'
        await this.deps.store.completeEffectIntent(operationKey, { status: 'failed', error }, this.now())
        return { kind: 'completed', outcome: 'failure', output: { error, receipt } }
      }
      const remaining = node.timeoutMs === undefined ? 30_000 : Math.max(1, node.timeoutMs - elapsed)
      return {
        kind: 'parked',
        wakeAt: this.now() + Math.min(remaining, 30_000),
        reason: `poll effect ${node.effect}`,
        inputPatch: { __effectReceipt: receipt },
      }
    } catch (error) {
      return { kind: 'completed', outcome: 'failure', output: { error: message(error) } }
    }
  }

  private async executeWait(node: Extract<NodeSpec, { type: 'wait' }>, activation: ActivationRecord, state: GraphStateSnapshot): Promise<NodeExecutionResult> {
    const resumed = activation.input.__resume
    if (resumed !== undefined) {
      const resumeKind = isJsonObject(resumed) ? resumed.kind : undefined
      const outcome = node.wait.kind === 'event' && resumeKind === 'timer' ? 'timeout' : node.wait.kind
      return { kind: 'completed', outcome, output: resumed }
    }
    if (node.wait.kind === 'timer') {
      const raw = await evaluateValueExpression(node.wait.delayMs, this.context(activation, state), this.deps.functions)
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return { kind: 'completed', outcome: 'failure', output: { error: 'timer delay must be positive milliseconds' } }
      if (node.wait.maxDelayMs !== undefined && raw > node.wait.maxDelayMs) return { kind: 'completed', outcome: 'failure', output: { error: `timer delay exceeds ${node.wait.maxDelayMs}` } }
      return { kind: 'parked', wakeAt: this.now() + raw, reason: `wait ${raw}ms` }
    }
    const correlation = node.wait.correlation
      ? await evaluateValueExpression(node.wait.correlation, this.context(activation, state), this.deps.functions)
      : undefined
    return {
      kind: 'parked',
      event: { name: node.wait.event, correlation },
      ...(node.wait.timeoutMs !== undefined ? { wakeAt: this.now() + node.wait.timeoutMs } : {}),
      reason: `wait event ${node.wait.event}`,
    }
  }

  private async executeJoin(node: Extract<NodeSpec, { type: 'join' }>, activation: ActivationRecord, snapshot: GraphSnapshot): Promise<NodeExecutionResult> {
    const candidates = [...snapshot.activations.values()].filter(item =>
      item.nodeId === activation.nodeId && item.sourceTransitionId && node.expects.includes(item.sourceTransitionId) &&
      item.forkGroupId === activation.forkGroupId &&
      ['ready', 'running', 'waiting'].includes(item.status),
    )
    const arrived = new Set(candidates.map(item => item.sourceTransitionId!))
    const complete = node.mode === 'any' ? arrived.size > 0 : node.expects.every(id => arrived.has(id))
    const leader = [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0]
    if (!complete || leader?.id !== activation.id) {
      return { kind: 'parked', event: { name: `join:${activation.nodeId}` }, reason: 'join barrier incomplete or coalesced' }
    }
    return {
      kind: 'completed',
      outcome: 'success',
      output: Object.fromEntries(candidates.map(item => [item.sourceTransitionId!, item.input])),
    }
  }

  private async executeTerminal(node: Extract<NodeSpec, { type: 'terminal' }>, activation: ActivationRecord, state: GraphStateSnapshot): Promise<NodeExecutionResult> {
    const output = node.result
      ? await evaluateValueExpression(node.result, this.context(activation, state), this.deps.functions)
      : activation.input
    return { kind: 'completed', outcome: 'success', output }
  }

  private context(activation: ActivationRecord, state: GraphStateSnapshot) {
    return { state: state.values, input: activation.input, clock: { now: this.now() } }
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function remainingSegmentLimits(
  node: Extract<NodeSpec, { type: 'agent' }>,
  activation: ActivationRecord,
  now: number,
): { turns: number; usd: number; wallTimeMs?: number } | { error: string } {
  const used = activation.usage ?? { turns: 0, costUsd: 0, durationMs: 0 }
  const lifetime = node.lifetimeBudget
  const remainingTurns = lifetime?.turns === undefined ? Number.POSITIVE_INFINITY : lifetime.turns - used.turns
  const remainingUsd = lifetime?.usd === undefined ? Number.POSITIVE_INFINITY : lifetime.usd - used.costUsd
  const elapsed = activation.firstStartedAt === undefined ? 0 : Math.max(0, now - activation.firstStartedAt)
  const remainingElapsed = lifetime?.elapsedMs === undefined ? Number.POSITIVE_INFINITY : lifetime.elapsedMs - elapsed
  if (remainingTurns < 1) return { error: 'Agent Activation lifetime turn budget exhausted' }
  if (remainingUsd <= 0) return { error: 'Agent Activation lifetime USD budget exhausted' }
  if (remainingElapsed <= 0) return { error: 'Agent Activation lifetime elapsed budget exhausted' }
  const segmentTurns = node.budget?.turns ?? 30
  const segmentUsd = node.budget?.usd ?? 2
  const segmentWallTime = node.budget?.wallTimeMs ?? node.timeoutMs
  const wallTimeMs = Math.min(segmentWallTime ?? Number.POSITIVE_INFINITY, remainingElapsed)
  return {
    turns: Math.max(1, Math.floor(Math.min(segmentTurns, remainingTurns))),
    usd: Math.min(segmentUsd, remainingUsd),
    ...(Number.isFinite(wallTimeMs) ? { wallTimeMs: Math.max(1, Math.floor(wallTimeMs)) } : {}),
  }
}

function retryableAgentFailure(
  node: Extract<NodeSpec, { type: 'agent' }>,
  activation: ActivationRecord,
  reason: string,
  usage?: ActivationUsage,
): NodeExecutionResult {
  if (activation.attempt >= (node.maxAttempts ?? 3)) {
    return { kind: 'completed', outcome: 'failure', output: { error: reason }, summary: reason, usage }
  }
  return { kind: 'retry', reason, usage, consumeAttempt: true, delayMs: retryDelayMs(activation.attempt) }
}

function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1))
}

function laneMayWriteWorkspaceBinding(
  graph: FrozenLoopGraphSpec,
  laneId: string,
  bindingId: string,
  physicalRole: string,
): boolean {
  if (graph.compiledLaneDataAccess) {
    return graph.compiledLaneDataAccess[laneId]?.writeBindings.includes(bindingId) ?? false
  }
  return physicalRole === 'observability'
}

function reserveUnknownCost(usage: ActivationUsage, segmentBudgetUsd: number): ActivationUsage {
  return { ...usage, costUsd: Math.max(usage.costUsd, segmentBudgetUsd) }
}
