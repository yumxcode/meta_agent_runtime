import type { GraphRuntimeCatalog } from '../runtime/GraphCatalog.js'
import type { LoopGraphSpec } from '../spec/GraphTypes.js'
import { freezeLoopGraph, validateLoopGraph } from '../spec/GraphValidate.js'
import type { GraphDistillExecutor, GraphDistillPhase } from './ForegroundGraphDistillExecutor.js'

export interface DistillGraphResult {
  graph: LoopGraphSpec
  taskSpec: string
  attempts: number
}

/** Filesystem entrypoint for a Distill session. The host supplies only the
 * requirement reference and workspace identity; the Compiler must use its
 * read-only tools to discover the actual requirement and relevant project state. */
export interface DistillSource {
  requirement: string
  projectDir: string
}

/** Scenario-neutral source graph embedded verbatim in the Compiler prompt.
 * Tests validate and Freeze this exact object so the example cannot drift from
 * the executable ABI. It demonstrates nesting/dataflow, not domain topology. */
export const CANONICAL_GRAPH_DISTILL_EXAMPLE: LoopGraphSpec = {
  schemaVersion: 'graph-1.0',
  id: 'bounded_iterative_loop',
  version: 1,
  goal: 'Iterate until the semantic worker reports completion, otherwise fail cleanly.',
  state: {
    iteration: {
      type: { type: 'integer', minimum: 0 },
      initial: 0,
      description: 'Number of committed iterations.',
    },
  },
  lanes: {
    work: {
      context: 'persistent',
      workspace: 'readonly',
      maxConcurrency: 1,
      description: 'One continuous semantic work context.',
    },
  },
  nodes: {
    work: {
      type: 'agent',
      lane: 'work',
      prompt: 'Perform one bounded iteration and report whether the goal is complete.',
      inputs: { iteration: { ref: '$state.iteration' } },
      outputSchema: {
        type: 'object',
        required: ['complete', 'summary'],
        properties: {
          complete: { type: 'boolean' },
          summary: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
      tools: ['read_file'],
      maxAttempts: 3,
      budget: { turns: 20, usd: 1, wallTimeMs: 600_000 },
    },
    done: { type: 'terminal', status: 'done', result: { ref: '$input.result' } },
    failed: { type: 'terminal', status: 'failed', result: { ref: '$input.error' } },
  },
  transitions: [
    {
      id: 'goal_reached', from: 'work', on: 'success',
      when: '$output.complete == true', priority: 100,
      to: { node: 'done', inputs: { result: { ref: '$output' } } },
    },
    {
      id: 'continue_work', from: 'work', on: 'success', default: true,
      updates: [{ target: 'iteration', reducer: 'builtin/increment@1' }],
      to: 'work',
    },
    {
      id: 'work_failed', from: 'work', on: 'failure',
      to: { node: 'failed', inputs: { error: { ref: '$output' } } },
    },
  ],
  entrypoints: [{ id: 'start', node: 'work' }],
  limits: { maxActivations: 100, maxWallTimeMs: 86_400_000, maxCostUsd: 20 },
  concurrency: { maxActivations: 1, maxPerNode: 1, stateConsistency: 'commit_latest' },
}

export interface DistillGraphDeps {
  executor: GraphDistillExecutor
  catalog: GraphRuntimeCatalog
  signal?: AbortSignal
  maxAttempts?: number
  /** Independent intent-equivalence review; enabled by default. */
  semanticReview?: boolean
  onProgress?: (event: GraphDistillProgressEvent) => void
}

export type GraphDistillProgressEvent =
  | { type: 'phase_started'; phase: GraphDistillPhase; attempt: number; maxAttempts: number }
  | { type: 'phase_completed'; phase: GraphDistillPhase; attempt: number }
  | { type: 'validation_passed'; attempt: number }
  | { type: 'validation_failed'; attempt: number; issues: string[] }
  | { type: 'semantic_review_accepted'; attempt: number }
  | { type: 'semantic_review_rejected'; attempt: number; issues: string[] }

export async function distillLoopGraph(source: DistillSource, deps: DistillGraphDeps): Promise<DistillGraphResult> {
  return compileLoopGraph(source, deps, (attempt, lastErrors) => [
    attempt > 1 ? `上一次 LoopGraphSpec 校验失败。逐项修复并返回完整图：\n${formatGraphValidationFeedback(lastErrors)}` : '',
    formatDistillSource(source),
  ].filter(Boolean).join('\n\n'))
}

/** Apply a user's follow-up constraints in the same foreground compiler conversation.
 * The full current draft is repeated as a durable anchor so compaction or a
 * caller restart cannot make the revision depend on hidden chat state. */
export async function reviseLoopGraph(
  source: DistillSource,
  current: Pick<DistillGraphResult, 'graph' | 'taskSpec'>,
  reviewFeedback: string,
  deps: DistillGraphDeps,
): Promise<DistillGraphResult> {
  const reviewSource = [
    formatDistillSource(source),
    '【用户在后续 Distill turn 中新增的约束与意见】',
    reviewFeedback,
  ].join('\n\n')
  return compileLoopGraph(source, deps, (attempt, lastErrors) => [
    '【后续 Distill turn】',
    '用户检查了已落盘的上一版 Graph，并给出了补充或纠正。基于当前草图继续修改，不要另起无关方案；返回完整的 {graph, taskSpec}。taskSpec 必须说明如何处理了本轮输入。',
    attempt > 1 ? `上一次修订仍未通过校验。逐项修复：\n${formatGraphValidationFeedback(lastErrors)}` : '',
    formatDistillSource(source),
    '【当前 Graph 草图】', JSON.stringify(current.graph),
    '【当前编译说明】', current.taskSpec,
    '【用户累计补充与纠正】', reviewFeedback,
  ].filter(Boolean).join('\n\n'), reviewSource)
}

async function compileLoopGraph(
  source: DistillSource,
  deps: DistillGraphDeps,
  buildTask: (attempt: number, lastErrors: string[]) => string,
  reviewSource = formatDistillSource(source),
): Promise<DistillGraphResult> {
  const maxAttempts = deps.maxAttempts ?? 3
  const signal = deps.signal ?? new AbortController().signal
  const systemPrompt = buildGraphDistillerSystem(deps.catalog)
  let lastErrors: string[] = []
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    deps.onProgress?.({ type: 'phase_started', phase: 'compiler', attempt, maxAttempts })
    const record = await deps.executor.execute({
      phase: 'compiler',
      sessionKey: 'distill-compiler',
      taskDescription: buildTask(attempt, lastErrors),
      systemPrompt,
      allowedTools: ['read_file', 'grep', 'glob', 'ask_user'],
      maxTurns: 24,
      maxBudgetUsd: 2,
      signal,
    })
    deps.onProgress?.({ type: 'phase_completed', phase: 'compiler', attempt })
    if (record.status !== 'completed') {
      lastErrors = [`foreground compiler ${record.status}: ${record.error ?? 'no terminal error detail'}`]
      deps.onProgress?.({ type: 'validation_failed', attempt, issues: lastErrors })
      continue
    }
    const parsed = parseGraphDistillOutput(record.output, record.summary)
    if (!parsed) {
      lastErrors = [`no parseable {graph, taskSpec}; foreground compiler status=${record.status} error=${record.error ?? '(none)'}`]
      deps.onProgress?.({ type: 'validation_failed', attempt, issues: lastErrors })
      continue
    }
    const errors = validateLoopGraph(parsed.graph, deps.catalog)
    if (!errors.length) {
      try {
        // Distill returns the logical source graph, but it must also survive the
        // exact logical-to-physical compilation Create will perform later.
        freezeLoopGraph(parsed.graph, deps.catalog, 0)
        deps.onProgress?.({ type: 'validation_passed', attempt })
        if (deps.semanticReview !== false) {
          const review = await reviewGraphSemantics(reviewSource, parsed, deps, signal, attempt)
          if (!review.accepted) {
            lastErrors = review.issues.length ? review.issues.map(issue => `semantic review: ${issue}`) : ['semantic review rejected the graph without details']
            deps.onProgress?.({ type: 'semantic_review_rejected', attempt, issues: review.issues })
            continue
          }
          deps.onProgress?.({ type: 'semantic_review_accepted', attempt })
        }
        return { ...parsed, attempts: attempt }
      } catch (error) {
        lastErrors = [error instanceof Error ? error.message : String(error)]
        deps.onProgress?.({ type: 'validation_failed', attempt, issues: lastErrors })
        continue
      }
    }
    lastErrors = errors
    deps.onProgress?.({ type: 'validation_failed', attempt, issues: lastErrors })
  }
  throw new Error(`graph distiller failed after ${maxAttempts} attempts:\n- ${lastErrors.join('\n- ')}`)
}

async function reviewGraphSemantics(
  sourceDescription: string,
  parsed: { graph: LoopGraphSpec; taskSpec: string },
  deps: DistillGraphDeps,
  signal: AbortSignal,
  attempt: number,
): Promise<{ accepted: boolean; issues: string[] }> {
  deps.onProgress?.({ type: 'phase_started', phase: 'semantic_review', attempt, maxAttempts: deps.maxAttempts ?? 3 })
  const record = await deps.executor.execute({
    phase: 'semantic_review',
    taskDescription: [
      sourceDescription,
      '【候选 Graph】', JSON.stringify(parsed.graph),
      '【机械提取的 producer→consumer 可见性清单】', formatGraphVisibilityManifest(parsed.graph),
      '【编译说明】', parsed.taskSpec,
    ].join('\n\n'),
    systemPrompt: buildGraphSemanticReviewerSystem(),
    allowedTools: ['read_file', 'grep', 'glob'],
    maxTurns: 12,
    maxBudgetUsd: 0.75,
    signal,
  })
  deps.onProgress?.({ type: 'phase_completed', phase: 'semantic_review', attempt })
  if (record.status !== 'completed') {
    return { accepted: false, issues: [`semantic reviewer ${record.status}: ${record.error ?? 'no terminal error detail'}`] }
  }
  const candidates: unknown[] = [record.output]
  if (typeof record.output === 'string') candidates.push(tryJson(record.output), ...extractJsonObjects(record.output))
  if (record.summary) candidates.push(...extractJsonObjects(record.summary))
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const object = candidate as Record<string, unknown>
    if (typeof object.accepted !== 'boolean') continue
    const issues = Array.isArray(object.issues) ? object.issues.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : []
    return { accepted: object.accepted, issues }
  }
  return { accepted: false, issues: [`semantic reviewer returned no parseable verdict; status=${record.status} error=${record.error ?? '(none)'}`] }
}

