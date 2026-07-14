/**
 * Seats — the LLM slots of a loop round (spec C7 seats; D5/D6).
 *
 * worker  — does the intelligent work. Task = capsule + charter prompt +
 *           output contract (drafts + return_result). Lineage is per ROUND:
 *           a corrective retry carries the previous attempt's summary and the
 *           gate's messages; a new round starts a blank session.
 * judge   — isolated verdict. Its task embeds the EVIDENCE FILE CONTENTS
 *           inline (size-capped) and grants no tools: independence is a
 *           property of its inputs, not an instruction. It cannot wander into
 *           the worker's transcript because there is no channel to it.
 * pivoter — isolated, low-frequency; produces a structural directive the
 *           kernel injects into the same round's capsule.
 * finalizer — isolated, runs ONCE at graceful finalize; writes the narrative
 *           section of the final report from inlined ledger evidence.
 */
import { readFile } from 'fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'path'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { MetaAgentTool } from '../../core/types.js'
import { makeTimerTool, type TimerIntent } from '../../subagent/tools/timer.js'
import { createSkillTool } from '../../tools/system/skill/index.js'
import { resolveConfiguredWriteAllowPaths } from '../../sandbox/configuredWritePaths.js'
import type { SandboxConfig } from '../../sandbox/types.js'
import { spawnAndWaitDetailed, type SpawnWaitOptions, type SpawnWaitKind } from '../seatSpawn.js'
import { DEFAULT_SUB_AGENT_MAX_DURATION_MS } from '../../subagent/types.js'
import type { FrozenCharter, SeatSpec } from '../charter/CharterTypes.js'
import type { InstancePaths } from '../types.js'
import type { Capsule } from '../capsule/CapsuleBuilder.js'
import { renderCapsule } from '../capsule/CapsuleBuilder.js'
import { scenarioRuntimeFor } from '../scenarios/ScenarioRuntime.js'
import { DEFAULT_SCENARIO_ID } from '../scenarios/ScenarioDefinitions.js'
import { CharterEnforcementError, resolveExistingInside, resolveWriteScopeRoot } from '../security/PathSafety.js'
import { preflightCharterCapabilities } from '../security/CapabilityPreflight.js'
import { makeVcsPublishTool } from './VcsPublishTool.js'
import { ensureWorkspaceIdentity, workspaceScopedLineage } from '../workspace/WorkspaceIdentity.js'
import type { WorkspaceIdentity } from '../workspace/WorkspaceIdentity.js'
import {
  assembleInnerWorkerSystemPrompt,
  renderInnerWorkerUserMessage,
  type InnerWorkerVariant,
} from './InnerOrchWorker.js'

const EVIDENCE_CAP_CHARS = 6_000
const WORKSPACE_EVIDENCE_CAP_CHARS = 24_000
const DEFAULT_WORKER_TOOLS = ['read_file', 'edit_file', 'write_file', 'grep', 'glob', 'bash']

export interface SeatResult {
  ok: boolean
  summary: string
  /** Structured payload from return_result (authoritative). */
  data: Record<string, unknown>
  /**
   * True when `data` came from the structured return_result output; false when
   * it was scraped from free text (last-JSON-block fallback). Control-flow
   * labels (e.g. label:'wait') must only be honored from structured payloads.
   */
  structured: boolean
  costUsd: number
  turnsUsed: number
  termination: SpawnWaitKind
  taskId: string
  /** Set when the worker parked itself via the timer tool (self_timer wait). */
  timer?: TimerIntent
}

export interface SeatRunnerDeps {
  dispatcher: ISubAgentDispatcher
  /** Workspace the worker operates on (taskDir, NOT the instance dir). */
  projectDir: string
  signal: AbortSignal
  spawnOpts?: SpawnWaitOptions
  hostCoordinator?: import('../host/HostSchedulerCoordinator.js').HostSchedulerCoordinator
  workspaceIdentity?: WorkspaceIdentity
  loopInstanceId?: string
}

