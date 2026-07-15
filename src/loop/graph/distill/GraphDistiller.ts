import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import { spawnAndWait } from '../../seatSpawn.js'
import type { GraphRuntimeCatalog } from '../runtime/GraphCatalog.js'
import type { LoopGraphSpec } from '../spec/GraphTypes.js'
import { freezeLoopGraph, validateLoopGraph } from '../spec/GraphValidate.js'

export interface DistillGraphResult {
  graph: LoopGraphSpec
  taskSpec: string
  attempts: number
}

export interface DistillGraphDeps {
  dispatcher: ISubAgentDispatcher
  catalog: GraphRuntimeCatalog
  signal?: AbortSignal
  projectDir?: string
  maxAttempts?: number
  /** Independent intent-equivalence review; enabled by default. */
  semanticReview?: boolean
}

export async function distillLoopGraph(doc: string, deps: DistillGraphDeps): Promise<DistillGraphResult> {
  const maxAttempts = deps.maxAttempts ?? 3
  const signal = deps.signal ?? new AbortController().signal
  const systemPrompt = buildGraphDistillerSystem(deps.catalog)
  let lastErrors: string[] = []
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const task = [
      attempt > 1 ? `上一次 LoopGraphSpec 校验失败。逐项修复并返回完整图：\n- ${lastErrors.join('\n- ')}` : '',
      '【用户的 Loop 场景】',
      doc,
    ].filter(Boolean).join('\n\n')
    const record = await spawnAndWait(deps.dispatcher, {
      taskDescription: task,
      systemPrompt,
      externalPromptAssembly: true,
      allowedTools: ['read_file', 'grep', 'glob'],
      maxTurns: 24,
      maxBudgetUsd: 2,
      requireHumanApproval: false,
      useEventDriven: false,
      pollIntervalMs: 500,
      checkpointEveryNTurns: 0,
      ...(deps.projectDir ? { projectDir: deps.projectDir } : {}),
    }, signal)
    const parsed = parseGraphDistillOutput(record?.result?.output, record?.result?.summary)
    if (!parsed) {
      lastErrors = [`no parseable {graph, taskSpec}; sub-agent status=${record?.status ?? 'missing'} error=${record?.result?.error ?? '(none)'}`]
      continue
    }
    const errors = validateLoopGraph(parsed.graph, deps.catalog)
    if (!errors.length) {
      try {
        // Distill returns the logical source graph, but it must also survive the
        // exact logical-to-physical compilation Create will perform later.
        freezeLoopGraph(parsed.graph, deps.catalog, 0)
        if (deps.semanticReview !== false) {
          const review = await reviewGraphSemantics(doc, parsed, deps, signal)
          if (!review.accepted) {
            lastErrors = review.issues.length ? review.issues.map(issue => `semantic review: ${issue}`) : ['semantic review rejected the graph without details']
            continue
          }
        }
        return { ...parsed, attempts: attempt }
      } catch (error) {
        lastErrors = [error instanceof Error ? error.message : String(error)]
        continue
      }
    }
    lastErrors = errors
  }
  throw new Error(`graph distiller failed after ${maxAttempts} attempts:\n- ${lastErrors.join('\n- ')}`)
}