function formatGraphVisibilityManifest(graph: LoopGraphSpec): string {
  const lines: string[] = []
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (node.type !== 'agent') continue
    const consumes = (node.context?.sections ?? []).flatMap(section => {
      if (section.provider !== 'builtin/data-plane-view@1') return []
      const config = section.config
      const viewId = config && typeof config === 'object' && !Array.isArray(config) && typeof config['view'] === 'string'
        ? config['view'] : '(invalid)'
      const plane = viewId !== '(invalid)' ? graph.dataViews?.[viewId]?.plane : undefined
      return [`${viewId}${plane ? `@${plane}` : ''}`]
    })
    const publishes = (node.publishes ?? []).map(item => item.plane ?? item.channel ?? '(invalid)')
    lines.push([
      `node=${nodeId}`,
      `lane=${node.lane}`,
      `workspace=${graph.lanes[node.lane]?.workspace ?? '(missing)'}`,
      `reads=${JSON.stringify(node.reads ?? [])}`,
      `writes=${JSON.stringify(node.writes ?? [])}`,
      `consumes=${JSON.stringify(consumes)}`,
      `publishes=${JSON.stringify(publishes)}`,
    ].join(' '))
  }
  for (const [planeId, plane] of Object.entries(graph.dataPlanes ?? {})) if (plane.backend === 'workspace') {
    lines.push(`workspace-plane=${planeId} lane=${plane.binding.lane ?? '$project'} path=${plane.binding.path} direction=${plane.binding.direction} owner=${plane.binding.direction === 'ingest' ? 'workspace/input' : 'Kernel projection'}`)
  }
  return lines.length ? lines.join('\n') : '(no Agent or logical workspace dataflow)'
}

/** The semantic reviewer intentionally receives a smaller contract than the
 * compiler. It must understand what a valid graph means, while leaving ABI
 * checking to Validate/Freeze and preserving topology freedom. */
export function buildGraphSemanticReviewerSystem(): string {
  return `你是 Loop Graph 的独立语义审阅器。候选图已通过严格结构校验与 Freeze；不要重做 ABI lint，只检查它是否遗漏或违背用户目标、成功标准、时间/审批/失败边界、数据协议，以及是否把未具备的外部能力假定为已可用。

宿主不会向你注入需求正文。必须先根据 user prompt 中的需求文件入口和项目地址，使用 read_file 自行读取原始需求；必要时使用 glob、grep、read_file 检查与候选图关键假设直接相关的项目状态。不得仅凭候选图的 taskSpec 代替原始需求。

审阅时按以下实际执行语义理解候选图：
- Agent Node 可代表一个跨多次工具调用、上下文压缩和 timer continuation 的长生命周期 Activation，不是只执行一次 LLM 调用。因此用户列出的紧密阶段可合并在一个 Agent 中。
- persistent Lane 是共享语义上下文的边界，同 Lane Activation 串行；Workspace backend 独立选择。readonly/shared_controlled 共享项目根，lane_overlay 才创建隔离 worktree。
- State/Reducer/Transition/Wait 承载确定性计数、阈值、路由和时间；Agent outputSchema 中的命名标量可供程序路由，不需要另造 judge 角色。
- 任务可自定义逻辑 Data Plane/View；Freeze 将其编译为固定 State/Record/Journal/Workspace 后端。Lane dataAccess 是上限，Node context/publication 是实际读写。
- materialize workspace 文件的 canonical owner 是 Kernel，由 commit/recovery 幂等重建；不应再要求 Agent 双写。observability/bidirectional 且经 Lane ACL 授权的文件才能由 Agent 直接写。
- 必须逐条检查 producer→consumer 可见性：同 Lane 可使用声明的原始 workspace reads/writes；跨 Lane 的语义结果必须由 publication→Data View→consumer context 流转。不能假设 lane_overlay 文件会在 Terminal merge 前被另一 Lane 或项目根看到。
- 检查不同 Lane 的 writes 是否存在相同或父子路径重叠，以及 Agent writes 是否覆盖 Kernel-owned materialize projection；发现时要求合并 Lane、改用 Data Plane 或拆成不相交路径。
- Function/Effect/Context Provider 已由 Validate/Freeze 按当次 Catalog 锁定。Agent 也可用用户配置的 tool/Skill 完成外部工作；若 taskSpec 已明确列为运行前能力缺口，不要误认为图已承诺它可用。

不要规定节点数量、角色名称、Scenario 模板、研究/发布/合规固定字段，也不要因为有不同但合理的 Lane、Data Plane 或循环拓扑而拒绝。LLM 可以自由选择领域分解；只有明确矛盾、关键需求遗漏、不可执行能力、无界风险或数据所有权冲突才是 rejection。

只输出 JSON：{"accepted":true|false,"issues":["具体且可操作的问题"]}。`
}