/** seat.context → inner_orch_worker variant (spec D5). Both lineage modes
 * resume; their session ids differ in lifetime. */
function workerVariant(seat: SeatSpec): InnerWorkerVariant {
  return seat.context === 'isolated' ? 'isolated' : 'lineage'
}

export async function runWorkerSeat(
  deps: SeatRunnerDeps,
  charter: FrozenCharter,
  paths: InstancePaths,
  capsule: Capsule,
  correctivePreface?: string,
  budgetOverride?: { usd?: number },
): Promise<SeatResult> {
  const seat = charter.seats.worker
  try {
    await preflightCharterCapabilities(charter, deps.projectDir)
  } catch (error) {
    throw new CharterEnforcementError(
      `worker capability preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const variant = workerVariant(seat)
  // System = the lean inner_orch_worker prompt (loop-owned, externalPromptAssembly);
  // user = <context> capsule + round instruction + output contract.
  const systemPrompt = await assembleInnerWorkerSystemPrompt({
    seatPrompt: seat.prompt,
    projectDir: deps.projectDir,
    variant,
    writeScope: charter.writeScope,
    scratchDir: paths.scratchDir,
    requiredSkills: seat.skills,
    hostWritePaths: seat.hostRequirements?.writePaths,
    vcsPublishRemote: seat.capabilities?.vcsPublish
      ? (seat.capabilities.vcsPublish.remote ?? 'origin')
      : undefined,
    effectBindings: charter.effects,
  })
  const userMessage = renderInnerWorkerUserMessage({
    capsule,
    draftsDir: join(paths.draftsDir),
    preface: correctivePreface,
    outputContract: scenarioRuntimeFor(charter).producerOutputContract(paths.draftsDir, charter.artifacts),
  })
  // lineage → resume a stable per-(instance,worker) session across rounds;
  // isolated → fresh each round. instanceId is the .loop/<id> dir name.
  const workspaceIdentity = await ensureWorkspaceIdentity(deps.projectDir)
  const instanceId = basename(paths.root)
  const lineageSessionId = seat.context === 'lineage_loop'
    ? workspaceScopedLineage(workspaceIdentity, instanceId, 'worker')
    : seat.context === 'lineage_round'
      ? workspaceScopedLineage(workspaceIdentity, instanceId, `round:${capsule.round}:worker`)
      : undefined
  // Self-park channel: the worker may call timer(...) to be woken later this
  // round. Calling timer HARD-PARKS the segment — the sink records the intent
  // AND flips parkSignal, which the runner detects on the timer tool_result to
  // interrupt the session and terminate with {label:'wait'}. So the worker
  // cannot keep working after parking (no reliance on a follow-up return_result).
  let timerIntent: TimerIntent | null = null
  const parkSignal = { requested: false }
  const baseTools: MetaAgentTool[] = [
    makeTimerTool(i => { timerIntent = i; parkSignal.requested = true }),
    await createSkillTool(deps.projectDir, 'simple_auto'),
  ]
  if (seat.capabilities?.vcsPublish) {
    baseTools.push(makeVcsPublishTool({
      projectDir: deps.projectDir,
      instanceId,
      writeScope: charter.writeScope ?? [],
      remote: seat.capabilities.vcsPublish.remote,
    }))
  }
  // D7 made structural (T4.2): the ledger and instance internals are DENIED at
  // the sandbox level for the worker's bash — the prompt contract is the
  // instruction, this is the guarantee. Drafts/inbox stay writable.
  // Any writeScope resolution failure (missing literal, symlink escape, …) is a
  // charter/workspace mismatch — retrying the round can never fix it, so
  // surface it as CharterEnforcementError and let the runner fail-stop the
  // instance instead of hot-looping the wake.
  const scopeRoots = await Promise.all((charter.writeScope ?? []).map(async scope => {
    try {
      return await resolveWriteScopeRoot(deps.projectDir, scope)
    } catch (err) {
      if (err instanceof CharterEnforcementError) throw err
      throw new CharterEnforcementError(`writeScope '${scope}' cannot be enforced: ${(err as Error).message}`)
    }
  }))
  // Operator grants may expose host-local stores (for example an external CLI
  // state directory). Never inherit a configured path inside the workspace:
  // Charter writeScope remains the sole authority there.
  const externalWriteRoots = resolveConfiguredWriteAllowPaths(deps.projectDir)
    .filter(path => !pathIsUnder(path, deps.projectDir))
  const writeAllowPaths = [paths.draftsDir, paths.scratchDir, ...scopeRoots, ...externalWriteRoots]
  const sandbox: SandboxConfig = {
    readonlyWorkspace: true,
    writeAllowPaths,
    writeDenyPaths: [
      paths.ledgerDir,
      paths.frozenCharter,
      paths.instanceJson,
      paths.capsuleJson,
      paths.reportsDir,
      // Kernel INPUT channels, not just outputs: events/ would let the worker
      // conclude its own external wait, inbox/ would let it forge "human
      // feedback" into the next capsule, and the wake store is scheduler state
      // no seat may touch. Drafts stay writable (that IS the output channel).
      paths.eventsDir,
      paths.inboxDir,
      join(deps.projectDir, '.loop', 'wakes'),
    ],
  }
  const result = await runSeat(
    deps, seat, userMessage, DEFAULT_WORKER_TOOLS, sandbox, systemPrompt, lineageSessionId, baseTools, parkSignal,
    budgetOverride,
    { workspaceId: workspaceIdentity.workspaceId, instanceId },
  )
  return timerIntent ? { ...result, timer: timerIntent } : result
}

function pathIsUnder(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Judge output vocabulary — kernel-owned. The contract is appended AFTER the
 * charter's judge prompt, so at runtime it is the final word on output shape.
 * Charter observables may declare EXTRA keys beyond the core set; the kernel
 * injects them into the contract (buildJudgeContract), so "the charter names
 * an observable key" and "the judge is required to emit it" can never drift
 * apart — the kernel is the single authority over the judge's output schema.
 */
export const JUDGE_CORE_KEYS = [
  'verdict', 'new_findings_count', 'metric_delta', 'metric', 'goal_satisfied', 'messages',
] as const

/** Charter-declared judge observable keys OUTSIDE the core set (deduped, in
 * declaration order) — the keys the contract must additionally demand. */
export function extraJudgeKeys(charter: FrozenCharter): string[] {
  const core = new Set<string>(JUDGE_CORE_KEYS)
  const extras: string[] = []
  const obligations = charter.frozen?.observableObligations
  const judgeKeys = obligations
    ? Object.values(obligations)
        .filter(obligation => obligation.source === 'judge')
        .map(obligation => obligation.outputKey)
    : charter.observables
        .filter(observable => observable.source.from === 'judge')
        .map(observable => observable.source.key)
  for (const key of judgeKeys) {
    if (!core.has(key) && !extras.includes(key)) {
      extras.push(key)
    }
  }
  return extras
}

export function buildJudgeContract(extraKeys: string[], perFinding = false): string {
  const extraClause = extraKeys.length
    ? `\n【charter 观测字段（同样必须输出）】除上述固定字段外，data 还必须包含：${extraKeys.map(k => `"${k}"`).join('、')}。` +
      '其语义与取值标准以上方评审指令的定义为准；值只能是 number/boolean/string。' +
      '任何一个缺失都会让内核依赖它的规则失效，因此每轮都要输出全部字段。'
    : ''
  const findingClause = perFinding
    ? '\n【Research 逐条裁决】data 还必须包含 "accepted_finding_indexes"：本轮 findings_draft 数组中通过全部 rubric 的零基索引数组。不得因一条合格而放行同批不合格 finding；new_findings_count 必须等于该数组长度。'
    : ''
  const findingField = perFinding ? ',"accepted_finding_indexes":[<zero-based int>,...]' : ''
  return `\
你是隔离评审座位：你看不到执行座位的任何推理过程，只能依据下方内嵌证据作出裁决。
必须调用 return_result，data 写：
{"verdict":"pass"|"fail","new_findings_count":<int>,"metric_delta":<number>,"metric":<number|null>,"goal_satisfied":<bool>,"messages":["fail 时必须给出至少一条具体纠偏项"]${findingField}}${extraClause}
每个判断都要引用证据；无证据支撑的 finding 一律不计入 new_findings_count。
metric_delta 的符号与原始指标方向无关：大于 0 永远表示改善，小于 0 表示退化；原始 metric 的最优方向由 charter 定义。
【验收判断（内核据此结束 loop）】goal_satisfied：仅当有证据表明"目标（下方【验收目标】）"已实质达成/成功标准全部满足时才置 true；否则 false。宁可保守——一旦为 true，内核会终止整个 loop。${findingClause}`
}

export async function runJudgeSeat(
  deps: SeatRunnerDeps,
  charter: FrozenCharter,
  paths: InstancePaths,
  evidencePaths: string[],
  budgetOverride?: { usd?: number },
  lineageScope?: { workspaceId: string; instanceId: string },
): Promise<SeatResult> {
  const seat = charter.seats.judge
  if (!seat) throw new Error('charter has no judge seat')
  // A declared judge Gate owns both rubric and evidence. seat.inputs remains a
  // legacy fallback only for judge seats with no Gate-bound evidence.
  const evidence = await inlineEvidence(
    paths, deps.projectDir, evidencePaths.length > 0 ? evidencePaths : (seat.inputs ?? []),
  )
  const gateRubric = Object.entries(charter.gates)
    .filter(([, gate]) => gate.kind === 'judge')
    .map(([id, gate]) => `【Judge Gate rubric: ${id}】\n${gate.kind === 'judge' ? gate.rubric : ''}`)
    .join('\n\n')
  // The goal is injected by the kernel (not charter-specific) so the built-in
  // acceptance mechanism works for every loop with a judge.
  const task = [
    `【验收目标】${charter.goal}`,
    seat.prompt, gateRubric,
    buildJudgeContract(extraJudgeKeys(charter), charter.scenario === DEFAULT_SCENARIO_ID),
    '【证据（内嵌，只此为界）】', evidence,
  ].join('\n\n')
  // No tools: the judge's world is exactly the evidence block above.
  return runSeat(deps, seat, task, [], undefined, undefined, undefined, undefined, undefined, budgetOverride)
}

const PIVOTER_CONTRACT = `\
你是结构性转向座位。不要做参数微调建议——给出改变结构性约束/研究框架的新方向
（相反假设 / 换证据源 / 跨域类比 / 改评估指标）。
必须调用 return_result，data 写 {"directive":"<一段结构性转向指令>","key":"<新方向短标识>"}。`

export async function runPivoterSeat(
  deps: SeatRunnerDeps,
  charter: FrozenCharter,
  paths: InstancePaths,
  capsule: Capsule,
  budgetOverride?: { usd?: number },
): Promise<SeatResult> {
  const seat = charter.seats.pivoter
  if (!seat) throw new Error('charter has no pivoter seat')
  const evidence = await inlineEvidence(paths, deps.projectDir, seat.inputs ?? [])
  const task = [renderCapsule(capsule), seat.prompt, PIVOTER_CONTRACT, '【证据（内嵌）】', evidence]
    .filter(Boolean).join('\n\n')
  return runSeat(deps, seat, task, [], undefined, undefined, undefined, undefined, undefined, budgetOverride)
}

const FINALIZER_CONTRACT = `\
你是收尾叙事座位：loop 已终止，你为最终报告撰写叙事段。只依据下方内嵌证据，
概述：达成了什么、证据何在、未竟之处、值得后续跟进的方向。不要编造证据之外的结论。
必须调用 return_result，data 写 {"narrative":"<一段 markdown 叙事>"}。`

const FINALIZER_DEFAULT_INPUTS = ['ledger/progress.json', 'ledger/findings.jsonl', 'ledger/directions.json']

export async function runFinalizerSeat(
  deps: SeatRunnerDeps,
  charter: FrozenCharter,
  paths: InstancePaths,
  reason: string,
): Promise<SeatResult> {
  const seat = charter.seats.finalizer
  if (!seat) throw new Error('charter has no finalizer seat')
  const evidence = await inlineEvidence(paths, deps.projectDir, seat.inputs ?? FINALIZER_DEFAULT_INPUTS)
  const task = [
    `【终止原因】${reason}`,
    `【验收目标】${charter.goal}`,
    seat.prompt, FINALIZER_CONTRACT, '【证据（内嵌，只此为界）】', evidence,
  ].filter(Boolean).join('\n\n')
  // No tools: like the judge, the finalizer's world is exactly the evidence block.
  return runSeat(deps, seat, task, [])
}

// ── shared spawn plumbing ─────────────────────────────────────────────────────

async function runSeat(
  deps: SeatRunnerDeps,
  seat: SeatSpec,
  taskDescription: string,
  defaultTools: string[],
  sandbox?: SandboxConfig,
  /** inner_orch_worker: a loop-composed system prompt used verbatim. */
  systemPromptOverride?: string,
  /** inner_orch_worker lineage: stable session id to resume/persist across rounds. */
  lineageSessionId?: string,
  /** Instance-scoped tool objects (e.g. timer for the worker). */
  extraTools?: MetaAgentTool[],
  /** Shared park signal — a self-park tool flips it to end the segment (worker). */
  parkSignal?: { requested: boolean },
  budgetOverride?: { usd?: number },
  lineageScope?: { workspaceId: string; instanceId: string },
): Promise<SeatResult> {
  // Per-segment wall-clock: a research submit segment can legitimately need
  // >30 min (read + design + implement + submit). Configurable per charter;
  // the long wait BETWEEN segments costs nothing (the process is dead).
  const seatMaxDurationMs = seat.budgetPerRound?.wallclockMin
    ? seat.budgetPerRound.wallclockMin * 60_000
    : DEFAULT_SUB_AGENT_MAX_DURATION_MS
  // The OUTER poll must outlast the seat's own wall-clock, else spawnAndWait
  // abandons a still-running seat at the default 31 min and records "no record"
  // (worker ✗, cost 0) — which silently defeats wallclockMin. Track the cap + slack,
  // while respecting a larger daemon-provided override.
  const spawnOpts: SpawnWaitOptions = {
    ...deps.spawnOpts,
    maxWaitMs: Math.max(deps.spawnOpts?.maxWaitMs ?? 0, seatMaxDurationMs + 60_000),
  }
  const taskScope = lineageScope ?? (
    deps.workspaceIdentity
      ? { workspaceId: deps.workspaceIdentity.workspaceId, instanceId: deps.loopInstanceId ?? '$loop-seat' }
      : undefined
  )
  let spawn: Awaited<ReturnType<typeof spawnAndWaitDetailed>>
  spawn = await spawnAndWaitDetailed(
      deps.dispatcher,
      {
      taskDescription,
      allowedTools: seat.tools ?? defaultTools,
      maxTurns: seat.budgetPerRound?.turns ?? 30,
      maxBudgetUsd: Math.min(seat.budgetPerRound?.usd ?? 2, budgetOverride?.usd ?? Number.POSITIVE_INFINITY),
      ...(seat.budgetPerRound?.wallclockMin ? { maxDurationMs: seatMaxDurationMs } : {}),
      requireHumanApproval: false,
      useEventDriven: false,
      pollIntervalMs: 500,
      checkpointEveryNTurns: 0,
      projectDir: deps.projectDir,
      ...(sandbox ? { sandbox } : {}),
      ...(systemPromptOverride
        ? { systemPrompt: systemPromptOverride, externalPromptAssembly: true }
        : {}),
      ...(lineageSessionId ? { lineageSessionId } : {}),
      ...(taskScope ? {
        workspaceId: taskScope.workspaceId,
        loopInstanceId: taskScope.instanceId,
        ...(deps.hostCoordinator ? {
          hostCoordinatorRoot: deps.hostCoordinator.rootDir,
          hostMaxConcurrentModelCalls: deps.hostCoordinator.maxConcurrentModelCalls,
        } : {}),
      } : {}),
      ...(extraTools?.length ? { extraTools } : {}),
      ...(parkSignal ? { parkSignal } : {}),
      },
      deps.signal,
      spawnOpts,
    )
  const rec = spawn.record
  const result = rec?.result
  const { data, structured } = extractData(result?.output, result?.summary)
  // Surface the FAILURE REASON, not just the summary: failed spawns (API error,
  // "No tools resolved", timeout, …) write summary:'' and put the cause in
  // result.error — dropping it leaves an empty worker summary in the ledger and
  // makes daemon failures undiagnosable.
  const summary = result?.summary?.trim()
    ? result.summary
    : result?.error
      ? `seat failed: ${result.error}`
      : `seat did not complete (${rec?.status ?? 'no record'})`
  return {
    // label:'error' downgrades ok ONLY from the structured payload: a JSON
    // block scraped out of free text (structured=false) is not a control
    // signal — same trust boundary as label:'wait' in the kernel.
    ok: rec?.status === 'completed' && result?.success === true &&
      !(structured && data['label'] === 'error'),
    summary,
    data,
    structured,
    costUsd: result?.costUsd ?? 0,
    turnsUsed: result?.turnsUsed ?? 0,
    termination: spawn.kind,
    taskId: spawn.taskId,
  }
}

/** Prefer structured return_result output; fall back to the last JSON block.
 * `structured` records which path produced the data — free-text scrapes must
 * never drive control flow (e.g. label:'wait'). */
function extractData(
  output: unknown,
  summary?: string,
): { data: Record<string, unknown>; structured: boolean } {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return { data: output as Record<string, unknown>, structured: true }
  }
  if (typeof output === 'string') {
    const parsed = lastJsonBlock(output)
    if (parsed) return { data: parsed, structured: false }
  }
  if (summary) {
    const parsed = lastJsonBlock(summary)
    if (parsed) return { data: parsed, structured: false }
  }
  return { data: {}, structured: false }
}

function lastJsonBlock(text: string): Record<string, unknown> | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1] ?? '')
  const candidates = fences.length ? fences : [text]
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]!.trim()) as unknown
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>
    } catch { /* next */ }
  }
  return null
}

async function inlineEvidence(
  paths: InstancePaths,
  projectDir: string,
  relPaths: string[],
): Promise<string> {
  const sections: string[] = []
  for (const rel of relPaths) {
    let abs: string
    const workspaceEvidence = rel.startsWith('workspace:')
    try {
      abs = workspaceEvidence
        ? await resolveExistingInside(projectDir, rel.slice('workspace:'.length))
        : await resolveExistingInside(paths.root, rel)
    } catch (err) {
      // Unsafe paths and symlink escapes are configuration/security failures,
      // not optional missing evidence. Preserve fail-closed behavior.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      sections.push(`--- ${rel} ---\n(不存在)`)
      continue
    }
    try {
      const raw = await readFile(abs, 'utf-8')
      const limit = workspaceEvidence ? WORKSPACE_EVIDENCE_CAP_CHARS : EVIDENCE_CAP_CHARS
      const capped = raw.length > limit ? raw.slice(-limit) : raw
      sections.push(`--- ${rel} ---\n${capped}`)
    } catch {
      sections.push(`--- ${rel} ---\n(不存在)`)
    }
  }
  return sections.join('\n\n') || '(无证据文件)'
}