async function reviewGraphSemantics(
  doc: string,
  parsed: { graph: LoopGraphSpec; taskSpec: string },
  deps: DistillGraphDeps,
  signal: AbortSignal,
): Promise<{ accepted: boolean; issues: string[] }> {
  const record = await spawnAndWait(deps.dispatcher, {
    taskDescription: [
      '【用户原始 Loop 场景】', doc,
      '【候选 Graph】', JSON.stringify(parsed.graph),
      '【编译说明】', parsed.taskSpec,
    ].join('\n\n'),
    systemPrompt: `你是 Loop Graph 的独立语义审阅器。只检查候选图是否遗漏或违背用户目标、成功标准、时间/审批/失败边界、数据协议，以及是否虚构未注册外部能力。

不要规定节点数量、角色名称、Scenario 模板、研究/发布/合规固定字段，也不要因为有不同但合理的 Lane、Data Plane 或循环拓扑而拒绝。LLM 可以自由选择领域分解；只有明确矛盾、关键需求遗漏、不可执行能力、无界风险或数据所有权冲突才是 rejection。

只输出 JSON：{"accepted":true|false,"issues":["具体且可操作的问题"]}。`,
    externalPromptAssembly: true,
    allowedTools: [],
    maxTurns: 12,
    maxBudgetUsd: 0.75,
    requireHumanApproval: false,
    useEventDriven: false,
    pollIntervalMs: 500,
    checkpointEveryNTurns: 0,
    ...(deps.projectDir ? { projectDir: deps.projectDir } : {}),
  }, signal)
  const candidates: unknown[] = [record?.result?.output]
  if (typeof record?.result?.output === 'string') candidates.push(tryJson(record.result.output), ...extractJsonObjects(record.result.output))
  if (record?.result?.summary) candidates.push(...extractJsonObjects(record.result.summary))
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const object = candidate as Record<string, unknown>
    if (typeof object.accepted !== 'boolean') continue
    const issues = Array.isArray(object.issues) ? object.issues.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : []
    return { accepted: object.accepted, issues }
  }
  return { accepted: false, issues: [`semantic reviewer returned no parseable verdict; status=${record?.status ?? 'missing'}`] }
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
    .map(manifest => `${manifest.id}@${manifest.version} trust=${manifest.trust} — ${manifest.description ?? 'registered Context Provider'}`)
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

【唯一输出协议】
只输出一个 JSON 对象，不要 Markdown fence、解释前缀或尾注：
{"graph":<LoopGraphSpec>,"taskSpec":"供人审阅的编译决策、假设、能力缺口、运行前配置和风险边界"}

【当前执行模型】
1. Graph Node 是控制语义，不是一次聊天或一个 workspace writer。Kernel 调度的是 durable Activation。
2. Lane 是上下文与工作副本连续性边界。多个强相关 Agent Node 可共享一个 persistent Lane/session；lane_overlay Lane 是单写者。不同 Lane 才可并行。Lane 可用 agentProfile.systemInstructions 声明稳定角色；Node 可用 systemInstructions 增加本 Activation 的系统约束。它们不能覆盖 Kernel protected system prompt。
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