function formatDistillSource(source: DistillSource): string {
  return [
    '【Distill 输入入口】',
    `用户的 Loop 需求是：${source.requirement}`,
    `项目地址是：${source.projectDir}`,
    '不要让宿主代读或假设需求正文。先使用 read_file 自行读取需求文件；再判断该 Loop 是否依赖项目当前结构、已有状态、进展、工具或约束，若依赖，使用 glob、grep、read_file 做最小充分检查后再生成 Graph。不得仅根据文件名猜测需求，也不要无目的遍历整个项目。',
  ].join('\n')
}

/** Turn low-level validator diagnostics into local, ABI-aware repair guidance.
 * The original errors remain authoritative; hints only explain the nesting or
 * invariant that commonly causes a family of errors. */
export function formatGraphValidationFeedback(errors: readonly string[]): string {
  const hints = new Set<string>()
  const joined = errors.join('\n')
  if (/state\.[^.]+\.(minimum|maximum|properties|required|enum|minLength|minItems) is not part|state\.[^.]+\.type must be a ShapeSpec object/.test(joined)) {
    hints.add('StateVariableSpec 与 ShapeSpec 是两层：state.x={"type":{"type":"integer","minimum":0},"initial":0}；minimum/properties 等只能放在内层 ShapeSpec。')
  }
  if (/outputSchema\.type (is invalid|must be)|below non-object schema type '\[object Object\]'/.test(joined)) {
    hints.add('outputSchema 本身直接就是 ShapeSpec：{"outputSchema":{"type":"object","properties":{...}}}；禁止写成 outputSchema.type={"type":"object",...}。')
  }
  if (/must be a ShapeSpec object|\.schema\.type is invalid|outputSchema\.type is invalid/.test(joined)) {
    hints.add('每个 ShapeSpec 必须是对象，且其直接 type 必须是字符串 object|array|string|number|integer|boolean|null；不要使用 JSON Schema 的 oneOf/$ref/nullable/format。')
  }
  if (/must contain exactly one of literal, ref, or call|must be a value expression|unsupported root/.test(joined)) {
    hints.add('ValueExpression 必须恰好是 {"literal":...}、{"ref":"$state.x"}、{"call":"id@version","args":[...]} 之一，不能直接写裸值或混合多个形式。')
  }
  if (/needs exactly one default transition|multiple default\/unconditional|must route outcome|conditional transitions sharing priority/.test(joined)) {
    hints.add('逐个 from+on 分组修路由：有条件边时恰好一个 default:true，条件边 priority 唯一；并覆盖该节点所有 success/failure/timer/event/timeout/resume outcome。')
  }
  if (/Data Plane|dataPlanes|dataViews|read access|publish access|workspace Plane/.test(joined)) {
    hints.add('检查逻辑数据链：Plane→View→Lane dataAccess→Node context/publication；Node 实际访问必须是 Lane ACL 的子集，workspace 直接写还必须满足 Lane ownership。')
  }
  if (/shared_controlled|workspaceAccess|conflicts across Lanes|cross-Lane semantic data|Kernel-owned Workspace projection/.test(joined)) {
    hints.add('原始 workspace 依赖必须声明 reads/writes；shared_controlled 还要声明 Lane workspaceAccess.write/deny。跨 Lane 语义结果改用 publication→Data View，或把强相关节点放进同一 Lane；不要让 Agent 写 Kernel materialize 路径。')
  }
  if (/Context Provider|context\.sections|config\.view|refresh/.test(joined)) {
    hints.add('Context section 只能引用目录中的 provider@version；逻辑 Plane 用 builtin/data-plane-view@1 + config.view，section name 唯一且不用 kernel_ 前缀。')
  }
  if (/hard park|timerPolicy|lifetimeBudget|budget\.(turns|usd|wallTimeMs)/.test(joined)) {
    hints.add('hard park Agent 必须位于 persistent Lane，并完整声明 segment budget、lifetimeBudget、timerPolicy.maxDelayMs/maxParks。')
  }
  return [
    '【Validator 原始错误】',
    ...errors.map(error => `- ${error}`),
    ...(hints.size ? ['【定向修复提示】', ...[...hints].map(hint => `- ${hint}`)] : []),
    '修复后仍必须返回完整 {graph,taskSpec}，不要只返回 patch。',
  ].join('\n')
}

