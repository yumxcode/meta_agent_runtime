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
import { retryDelayMs } from './UsageMath.js'

export const DEFAULT_AGENT_SEGMENT_BUDGET_USD = 10

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
  lanes?: LaneManager
  signal?: AbortSignal
  now?: () => number
  hostCoordinatorRoot?: string
  maxConcurrentModelCalls?: number
}

export class NodeExecutorRegistry {
  constructor(private readonly deps: NodeExecutorDeps) {}

  async execute(activation: ActivationRecord, snapshot: GraphSnapshot, executionSignal?: AbortSignal): Promise<NodeExecutionResult> {
    const node = this.deps.graph.nodes[activation.nodeId]
    if (!node) throw new Error(`unknown node '${activation.nodeId}'`)
    switch (node.type) {
      case 'agent': return this.executeAgent(node, activation, snapshot.state, executionSignal)
      case 'function': return this.executeFunction(node, activation, snapshot.state)
      case 'effect': return this.executeEffect(node, activation, snapshot.state)
      case 'wait': return this.executeWait(node, activation, snapshot.state)
      case 'join': return this.executeJoin(node, activation, snapshot)
      case 'terminal': return this.executeTerminal(node, activation, snapshot.state)
    }
  }

  private async executeAgent(node: Extract<NodeSpec, { type: 'agent' }>, activation: ActivationRecord, state: GraphStateSnapshot, executionSignal?: AbortSignal): Promise<NodeExecutionResult> {
    if (!this.deps.graphAgent || !this.deps.lanes) {
      throw new Error('Agent node requires graph_agent and LaneManager')
    }
    if (activation.attempt > (node.maxAttempts ?? 3)) return { kind: 'completed', outcome: 'failure', output: { error: 'maxAttempts exceeded' }, summary: 'Agent maxAttempts exceeded' }
    const binding = await this.deps.lanes.bind(node.lane, activation)
    let nodeInputs: Record<string, JsonValue>
    try {
      nodeInputs = await evaluateBindings(node.inputs, this.context(activation, state), this.deps.functions)
    } catch (error) {
      return { kind: 'completed', outcome: 'failure', output: { error: `agent input evaluation failed: ${message(error)}` }, summary: 'Agent input evaluation failed' }
    }
    const signal = executionSignal ?? this.deps.signal ?? new AbortController().signal
    const segmentLimits = remainingSegmentLimits(node, activation, this.now())
    if ('error' in segmentLimits) {
      return { kind: 'completed', outcome: 'exhausted', output: { error: segmentLimits.error, limit: 'activation_lifetime' }, summary: segmentLimits.error }
    }
    let result: Awaited<ReturnType<GraphAgentExecutor['execute']>>
    try {
      result = await this.deps.graphAgent.execute({
        profile: GRAPH_AGENT_PROFILE,
        prompt: {
          system: buildGraphAgentSystemPrompt({
            laneInstructions: this.deps.graph.lanes[node.lane]?.agentProfile?.systemInstructions,
            nodeInstructions: node.systemInstructions,
            declaredSkills: node.skills,
          }),
          user: buildGraphAgentUserPrompt({
            nodeInputs: {
              ...nodeInputs,
              ...(activation.continuationVersion > 0 ? {
                __resume_context: {
                  reason: activation.input.__agentTimerReason ?? activation.summary ?? 'durable continuation resumed',
                  checkpoint: activation.input.__continuationCheckpoint ?? null,
                  signal: activation.input.__resume ?? null,
                },
              } : {}),
              __activation: {
                id: activation.id,
                attempt: activation.attempt,
                continuationVersion: activation.continuationVersion,
                stateVersion: state.version,
              },
            },
            workspace: this.deps.graph.lanes[node.lane]!.workspace,
            instruction: node.prompt,
            outputSchema: node.outputSchema,
          }),
        },
        allowedTools: [...new Set([
          ...(node.tools ?? ['read_file', 'edit_file', 'write_file', 'append_file', 'grep', 'glob', 'bash']),
          ...(node.skills?.length ? ['skill'] : []),
        ])],
        limits: segmentLimits,
        workspace: this.agentWorkspace(node.lane, binding),
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
    if (result.kind === 'exhausted') {
      return {
        kind: 'completed',
        outcome: 'exhausted',
        output: { error: result.reason, limit: 'executor_budget' },
        summary: result.reason,
        usage,
      }
    }
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
      const output = await withTimeout((async () => {
        const inputs = await evaluateBindings(node.inputs, this.context(activation, state), this.deps.functions)
        return this.deps.functions.get(node.function).execute(inputs)
      })(), node.timeoutMs, `function ${node.function}`)
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
      const submitted = existing ?? await provider.submit(inputs, idempotencyKey)
      // The first durably recorded receipt wins; a resubmission may return a
      // receipt with nondeterministic fields.
      const recorded = await this.deps.store.recordEffectReceipt(operationKey, submitted, this.now())
      const receipt = recorded.receipt ?? submitted
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
    // A lease-expiry replay re-executes this segment. Reuse the absolute
    // deadline fixed on first park so the timer does not drift longer.
    const fixedDeadline = typeof activation.input.__timerDeadline === 'number' && Number.isFinite(activation.input.__timerDeadline)
      ? activation.input.__timerDeadline
      : undefined
    if (node.wait.kind === 'timer') {
      if (fixedDeadline !== undefined) return { kind: 'parked', wakeAt: fixedDeadline, reason: `wait until ${fixedDeadline}` }
      const raw = await evaluateValueExpression(node.wait.delayMs, this.context(activation, state), this.deps.functions)
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return { kind: 'completed', outcome: 'failure', output: { error: 'timer delay must be positive milliseconds' } }
      if (node.wait.maxDelayMs !== undefined && raw > node.wait.maxDelayMs) return { kind: 'completed', outcome: 'failure', output: { error: `timer delay exceeds ${node.wait.maxDelayMs}` } }
      const wakeAt = this.now() + raw
      return { kind: 'parked', wakeAt, reason: `wait ${raw}ms`, inputPatch: { __timerDeadline: wakeAt } }
    }
    const correlation = node.wait.correlation
      ? await evaluateValueExpression(node.wait.correlation, this.context(activation, state), this.deps.functions)
      : undefined
    const timeoutAt = fixedDeadline ?? (node.wait.timeoutMs !== undefined ? this.now() + node.wait.timeoutMs : undefined)
    return {
      kind: 'parked',
      event: { name: node.wait.event, correlation },
      ...(timeoutAt !== undefined ? { wakeAt: timeoutAt, inputPatch: { __timerDeadline: timeoutAt } } : {}),
      reason: `wait event ${node.wait.event}`,
    }
  }

  private async executeJoin(node: Extract<NodeSpec, { type: 'join' }>, activation: ActivationRecord, snapshot: GraphSnapshot): Promise<NodeExecutionResult> {
    const resumed = activation.input.__resume
    if (isJsonObject(resumed) && resumed.kind === 'timer') {
      return { kind: 'completed', outcome: 'timeout', output: resumed }
    }
    const candidates = [...snapshot.activations.values()].filter(item =>
      item.nodeId === activation.nodeId && item.sourceTransitionId && node.expects.includes(item.sourceTransitionId) &&
      item.forkGroupId === activation.forkGroupId &&
      ['ready', 'running', 'waiting'].includes(item.status),
    )
    const arrived = new Set(candidates.map(item => item.sourceTransitionId!))
    const complete = node.mode === 'any' ? arrived.size > 0 : node.expects.every(id => arrived.has(id))
    const leader = [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0]
    if (!complete || leader?.id !== activation.id) {
      // Correlate on the fork group so one group's arrival does not wake every
      // parked Join member of unrelated groups.
      return {
        kind: 'parked',
        event: { name: `join:${activation.nodeId}`, correlation: activation.forkGroupId ?? null },
        ...(node.timeoutMs !== undefined ? {
          wakeAt: typeof activation.input.__joinDeadline === 'number'
            ? activation.input.__joinDeadline
            : (activation.firstStartedAt ?? this.now()) + node.timeoutMs,
          inputPatch: {
            __joinDeadline: typeof activation.input.__joinDeadline === 'number'
              ? activation.input.__joinDeadline
              : (activation.firstStartedAt ?? this.now()) + node.timeoutMs,
          },
        } : {}),
        reason: 'join barrier incomplete or coalesced',
      }
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

  /**
   * Direct-workspace contract handed to graph_agent. `.loop`/`.meta-agent` are
   * always Kernel-protected. `.git` at the project root is denied by default;
   * a Lane with `scm: 'git'` opts in to commit/push mechanics — `.git` joins
   * the write allow list while `.git/hooks` and `.git/config` (code-execution
   * and credential surfaces) stay denied. Seatbelt/bwrap profiles apply denies
   * after allows, so the nested denies win. Nested repos below an owned write
   * prefix are unaffected either way: only the project-root `.git` is special.
   */
  private agentWorkspace(laneId: string, binding: { projectDir: string; workspaceMode: import('../../../subagent/types.js').SubAgentWorkspaceMode }) {
    const lane = this.deps.graph.lanes[laneId]
    const gitScm = lane?.scm === 'git'
    return {
      projectDir: binding.projectDir,
      mode: binding.workspaceMode,
      writeAllowPaths: binding.workspaceMode === 'shared_write'
        ? [
            ...(lane?.workspace.write ?? []).map(rule => resolve(binding.projectDir, rule.path)),
            ...(gitScm ? [join(binding.projectDir, '.git')] : []),
          ]
        : [],
      writeDenyPaths: [
        join(binding.projectDir, '.loop'),
        join(binding.projectDir, '.meta-agent'),
        ...(gitScm
          ? [join(binding.projectDir, '.git', 'hooks'), join(binding.projectDir, '.git', 'config')]
          : [join(binding.projectDir, '.git')]),
        ...(lane?.workspace.deny ?? []).map(path => resolve(binding.projectDir, path)),
      ],
    }
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, label: string): Promise<T> {
  if (timeoutMs === undefined) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout ${timeoutMs}ms exceeded`)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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
  const segmentUsd = node.budget?.usd ?? DEFAULT_AGENT_SEGMENT_BUDGET_USD
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

function reserveUnknownCost(usage: ActivationUsage, segmentBudgetUsd: number): ActivationUsage {
  return { ...usage, costUsd: Math.max(usage.costUsd, segmentBudgetUsd) }
}