【LoopGraphSpec 精确 ABI】
根对象只使用这些字段：
{
  "schemaVersion":"graph-1.0",
  "id":"字母开头，只含字母数字下划线或短横线",
  "version":正整数,
  "goal":"非空目标",
  "capabilityPacks":[{"id":"...","version":"...","integrity":"..."}],
  "state":{"name":{"type":<ShapeSpec>,"initial":<JSON>,"description":"..."}},
  "lanes":{"laneId":{"context":"persistent|fresh_per_activation","workspace":"readonly|lane_overlay|effect_only","maxConcurrency":1,"description":"...","agentProfile":{"systemInstructions":"Lane 内稳定角色与行为约束"},"dataAccess":{"read":[{"plane":"逻辑Plane","views":["可选精确View"]}],"publish":["record Plane"],"write":["workspace Plane"]}}},
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

ShapeSpec 只支持：
- object: {"type":"object","required":[...],"properties":{"x":<ShapeSpec>},"additionalProperties":boolean}
- array: {"type":"array","minItems":整数,"items":<ShapeSpec>}
- string: {"type":"string","minLength":整数,"enum":[...]}
- number/integer: {"type":"number|integer","minimum":数,"maximum":数}
- boolean: {"type":"boolean"}
- null: {"type":"null"}

【六种 NodeSpec】
1. Agent：
{"type":"agent","lane":"laneId","prompt":"明确职责和完成条件","systemInstructions":"可选的当前节点系统约束","context":{"sections":[<ContextSectionSpec>]},"outputSchema":<ShapeSpec>,"tools":["read_file","edit_file","write_file","grep","glob","bash"],"writes":["workspace相对路径"],"maxAttempts":正整数,"budget":{"turns":正整数,"usd":正数,"wallTimeMs":正数},"lifetimeBudget":{"turns":正整数,"usd":正数,"elapsedMs":正数},"timerPolicy":{"allowHardPark":true,"maxDelayMs":正数,"maxParks":正整数},"publishes":[<ArtifactPublishSpec>]}
- 需要语义判断时由 Agent 输出有名字的标量字段，供确定性边判断。
- 使用 hard park 时必须是 persistent Lane，并完整提供 budget 三项、lifetimeBudget 三项、maxDelayMs 和 maxParks。
- writes 只能是 workspace 相对路径且不能含 ..。Agent 只能在 Lane workspace 和声明范围内写。
- systemInstructions 和 Lane agentProfile 是 Distill 可控的 system 段，不得重复或对抗 Kernel 路由/权限规则；稳定角色优先放 Lane，单节点约束才放 Node。

ContextSectionSpec：
{"name":"节点内唯一名称","provider":"已注册id@版本","refresh":"activation_start|every_segment|continuation_only","config":<Provider专用JSON>,"required":true|false,"maxBytes":256..262144}
- 逻辑数据必须先定义 dataPlane 和精确 dataView，再用 builtin/data-plane-view@1、config={"view":"Data View id"} 选择；Freeze 会将其编译为 state/record/journal/workspace 的物理 Provider。
- Lane dataAccess.read 必须授权该 View 所属 Plane；若 read grant 带 views，Node 只能选择其中的 View。
- 不得直接输出 builtin/state/evidence-view/artifact-view/workspace-binding/journal-view；它们是 Freeze 生成的物理实现细节。
- Activation Input 仍可显式使用 builtin/input@1；Clock 使用 builtin/clock@1；timer resume 数据使用 builtin/continuation@1 且通常 refresh=continuation_only。
- 同一 Activation 跨 segment 必须固定的材料用 activation_start；需要看到等待期间新 Evidence/State/Clock 的材料用 every_segment。

DataPlaneSpec 使用四种固定 backend；planeId 和 semanticRole 可由当前任务任意定义，Kernel 不解释 semanticRole：
1. State：{"backend":"state","semanticRole":"自定义语义","trust":"trusted_runtime","stateKeys":["已声明State"]}
2. Record：{"backend":"record","semanticRole":"自定义语义","trust":"untrusted_data","recordKind":"evidence|artifact","schema":<ShapeSpec>,"mutability":"append_only|superseding","admission":"automatic|judge","retention":{"maxItems":正整数}}
3. Journal：{"backend":"journal","semanticRole":"自定义语义","trust":"untrusted_data","eventTypes":["activation_committed|..."]}
4. Workspace：{"backend":"workspace","semanticRole":"自定义语义","trust":"untrusted_data","binding":<WorkspaceBindingSpec>}
- State 只放确定性控制事实；Record 保存带 provenance 的事实/产物；Journal 是 Kernel 因果审计；Workspace 是输入源或可重建文件投影。
- recordKind 只是固定物理行为：evidence 表示判断依据，artifact 表示工作产物。业务可以命名 metrics、hypotheses、candidate_models、violations 等任意 Plane。
- trust 不能由 Distill 提权：state 必须 trusted_runtime，其余 backend 必须 untrusted_data。
- append_only Plane 的 publication 不能 supersedes；superseding Plane 可以显式替代旧 Record。
- 新的物理存储语义不能写进 JSON；只有部署端已加载、版本锁定的 Capability Pack/Runtime 能扩展能力目录，Distill 只能引用当次目录实际存在的能力。

DataPlaneViewSpec：
{"plane":"逻辑Plane id","description":"...","stateKeys":[...],"statuses":["proposed|admitted|rejected|superseded"],"eventTypes":[...],"maxItems":正整数}
- state View 只能选 Plane stateKeys 的子集；record View 可选 statuses/maxItems；journal View 可选 eventTypes/maxItems；workspace View 不带 selector，代表绑定文件本身。
- Node Context 必须选择 View，不能直接读取整个 Plane。

WorkspaceBindingSpec（仅嵌套在 workspace Data Plane）：
{"plane":"input|state_projection|evidence|artifact|audit|observability","path":"安全的workspace相对路径","format":"json|jsonl|text|markdown","direction":"ingest|materialize|bidirectional","lane":"可选Lane","required":true|false,"appendOnly":true|false,"projection":{"kind":"data_view","view":"逻辑Data View","record":"content|envelope","flattenArrays":boolean},"initializeState":"graph_defaults|workspace_if_present|workspace_required"}
- 文件名和目录完全由用户协议决定；没有文件协议就不要定义 workspace Plane。
- input/observability ingest-only；State、Record、Journal 文件通过 projection.kind=data_view 引用逻辑 View，Freeze 再编译为物理投影。
- materialize/bidirectional 需要 projection；appendOnly 只用于 jsonl；bidirectional 只支持 jsonl 并结构去重。
- lane 指定后位于该 durable lane_overlay；不指定时位于项目 workspace。State initializeState 只允许项目级 State projection，并只在实例首次创建时载入。
- Kernel 在 commit/recovery 后幂等重建 materialize 文件；除获得 Lane dataAccess.write 的 workspace Plane 外，绑定路径进入 Agent sandbox deny list。

2. Function：
{"type":"function","function":"已注册id@version","inputs":{"name":<ValueExpression>},"outputSchema":<ShapeSpec>,"publishes":[...]}
Function 是已注册的纯确定性能力，不是模型临时生成的代码。只有目录中存在的 Function 才能使用。

3. Effect：
{"type":"effect","effect":"已注册id@version","inputs":{"name":<ValueExpression>},"idempotencyKey":<ValueExpression>,"timeoutMs":正数}
Effect 用于外部副作用。必须有覆盖所有 poll continuation 的 timeoutMs；idempotencyKey 应解析为稳定字符串。目录没有 Effect 时不得生成 Effect Node。
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
- Entry inputs 只能依赖 state；节点执行输入通常依赖 state/input/clock；transition inputs、updates 和 publication 可以依赖本次 output。
- 不允许 JS、shell、模板表达式、数组索引或 $output.0。数组控制信息先由已注册 Function 归约，或让 Agent 输出命名标量。
- $state 只保存小型、类型化控制事实，例如 iteration、stale_count、status、deadline、当前候选 id；完整 findings、日志、报告和模型产物进入 workspace 文件或 Artifact/Evidence Plane。
- State 只能在 transition updates 中经 Reducer 原子更新，Agent 不得被要求心算并充当权威路由器。

TransitionSpec：
{"id":"唯一id","from":"nodeId","on":"outcome","when":"受限条件DSL","default":true,"priority":数字,"updates":[{"target":"stateName","reducer":"id@version","args":[<ValueExpression>]}],"to":"nodeId|{node,inputs}|数组"}
- on 缺省等于 success。执行器 outcome：Agent/Function/Effect 为 success|failure；Timer Wait 为 timer|failure；Event Wait 为 event|timeout|failure；Join 为 success。
- 每个非 Terminal 必须覆盖其全部 outcome，或提供 on=always。Event 即使没有 timeout 也必须覆盖 failure。
- 同一 from+on 中：若有 when，必须恰好有一个 default；条件边 priority 必须唯一，数字大者先判断。不要在 default 上写 priority/when。
- when DSL 只支持布尔/数字/字符串字面量、圆括号、!、-、*、/、+、-、<、<=、>、>=、==、!=、&&、|| 和点路径。严格类型，不做字符串/数字强转。
- when 中可选字段缺失只代表该条件不匹配并继续 default；其他类型错误 fail closed。
- updates 发生在选中路由的同一原子 commit 中；阈值判断看到的是更新前 State。若“本次 +1 后达到阈值 N”，条件必须比较旧值 >= N-1。
- to 数组是显式 fan-out，长度不得超过 limits.maxFanOut。并行分支不得共享同一个写 Lane。

ArtifactPublishSpec：
{"plane":"已声明record Data Plane","on":"success|failure|always","value":<ValueExpression>,"status":"proposed|admitted","supersedes":<ValueExpression>,"tags":["..."]}
- on 缺省为 success，失败输出不访问只存在于成功 schema 的字段；确需发布失败诊断时显式使用 on=failure。
- Agent 所在 Lane 必须在 dataAccess.publish 授权该 Plane。Freeze 将 plane 编译为物理 Record channel；Kernel 只提交 channel。
- automatic Plane 默认 admitted；judge Plane 默认 proposed。retention.maxItems 超限只拒绝 publication，不应被用作流程控制。

【Lane 与图划分规则】
- 同一业务生命周期、需要连续上下文、操作同一工作副本的步骤优先合并为一个 Agent Node，或放进同一 persistent Lane；不要为了复刻用户列出的阶段而制造上下文断裂。
- 同一 persistent Lane 的 Agent Activation 串行；lane_overlay 用于写任务，readonly 用于独立审查。fresh_per_activation 不保留长期语义上下文。
- Lane dataAccess 是权限上限而非隐式注入：read 授权 Plane/可选 Views，publish 授权 record Plane，write 仅授权属于该 Lane 的 workspace Plane。Node Context/publication 必须是其子集。
- Function/Wait/Join/Terminal 不需要 Lane。effect_only Lane 不能绑定 Agent。
- 并行只用于真正独立的分支；写分支用不同 Lane overlay，审查分支用 readonly Lane，随后显式 Join。
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

内置 Reducer 的参数语义：set(args[0])；add/subtract(args[0])；increment/decrement(无参数时 1，否则 args[0])；min/max(args[0])；toggle()；bounded-append(value,limit)；set-union(values)；remove(values)；ema(next,alpha)；object-merge(object)。

【编译决策顺序】
1. 提取目标、成功标准、外部系统、人工事件、公共产物和硬边界。
2. 识别业务生命周期：先决定哪些工作必须属于同一个长 Activation/Lane，再画控制节点；不要先按用户标题逐项建 Node。
3. 把计数、阈值、状态机和时间边界下沉到 State/Reducer/Transition/Wait；把语义判断放到带 outputSchema 的 Agent；把已注册确定计算放到 Function。
4. 为公共数据定义任务专属的逻辑 dataPlanes/dataViews，并给 Lane dataAccess 最小授权。State/Record/Journal 文件投影用 workspace Data Plane；需要自定义转换或外部副作用但目录没有对应 Function/Effect 时，不得冒充能力。
5. 设计 success/failure/timeout、结构性 pivot、目标完成和不可恢复退出，确保所有节点可达、所有 cycle 有优雅出口。
6. 为共享知识设计有界 record Plane 和精确 Data View；逐个 Agent 用 builtin/data-plane-view@1 声明实际 View、刷新生命周期和字节上限，不要把大文本塞进 State。
7. 若用户声明文件协议，逐个文件决定 canonical plane 和方向：控制状态由 State 投影，证据/产物先 publication 再由 View 投影，审计由 Journal 投影，纯输入/工作日志只 ingest。不要让 Agent 与 Kernel 双写 materialize 文件。
8. 为 Lane/Node 编写最小必要 systemInstructions；稳定身份放 Lane，当前任务仍放 prompt，数据只放 context section。
9. 为每个 Agent、整图、timer/effect/event 设置现实 bounds。

【输出前必须自检】
- 只含 graph-1.0 ABI 字段，没有旧机制字段或未注册能力；
- 所有 id 合法且唯一，引用的 node/state/plane/view/transition/capability 存在且带版本；
- state.initial 满足 ShapeSpec；所有 entry 和 Node 从至少一个 entrypoint 可达；
- done/failed Terminal 无出边；paused Terminal 只有完备 resume 边；每个其他 Node 的所有 outcome 都有路由；条件组 default/priority 完备；
- 所有循环既受 maxActivations 约束又有业务 terminal；threshold 使用更新前 State 正确换算；
- 写 Agent 使用 lane_overlay，独立审查 readonly，persistent Lane maxConcurrency=1；
- 每个逻辑 Plane 可编译到固定 backend；schema/trust/admission/retention/mutability 合法；每个 View selector 与 backend 匹配；
- 每个 Agent 的精确 Data View/publication 都在 Lane dataAccess 上限内；Context Provider 已注册且带版本；refresh 与任务生命周期一致；
- workspace Data Plane 路径安全且 direction/projection 匹配；未臆造用户未要求的文件；materialize 文件没有同时要求 Agent 手工写；
- systemInstructions 只承载角色/约束，未把 Evidence 等不可信数据拼成 system 指令；
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