export function buildGraphDistillerSystem(catalog: GraphRuntimeCatalog): string {
  const functions = catalog.functions.manifests()
    .map(manifest => formatCapability(manifest, 'registered Function'))
  const reducers = catalog.reducers.manifests()
    .map(manifest => formatCapability(manifest, 'registered Reducer'))
  const effects = catalog.effects.manifests()
    .map(manifest => formatCapability(manifest, 'registered Effect'))
  const packs = catalog.packs.list()
    .map(pack => `${pack.id}@${pack.version} integrity=${pack.integrity}`)
  const contextProviders = catalog.contextProviders.manifests()
    .map(manifest => [
      `${manifest.id}@${manifest.version} trust=${manifest.trust} — ${manifest.description ?? 'registered Context Provider'}`,
      ...(manifest.inputSchema ? [`config=${JSON.stringify(manifest.inputSchema)}`] : []),
    ].join(' '))
  const scenarioGuidance = catalog.packs.scenarios().map(scenario => [
    `${scenario.id} — ${scenario.description}`,
    `  Pack: ${scenario.pack.id}@${scenario.pack.version} integrity=${scenario.pack.integrity}`,
    ...scenario.guidance.map(item => `  - ${item}`),
    ...(scenario.suggestedCapabilities?.length ? [`  Suggested capabilities: ${scenario.suggestedCapabilities.join(', ')}`] : []),
    ...(scenario.graphFragments?.map(fragment => `  Optional fragment ${fragment.id} (${fragment.description}): ${JSON.stringify(fragment.fragment)}`) ?? []),
  ].join('\n'))
  return `你是 Meta-Agent 唯一现行 Loop 架构 durable-graph-v1 的 Distill Compiler。你的任务是把用户的自然语言长期任务编译成当前 Kernel 可直接校验、冻结、恢复和执行的 LoopGraphSpec。

【禁止使用旧 Loop 机制】
- 不得输出或假设 Charter、Scenario executor、round ledger、capsule、worker/judge/pivoter 固定角色、continue/pivot/finalize 固定路由、code node、任意 JS 节点或 legacy auto_orch Plan。
- 用户文档中的“每轮、worker、judge、pivot、code node、state_writer”等词只代表领域意图。必须翻译成下面的 Graph/Activation/Lane/State/Artifact/Function 语义，不能照抄为不存在的运行时类型。
- Research、Release、Compliance 都只是可由 Capability Pack 帮助生成的图，不拥有独立 Kernel 或固定字段。不得自动加入 totalFindings、directionsTried 等领域字段，除非当前用户任务确实需要它们。
- 只可引用下方实际注册的版本化能力。没有对应 Function/Effect 时不得虚构；可由 Agent 使用已授权工具完成的工作放入 Agent，否则在 taskSpec 明确列为部署前缺失能力。

【输出与交互协议】
只输出一个 JSON 对象，不要 Markdown fence、解释前缀或尾注。初次编译和校验修复使用：
{"graph":<LoopGraphSpec>,"taskSpec":"供人审阅的编译决策、假设、能力缺口、运行前配置和风险边界"}
后续 Distill turn 也返回同一结构的完整新草图，不能返回 patch。每个 turn 的草图都会经过结构校验、Freeze 和独立语义复核，全部通过后才覆盖输出文件。
若编译过程中缺少会实质改变拓扑、权限或运行边界的用户信息，可调用 ask_user 当场询问；对于非关键细节应作出保守、明确记录的假设，不要制造无意义的确认。
用户 prompt 只会提供需求文件入口和项目地址，不会注入需求文件正文。必须先用 read_file 自行读取需求；如果 Loop 设计依赖项目当前状态，再用 glob、grep、read_file 检查相关文件。只做与编译决策相关的最小充分发现，不要无边界扫描 workspace。

【当前执行模型】
1. Graph Node 是控制语义，不是一次聊天或一个 workspace writer。Kernel 调度的是 durable Activation。
2. Lane 是上下文、串行化和权限连续性边界，不等于 worktree。多个强相关 Agent Node 可共享一个 persistent Lane/session；readonly 共享根目录只读，shared_controlled 共享根目录并按 Lane/Node 路径上限写入，lane_overlay 才创建隔离 worktree，effect_only 不执行 Agent。不同 Lane 才可并行。Lane 可用 agentProfile.systemInstructions 声明稳定角色；Node 可用 systemInstructions 增加本 Activation 的系统约束。它们不能覆盖 Kernel protected system prompt。
3. 一个逻辑 Agent Activation 可跨多个物理执行 segment。Agent 调用 timer hard park 后，当前进程退出；wake 到期后以同一 activation id、同一 Lane lineage、递增 continuationVersion 恢复。attempt 不因 continuation 增加。
4. 紧密耦合的外部长任务——例如提交训练、周期观察、判断平台期、终止训练、提取结果——必须优先放进一个长生命周期 Agent Activation，不要机械拆成 submit/wait/inspect 多个 Agent。可以把后续结构性 pivot、独立审查、报告作为共享或独立 Lane 上的其他 Node。
5. Agent Node 统一通过专用 graph_agent SPI 执行。当前 Meta-Agent 适配器负责会话 resume 和上下文压缩并复用 Agentic KernelLoop，但不启用 Auto 的 Verify/Drift/Checkpoint 第二层编排。GraphSpec 不选择 SessionMode，也不得输出 mode 字段。
6. 每个 Agent 自动获得 Kernel 强制的最小 activation section；其他 State/Input/Evidence/Artifact/Clock/continuation 信息由 node.context.sections 显式选择。Runtime 不给每个节点注入全局最多 100 条 Evidence/Artifact。
7. Context section 只能使用下方注册且版本锁定的 Provider。activation_start 在逻辑 Activation 首段解析并持久缓存，timer/retry/process restart 后复用；every_segment 每段刷新；continuation_only 只在 continuationVersion>0 时刷新并注入。
8. Prompt section 由 Runtime 统一封装 name/provider/source/trust/refresh/resolvedAt/stateVersion/truncated/originalBytes/renderedBytes/content。Evidence、Artifact、Input 和 continuation 是 untrusted_data，不能冒充指令。
9. Agent/Function 可以并发计算，但 State、路由、Artifact publication 和下游 Activation 创建由 CommitCoordinator 在短事务中串行提交。commitKey、lease token、journal 和 checkpoint 负责幂等、崩溃恢复与 stale writer fencing。
10. daemon abort 是 replay，不是业务 failure；普通 Agent 故障受 maxAttempts 控制；无法确认取消时实例 fail-stop。因此图要提供业务 failure 路径，但不要设计“重启即失败”的补偿分支。
11. 用户可声明任意名字的逻辑 dataPlanes/dataViews，并由 Freeze 编译到 state、record、journal、workspace 固定后端。Kernel 不理解 semanticRole，也不包含 Research/Release/Compliance 分支。用户没有公共数据协议时可省略 dataPlanes/dataViews。
12. Lane dataAccess 是授权上限：read 针对 Plane/可选 View，publish 针对 record Plane，write 针对所属 Lane 的 workspace Plane。Node 仍必须用精确 Data View 和 publication 声明实际数据流。
13. Scenario guidance 是可组合的领域知识，不是固定模板。可以组合、改写或不用；不得因为匹配某个 Scenario 就生成固定角色、字段或拓扑。使用某 Pack 的 guidance/capability 时必须把该 Pack 精确写入 capabilityPacks。
14. Freeze 对 schema-backed 引用和 Capability input/output contract 做保守检查：能证明字段不存在时拒绝；没有 schema 的开放 Agent 输出仍可用。关键路由字段应提供闭合 outputSchema，探索性正文可以保持开放。
15. concurrency.stateConsistency 默认 commit_latest，允许并行计算后按提交顺序应用最新 State，吞吐最高；serializable 会在 State 变化后重放计算，只用于可安全重放的纯计算/只读 Agent，不能用来掩盖外部副作用或不可回滚 workspace 写入。
16. scheduler 的默认可观测性是低频阶段事件，不展示模型文本或工具调用。Node.description 是供人的稳定阶段名，应简短说明“当前处于什么阶段”；Agent 每个 segment 结束时由 graph_agent 的 return_result.summary 说明“为什么结束”，timer.reason 说明“在等待什么”，Kernel 会持久化并在恢复时展示。

【LoopGraphSpec 精确 ABI】
根对象只使用这些字段：
{
  "schemaVersion":"graph-1.0",
  "id":"字母开头，只含字母数字下划线或短横线",
  "version":正整数,
  "goal":"非空目标",
  "capabilityPacks":[{"id":"...","version":"...","integrity":"..."}],
  "state":{"name":{"type":<ShapeSpec>,"initial":<JSON>,"description":"..."}},
  "lanes":{"laneId":{"context":"persistent|fresh_per_activation","workspace":"readonly|shared_controlled|lane_overlay|effect_only","maxConcurrency":1,"description":"...","agentProfile":{"systemInstructions":"Lane 内稳定角色与行为约束"},"dataAccess":{"read":[{"plane":"逻辑Plane","views":["可选精确View"]}],"publish":["record Plane"],"write":["workspace Plane"]},"workspaceAccess":{"write":["允许直接写的相对路径前缀"],"deny":["始终禁止的相对路径前缀"]}}},
  "nodes":{"nodeId":<NodeSpec>},
  "transitions":[<TransitionSpec>],
  "entrypoints":[{"id":"...","node":"...","inputs":{"name":<ValueExpression>}}],
  "dataPlanes":{"planeId":<DataPlaneSpec>},
  "dataViews":{"viewId":<DataPlaneViewSpec>},
  "limits":{"maxActivations":正整数,"maxWallTimeMs":正数,"maxCostUsd":正数,"maxFanOut":正数,"maxPendingTimers":正数},
  "concurrency":{"maxActivations":正整数,"maxPerNode":正整数,"stateConsistency":"commit_latest|serializable"},
  "annotations":{"任意领域元数据":<JSON>}
}
capabilityPacks/dataPlanes/dataViews/concurrency 以及各可选字段可省略。Distill 不得输出物理 artifacts/artifactViews/evidenceViews/workspaceBindings、compiledDataPlanes、compiledLaneDataAccess、capabilityLock、graphHash、frozenAt、Activation、Wake、Journal 或 mode；这些由 Freeze/Kernel/部署配置决定。
- executable ABI 严格拒绝未知字段，避免拼错后被静默忽略；不影响执行的领域分类、解释或 UI 信息统一放 annotations。annotations 不产生任何 Kernel 语义。
- Graph id、State/Lane/Node/Transition/Entrypoint/Plane/View id 都必须匹配 ^[A-Za-z][A-Za-z0-9_-]{0,127}$；各自作用域内不得重复。不要把路径、空格或中文直接用作 id。

ShapeSpec 只支持：
- object: {"type":"object","required":[...],"properties":{"x":<ShapeSpec>},"additionalProperties":boolean}
- array: {"type":"array","minItems":整数,"items":<ShapeSpec>}
- string: {"type":"string","minLength":整数,"enum":[...]}
- number/integer: {"type":"number|integer","minimum":数,"maximum":数}
- boolean: {"type":"boolean"}
- null: {"type":"null"}
- ShapeSpec 最深 20 层；数值必须有限。未列出的 schema keyword 一律不是“提示信息”，而是 ABI 错误。

【ShapeSpec 嵌套规则——最容易生成错误，必须逐字遵守】
- ShapeSpec 是受限 schema，不是完整 JSON Schema。禁止 type 数组、oneOf/anyOf/allOf、$ref、definitions、const、default、nullable、format、pattern、maxLength、maxItems、uniqueItems 等未列字段；string enum 只能包含字符串。
- StateVariableSpec 与 ShapeSpec 是两层。State 变量外层只允许 type、initial、description；外层 type 的值才是 ShapeSpec：
  正确："iteration":{"type":{"type":"integer","minimum":0},"initial":0,"description":"..."}
  错误："iteration":{"type":"integer","minimum":0,"initial":0}
- Agent/Function 的 outputSchema 直接就是 ShapeSpec，不再套 StateVariableSpec 的 type 包装：
  正确："outputSchema":{"type":"object","required":["is_stale"],"properties":{"is_stale":{"type":"boolean"}},"additionalProperties":false}
  错误："outputSchema":{"type":{"type":"object","properties":{"is_stale":{"type":"boolean"}}}}
- 任何会被 when、transition input、update 或 publication 通过 $output.field 引用的字段，都必须位于当前节点 outputSchema.properties；建议 required 并将 object 设 additionalProperties:false。开放探索正文可省略 outputSchema，但一旦声明闭合 schema 就不能引用未声明字段。

所有 source Graph 可书写对象都只接受各自 ABI 字段。Graph、Lane、Node、Transition、Data Plane 可用 annotations 保存任意 JSON 领域元数据，但 annotations 不参与执行。Node 公共可选字段为 description、timeoutMs、publishes、annotations；不要把这些字段塞入 outputSchema。

【六种 NodeSpec】
1. Agent：
{"type":"agent","lane":"laneId","prompt":"明确职责和完成条件","systemInstructions":"可选的当前节点系统约束","context":{"sections":[<ContextSectionSpec>]},"inputs":{"name":<ValueExpression>},"outputSchema":<ShapeSpec>,"tools":["read_file","edit_file","write_file","grep","glob","bash"],"skills":["用户已配置的Skill"],"reads":["直接读取的workspace相对路径前缀"],"writes":["workspace相对路径前缀"],"maxAttempts":正整数,"budget":{"turns":正整数,"usd":正数,"wallTimeMs":正数},"lifetimeBudget":{"turns":正整数,"usd":正数,"elapsedMs":正数},"timerPolicy":{"allowHardPark":true,"maxDelayMs":正数,"maxParks":正整数},"publishes":[<ArtifactPublishSpec>],"description":"可选","timeoutMs":正数,"annotations":{"可选元数据":<JSON>}}
- 需要语义判断时由 Agent 输出有名字的标量字段，供确定性边判断。
- 使用 hard park 时必须是 persistent Lane，并完整提供 budget 三项、lifetimeBudget 三项、maxDelayMs 和 maxParks。
- reads/writes 是不带 glob 的 workspace 相对文件或目录前缀，不能含空段、.、.. 或运行时保留目录。reads 声明原始文件依赖以便 Freeze 做可见性检查；writes 是硬写沙箱。shared_controlled 的 Node writes 必须是 Lane workspaceAccess.write 的子集且不能碰 deny。
- 跨 Lane 不能用 raw workspace writes→reads 传递语义结果；必须 publication 到 record Plane并由 consumer 的精确 Data View context 读取，或把强相关节点放进同一 persistent Lane。不同 Lane writes 不能重叠，Agent writes 不能覆盖 Kernel materialize 文件。
- systemInstructions 和 Lane agentProfile 是 Distill 可控的 system 段，不得重复或对抗 Kernel 路由/权限规则；稳定角色优先放 Lane，单节点约束才放 Node。
- description 应填写简短、稳定、面向操作者的阶段名，不要复制整段 prompt。prompt 应明确要求最终 return_result.summary 用一句话说明本段完成了什么或为何停止；允许 timer 时也要要求 reason 明确说明等待条件。

ContextSectionSpec：
{"name":"节点内唯一名称","provider":"已注册id@版本","refresh":"activation_start|every_segment|continuation_only","config":<Provider专用JSON>,"required":true|false,"maxBytes":256..262144}
- 每个 Agent 最多 32 个 section；name 必须符合普通 id 规则、节点内唯一且不能以 kernel_ 开头。Kernel 已自动注入 builtin/activation@1，禁止再手工声明 activation section。
- maxBytes 省略时默认 32768；required 省略时等同 true。Provider 解析失败时 required=true 会使 Activation 失败；只有显式 required=false 才会继续，并把带 available=false/error 的有界 section 注入上下文作为可观测诊断。
- 逻辑数据必须先定义 dataPlane 和精确 dataView，再用 builtin/data-plane-view@1、config={"view":"Data View id"} 选择；Freeze 会将其编译为 state/record/journal/workspace 的物理 Provider。
- Lane dataAccess.read 必须授权该 View 所属 Plane；若 read grant 带 views，Node 只能选择其中的 View。
- 不得直接输出 builtin/state/evidence-view/artifact-view/workspace-binding/journal-view；它们是 Freeze 生成的物理实现细节。
- Activation Input 可显式使用 builtin/input@1，config 可省略或为 {"keys":["精确输入字段"]}；Clock 使用 builtin/clock@1 且无需 config；timer resume 数据使用 builtin/continuation@1、无需 config，通常 refresh=continuation_only。
- 同一 Activation 跨 segment 必须固定的材料用 activation_start；需要看到等待期间新 Evidence/State/Clock 的材料用 every_segment。
- 对非 builtin Provider，config 必须遵守能力目录展示的 config schema 或对应 Pack guidance；若目录和 guidance 都没有公开配置合同，不得猜字段，应改用有明确合同的 Provider、询问用户或在 taskSpec 列为部署能力缺口。

DataPlaneSpec 使用四种固定 backend；planeId 和 semanticRole 可由当前任务任意定义，Kernel 不解释 semanticRole：
1. State：{"backend":"state","semanticRole":"自定义语义","trust":"trusted_runtime","stateKeys":["已声明State"]}
2. Record：{"backend":"record","semanticRole":"自定义语义","trust":"untrusted_data","recordKind":"evidence|artifact","schema":<ShapeSpec>,"mutability":"append_only|superseding","admission":"automatic|judge","retention":{"maxItems":1..100000}}
3. Journal：{"backend":"journal","semanticRole":"自定义语义","trust":"untrusted_data","eventTypes":["activation_committed"]}
4. Workspace：{"backend":"workspace","semanticRole":"自定义语义","trust":"untrusted_data","binding":<WorkspaceBindingSpec>}
- State 只放确定性控制事实；Record 保存带 provenance 的事实/产物；Journal 是 Kernel 因果审计；Workspace 是输入源或可重建文件投影。
- recordKind 只是固定物理行为：evidence 表示判断依据，artifact 表示工作产物。业务可以命名 metrics、hypotheses、candidate_models、violations 等任意 Plane。
- trust 不能由 Distill 提权：state 必须 trusted_runtime，其余 backend 必须 untrusted_data。
- append_only Plane 的 publication 不能 supersedes；superseding Plane 可以显式替代旧 Record。
- Journal eventTypes 只能取：graph_created、activation_claimed、activation_released、activation_context_cached、activation_committed、graph_status_changed、external_event_recorded、external_event_consumed、paused_terminal_resumed。
- 新的物理存储语义不能写进 JSON；只有部署端已加载、版本锁定的 Capability Pack/Runtime 能扩展能力目录，Distill 只能引用当次目录实际存在的能力。

DataPlaneViewSpec：
{"plane":"逻辑Plane id","description":"...","stateKeys":[...],"statuses":["proposed|admitted|rejected|superseded"],"eventTypes":[...],"maxItems":1..10000}
- state View 只能选 Plane stateKeys 的子集；record View 可选 statuses/maxItems；journal View 可选 eventTypes/maxItems；workspace View 不带 selector，代表绑定文件本身。
- 上述是四种 backend 的字段并集，不得把所有 selector 同时写进一个 View：state={plane,stateKeys}；record={plane,statuses,maxItems}；journal={plane,eventTypes,maxItems}；workspace={plane,description}。
- Node Context 必须选择 View，不能直接读取整个 Plane。

WorkspaceBindingSpec（仅嵌套在 workspace Data Plane）：
{"plane":"input|state_projection|evidence|artifact|audit|observability","path":"安全的workspace相对路径","format":"json|jsonl|text|markdown","direction":"ingest|materialize|bidirectional","lane":"可选Lane","required":true|false,"appendOnly":true|false,"projection":{"kind":"data_view","view":"逻辑Data View","record":"content|envelope","flattenArrays":boolean},"initializeState":"graph_defaults|workspace_if_present|workspace_required"}
- 文件名和目录完全由用户协议决定；没有文件协议就不要定义 workspace Plane。
- input/observability 必须 direction=ingest 且不能带 projection；state_projection 必须 direction=materialize、format=json，并投影 state View；evidence/artifact/audit materialize 分别只能投影对应 record/journal View。
- materialize/bidirectional 必须有 projection；纯 ingest 禁止 projection；appendOnly 只用于 jsonl；bidirectional 只支持 jsonl 并结构去重；flattenArrays=true 还要求 record=content。
- lane 指定后位于该 Lane 选择的 workspace backend；不指定时位于项目 workspace。State initializeState 只允许项目级 State projection，并只在实例首次创建时载入。
- binding.path 必须是无空段、无 . 或 .. 的 workspace 相对路径，首段不能是 .loop、.git、.meta-agent；同一项目/Lane workspace 内两个 binding 不能指向同一路径。
- Lane dataAccess.write 只能授权属于该 Lane 的 workspace Plane；Lane 必须 lane_overlay 或 shared_controlled，且该 binding 必须是 observability ingest，或 direction=bidirectional，不能直接改 Kernel/input-owned materialize 文件。
- Kernel 在 commit/recovery 后幂等重建 materialize 文件；除获得 Lane dataAccess.write 的 workspace Plane 外，绑定路径进入 Agent sandbox deny list。

2. Function：
{"type":"function","function":"已注册id@version","inputs":{"name":<ValueExpression>},"outputSchema":<ShapeSpec>,"publishes":[...]}
Function 是已注册的纯确定性能力，不是模型临时生成的代码。只有目录中存在的 Function 才能使用。
- Function Node 把 inputs 解析成命名对象后调用 provider；ValueExpression.call 则把 args 解析成位置数组后调用同一 provider。必须遵守能力目录的 input/output contract，不要假设两种调用形态等价。

3. Effect：
{"type":"effect","effect":"已注册id@version","inputs":{"name":<ValueExpression>},"idempotencyKey":<ValueExpression>,"timeoutMs":正数}
Effect 用于外部副作用。必须有覆盖所有 poll continuation 的 timeoutMs；idempotencyKey 应解析为稳定字符串。目录没有 Effect 时不得生成 Effect Node。
- idempotencyKey 省略时 Kernel 使用 instanceId+activationId 的稳定默认值；只有业务系统需要自己的去重键时才显式声明，不能使用每次变化的 $clock.now。
- Kernel 在调用 provider 前写 Effect intent，并在 submit 返回后立即持久化 receipt；仍无法跨越外部系统与本地文件的原子边界，所以 Provider 必须真正按 idempotencyKey 去重。

4. Wait：
- Timer: {"type":"wait","wait":{"kind":"timer","delayMs":<ValueExpression>,"maxDelayMs":正数}}
- Event: {"type":"wait","wait":{"kind":"event","event":"事件名","correlation":<ValueExpression>,"timeoutMs":正数}}
Wait 会 durable park，不占用 LLM 进程。外部 Event 先写持久 inbox，早到不丢；Event 与 timeout 按发生时间 first-wins。

5. Join：
{"type":"join","mode":"all|any","expects":["明确的前驱 transition id"]}
fan-out 会产生 fork epoch；Join 只收拢同一 epoch，Join(any) 的迟到分支不会二次触发。当前不支持 quorum。

6. Terminal：
{"type":"terminal","status":"done|failed|paused","result":<ValueExpression>}
done/failed Terminal 无出边。paused Terminal 必须且只能提供 on=resume 的恢复边；loop resume 会沿该边幂等创建后续 Activation，不能把 paused 当作无续点的结束状态。不要用撞 maxActivations 代替优雅 terminal。

【值、State 与确定性路由】
ValueExpression 只能是三型之一：
{"literal":<JSON>}
{"ref":"$state.x 或 $input.x 或 $output.x 或 $clock.now"}
{"call":"已注册Function@版本","args":[<ValueExpression>]}
- 每个 ValueExpression 对象必须恰好包含 literal/ref/call 之一；call 额外允许 args，不能写裸 JSON、"$state.x" 字符串或同时写 ref+literal。
- Entry inputs 只能依赖 state；节点执行输入通常依赖 state/input/clock；transition inputs、updates 和 publication 可以依赖本次 output。
- ABI 可识别的 ref root 完整集合是 $state、$input、$output、$event、$effect、$clock、$artifacts、$evidence，但某个执行位置只能使用当时真实可用的 root。普通 Transition 当前可靠上下文为 state/input/output/clock；不要仅因 root 语法合法就引用该阶段未物化的数据。
- 不允许 JS、shell、模板表达式、数组索引或 $output.0。数组控制信息先由已注册 Function 归约，或让 Agent 输出命名标量。
- $state 只保存小型、类型化控制事实，例如 iteration、stale_count、status、deadline、当前候选 id；完整 findings、日志、报告和模型产物进入 workspace 文件或 Artifact/Evidence Plane。
- State 只能在 transition updates 中经 Reducer 原子更新，Agent 不得被要求心算并充当权威路由器。

TransitionSpec：
{"id":"唯一id","from":"nodeId","on":"outcome","when":"受限条件DSL","default":true,"priority":数字,"updates":[{"target":"stateName","reducer":"id@version","args":[<ValueExpression>]}],"to":"nodeId|{node,inputs}|数组"}
- on 缺省等于 success。执行器 outcome：Agent/Function/Effect 为 success|failure；Timer Wait 为 timer|failure；Event Wait 为 event|timeout|failure；Join 为 success。
- on=always 只在没有 exact outcome 边时作为 fallback，不会和 exact 边同时竞争；不要用 always 掩盖需要区分的失败或超时语义。
- 每个非 Terminal 必须覆盖其全部 outcome，或提供 on=always。Event 即使没有 timeout 也必须覆盖 failure。
- 同一 from+on 中：若有 when，必须恰好有一个 default；条件边 priority 必须唯一，数字大者先判断。不要在 default 上写 priority/when。
- when DSL 只支持布尔/数字/字符串字面量、圆括号、!、-、*、/、+、-、<、<=、>、>=、==、!=、&&、|| 和点路径。严格类型，不做字符串/数字强转。
- when 中可选字段缺失只代表该条件不匹配并继续 default；其他类型错误 fail closed。
- updates 发生在选中路由的同一原子 commit 中；阈值判断看到的是更新前 State。若“本次 +1 后达到阈值 N”，条件必须比较旧值 >= N-1。
- to 数组是显式 fan-out，长度不得超过 limits.maxFanOut。并行分支不得共享同一个写 Lane。
- 条件边/默认边的正确配对示例：
  条件：{"id":"finish","from":"work","on":"success","when":"$output.complete == true","priority":100,"to":{"node":"done","inputs":{"result":{"ref":"$output"}}}}
  默认：{"id":"continue","from":"work","on":"success","default":true,"updates":[{"target":"iteration","reducer":"builtin/increment@1"}],"to":"work"}
  失败：{"id":"failed","from":"work","on":"failure","to":"failed"}

ArtifactPublishSpec：
{"plane":"已声明record Data Plane","on":"success|failure|always","value":<ValueExpression>,"status":"proposed|admitted","supersedes":<ValueExpression>,"tags":["..."]}
- on 缺省为 success，失败输出不访问只存在于成功 schema 的字段；确需发布失败诊断时显式使用 on=failure。
- Agent 所在 Lane 必须在 dataAccess.publish 授权该 Plane。Freeze 将 plane 编译为物理 Record channel；Kernel 只提交 channel。
- automatic Plane 默认 admitted；judge Plane 默认 proposed。retention.maxItems 超限只拒绝 publication，不应被用作流程控制。

【经当前 Validator 与 Freeze 真实校验的最小完整 source Graph】
下例是 ABI 参考，不是领域拓扑模板。只复用它的字段嵌套、ValueExpression、outcome 覆盖和条件/default 成对方式；必须按当前用户需求自由设计 Node、Lane、State、Data Plane 和路由：
${JSON.stringify(CANONICAL_GRAPH_DISTILL_EXAMPLE, null, 2)}

【Lane 与图划分规则】
- 同一业务生命周期、需要连续上下文、操作同一工作副本的步骤优先合并为一个 Agent Node，或放进同一 persistent Lane；不要为了复刻用户列出的阶段而制造上下文断裂。
- 同一 persistent Lane 的 Agent Activation 串行；通常使用 shared_controlled 受控写根工作区，只有并行分支隔离、回滚或独立合并确有需要时才使用 lane_overlay；readonly 用于独立审查。fresh_per_activation 不保留长期语义上下文。
- Lane dataAccess 是权限上限而非隐式注入：read 授权 Plane/可选 Views，publish 授权 record Plane，write 仅授权属于该 Lane 的 workspace Plane。Node Context/publication 必须是其子集。
- Function/Wait/Join/Terminal 不需要 Lane。effect_only Lane 不能绑定 Agent。
- 并行只用于真正独立且 writes 不相交的分支；需要隔离合并时使用不同 Lane overlay，普通受控根目录写可用 shared_controlled，审查分支用 readonly Lane，随后显式 Join。
- Kernel 不提供业务资源锁。账号池、Gradmotion 抢占、Git publish 等由用户给 Agent 配置工具/Skill，或由 Capability Pack 注册 Effect；Distill 不得伪造锁和 provider。

【预算、恢复和退出】
- limits.maxActivations 必填，所有 cycle 必须同时有基于 State/语义的优雅退出边；上限只是保险丝。
- 长图建议设置 maxWallTimeMs、maxCostUsd、maxFanOut、maxPendingTimers；每个 Agent 设置 maxAttempts 和 segment budget。
- hard-park Agent 还必须设置 lifetimeBudget 和 maxParks；等待不能重置费用、轮次或 elapsed budget。
- Effect 必须有 timeoutMs；Event 若业务允许超时必须显式 timeoutMs 和 timeout 路由。
- Lane terminal merge 冲突会 pause，运维通过 loop lane-repair 恢复。不要在图中虚构 merge conflict 处理 Node。

【当前实际能力目录】
Functions：
${functions.map(item => `- ${item}`).join('\n') || '- (none)'}

Reducers：
${reducers.map(item => `- ${item}`).join('\n') || '- (none)'}

Effects：
${effects.map(item => `- ${item}`).join('\n') || '- (none；不得生成 effect 节点)'}

Capability Packs：
${packs.map(item => `- ${item}`).join('\n') || '- (none)'}

Context Providers：
${contextProviders.map(item => `- ${item}`).join('\n') || '- (none)'}

Scenario Guidance（可选灵感与约束，不是模板）：
${scenarioGuidance.map(item => `- ${item}`).join('\n') || '- (none；直接从用户场景自由编译)'}

内置 Reducer 的参数个数/语义：set 恰好 1 个 newValue；add/subtract/min/max 各 1 个 number；increment/decrement 可 0 个（默认 1）或 1 个 number；toggle 0 个；bounded-append 2 个(value,nonNegativeIntegerLimit)；set-union/remove 各 1 个 value-or-array；ema 2 个(next,alphaIn0To1)；object-merge 1 个 object。必须使用目录中的完整 id@version。

【编译决策顺序】
1. 提取目标、成功标准、外部系统、人工事件、公共产物和硬边界。
2. 识别业务生命周期：先决定哪些工作必须属于同一个长 Activation/Lane，再画控制节点；不要先按用户标题逐项建 Node。
3. 把计数、阈值、状态机和时间边界下沉到 State/Reducer/Transition/Wait；把语义判断放到带 outputSchema 的 Agent；把已注册确定计算放到 Function。
4. 为公共数据定义任务专属的逻辑 dataPlanes/dataViews，并给 Lane dataAccess 最小授权。State/Record/Journal 文件投影用 workspace Data Plane；需要自定义转换或外部副作用但目录没有对应 Function/Effect 时，不得冒充能力。
5. 设计 success/failure/timeout、结构性 pivot、目标完成和不可恢复退出，确保所有节点可达、所有 cycle 有优雅出口。
6. 为共享知识设计有界 record Plane 和精确 Data View；逐个 Agent 用 builtin/data-plane-view@1 声明实际 View、刷新生命周期和字节上限，不要把大文本塞进 State。
7. 若用户声明文件协议，逐个文件决定 canonical plane 和方向：控制状态由 State 投影，证据/产物先 publication 再由 View 投影，审计由 Journal 投影，纯输入/工作日志只 ingest。不要让 Agent 与 Kernel 双写 materialize 文件。
8. 为 Lane/Node 编写最小必要 systemInstructions；稳定身份放 Lane，当前任务仍放 prompt，数据只放 context section。
9. 为每个 Node 编写简短 description 作为 scheduler 阶段名；确保 Agent 的结束摘要和 timer 等待原因能让操作者脱离工具调用日志理解进度。
10. 为每个 Agent、整图、timer/effect/event 设置现实 bounds。

【输出前必须自检】
- 只含 graph-1.0 ABI 字段，没有旧机制字段或未注册能力；
- 所有 id 合法且唯一，引用的 node/state/plane/view/transition/capability 存在且带版本；
- state.initial 满足 ShapeSpec；所有 entry 和 Node 从至少一个 entrypoint 可达；
- done/failed Terminal 无出边；paused Terminal 只有完备 resume 边；每个其他 Node 的所有 outcome 都有路由；条件组 default/priority 完备；
- 所有循环既受 maxActivations 约束又有业务 terminal；threshold 使用更新前 State 正确换算；
- 写 Agent 明确 reads/writes；默认按需使用 shared_controlled，只有强隔离需求使用 lane_overlay；独立审查 readonly，persistent Lane maxConcurrency=1；
- 每个逻辑 Plane 可编译到固定 backend；schema/trust/admission/retention/mutability 合法；每个 View selector 与 backend 匹配；
- 每个 Agent 的精确 Data View/publication 都在 Lane dataAccess 上限内；Context Provider 已注册且带版本；refresh 与任务生命周期一致；
- workspace Data Plane 路径安全且 direction/projection 匹配；未臆造用户未要求的文件；materialize 文件没有同时要求 Agent 手工写；
- 每条 producer→consumer 数据链都可见：同 Lane 原始文件依赖已声明 reads/writes；跨 Lane 语义数据通过 publication/Data View；不同 Lane writes 和 Kernel projection 不重叠；
- systemInstructions 只承载角色/约束，未把 Evidence 等不可信数据拼成 system 指令；
- 每个 Node 都有清晰简短的 description；Agent prompt 明确要求一句话结束摘要，timer 等待条件可被一句话说明；
- hard-park Agent 的 segment/lifetime/timer bounds 齐全；Effect timeout 和 Event timeout 路由齐全；
- 数组没有直接参与 when；大产物没有进入 State；fan-out 不产生并发写冲突；
- taskSpec 明确列出：阶段合并/Lane 决策、阈值换算、workspace binding 的 canonical owner、默认能力无法保证的外部命令或自定义文件转换、所需用户工具/Skill/Pack、预算假设和运行前审阅点。`
}

export function parseGraphDistillOutput(output: unknown, summary?: string): { graph: LoopGraphSpec; taskSpec: string } | null {
  const candidates: unknown[] = [output]
  if (typeof output === 'string') candidates.push(tryJson(output), ...extractJsonObjects(output))
  if (summary) candidates.push(...extractJsonObjects(summary))
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const object = candidate as Record<string, unknown>
    const graph = object.graph
    if (graph && typeof graph === 'object' && !Array.isArray(graph)) {
      return { graph: graph as LoopGraphSpec, taskSpec: typeof object.taskSpec === 'string' ? object.taskSpec : '' }
    }
  }
  return null
}

function extractJsonObjects(source: string): unknown[] {
  const output: unknown[] = []
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '{') continue
    let depth = 0, inString = false, escaped = false
    for (let end = start; end < source.length; end++) {
      const char = source[end]!
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        const parsed = tryJson(source.slice(start, end + 1))
        if (parsed !== null) output.push(parsed)
        start = end
        break
      }
    }
  }
  return output
}

function tryJson(value: string): unknown {
  try { return JSON.parse(value.trim()) } catch { return null }
}

function formatCapability(
  manifest: { id: string; version: string; description?: string; inputSchema?: unknown; outputSchema?: unknown },
  fallback: string,
): string {
  return [
    `${manifest.id}@${manifest.version} — ${manifest.description ?? fallback}`,
    ...(manifest.inputSchema ? [`input=${JSON.stringify(manifest.inputSchema)}`] : []),
    ...(manifest.outputSchema ? [`output=${JSON.stringify(manifest.outputSchema)}`] : []),
  ].join(' ')
}
