# Durable Graph Loop Runtime 重构方案

> 状态：`durable-graph-v1` 已成为唯一 Loop 执行架构。此前的固定流程实现、Charter/Scenario ABI 与兼容执行路径已移除。本文既是架构决策记录，也是实现边界说明。
>
> 核心目标：**Kernel 可靠执行 Distill 生成的任意受约束图节点和边。**

实现入口：

- Graph ABI/冻结校验：`src/loop/graph/spec/`
- Function/Reducer/Effect/Context Provider/Capability Pack：`src/loop/graph/registry/`
- Journal、Activation、Lane、节点执行、提交与调度：`src/loop/graph/runtime/`
- 自然语言编译与校验修复：`src/loop/graph/distill/`
- CLI/Wake/Graph 调度：`src/loop/cli.ts`、`src/loop/runner.ts`、`src/loop/daemon.ts`

当前已实现 Agent/Function/Effect/Wait/Join(all/any)/Terminal、确定性 `$state` 路由、Reducer、输入快照、声明式 Context Assembly、逻辑 Data Plane/View、Lane 数据 ACL、Freeze 物理编译、严格 executable ABI + 开放 annotations、保守 schema 数据流检查、闭合路径检查、版本化 Context Provider、Lane/Node system instructions、Artifact/Evidence provenance、workspace 幂等投影、timer/event/paused-terminal resume、Effect intent/receipt ledger、commit intent/replay、可选 serializable State replay、Lane session/worktree、独立 Distill 语义 reviewer、单机 Activation 并发和带 Scenario guidance 的本地 Capability Pack loader。Quorum Join、跨主机共享 lease backend 和断电级 fsync 不在当前保证内。

## 1. 为什么重构

当前 Loop 已具备 Wake fencing、Artifact transaction、Effect、预算、恢复、单机并发和插件完整性等可靠性基础，但控制模型仍然固定为：

```text
WAKE → RECONCILE → MODE → CAPSULE → worker → judge? → METER → LEDGER → ROUTE
```

节点角色固定为 worker/judge/pivoter/finalizer，路由固定为 continue/pivot/finalize/escalate，变量主要是 round counter。这能表达一种“每轮生产—审核—计数—路由”的循环，却不能自然表达任意业务 Loop：

```text
plan → implement → test ─┬─ pass → deploy → wait → verify → done
                         └─ fail → fix ────────────────┘
```

继续增加 Research、Release、Compliance 等固定 Scenario，只会增加具体 Loop 模板。正确的抽象应当是：

```text
自然语言描述
  → Distill Compiler
  → Frozen LoopGraphSpec
  → Durable Graph Kernel
```

Distill 负责设计图，Kernel 只解释和执行冻结后的图。

## 2. 关键架构决策

### 2.1 图是控制平面，不是 Agent 隔离边界

旧图方案最大的错误是：

```text
Graph Node = Agent = Session = Workspace Writer
```

它造成两个问题：

1. 每经过一个节点都更换 Agent，上下文只能靠自然语言 handoff，对齐不可靠；
2. 多个节点直接并发写共享 workspace，产生冲突、粗锁和大量 worktree merge。

新模型拆成三层：

```text
Graph Node          控制语义：做什么、输入输出、从哪里路由
Execution Lane      执行连续性：LLM session、上下文、私有工作副本
Commit Coordinator  共享提交：State、Artifact、Evidence、主 workspace
```

一个控制图可以有很多 Node，但强相关 Node 可以落到同一个 Lane，由同一个持久 LLM session 连续执行。

### 2.2 Loop 层不重复实现上下文压缩

专用 `graph_agent` 执行 SPI 的当前 Meta-Agent 适配器已经负责：

- 会话历史压缩；
- 工具结果裁剪；
- token 预算控制；
- tool call/result 结构修复；
- session resume。

Graph Loop 不再实现第二套 LLM context compactor。它只负责每次 Activation 的确定性上下文装配，并把稳定 session 交给 `graph_agent` 管理。Graph Kernel 不直接依赖 SessionRouter、SubAgentDispatcher 或 Meta-Agent task record；具体底座通过 `GraphAgentExecutor` 注入。

### 2.3 LLM 只能编排注册能力，不能生成可执行代码

Distill 可以引用预注册的 Function、Reducer、EffectAdapter 和 Capability Pack，但不能生成 JavaScript 后让 Kernel 执行。所有运行时能力必须有版本、Schema 和 integrity。

### 2.4 路由默认确定性

条件比较、状态更新、函数计算、timer、event 和 effect 状态机全部由程序执行。需要语义判断时，显式创建一个具有结构化输出的 Agent Router 节点；Kernel 仍根据输出机械路由。

## 3. 总体架构

```text
Natural-language Loop
        │
        ▼
Distill Compiler
  ├─ Capability Catalog
  ├─ Graph Synthesis
  ├─ Type/Binding Validation
  ├─ Conflict Analysis
  ├─ Bounded Simulation
  └─ Repair Loop
        │
        ▼
Frozen LoopGraphSpec + Capability Lock
        │
        ▼
Durable Graph Kernel
  ├─ Activation Scheduler
  ├─ Execution Lane Manager
  ├─ Node Executor Registry
  ├─ Transition Engine
  ├─ State/Reducer Engine
  ├─ Artifact/Evidence Plane
  ├─ Timer/Event/Effect Continuations
  ├─ Commit Coordinator
  └─ Execution Journal/Reconcile
        │
        ▼
GraphAgentExecutor SPI
  └─ MetaAgentGraphAgentExecutor（当前，可替换）
```

## 4. LoopGraphSpec

```ts
interface LoopGraphSpec {
  schemaVersion: 'graph-1.0'
  id: string
  version: number
  goal: string

  capabilityPacks?: FrozenCapabilityPackRef[]

  state: Record<string, StateVariableSpec>
  lanes: Record<string, ExecutionLaneSpec>
  nodes: Record<string, NodeSpec>
  transitions: TransitionSpec[]
  entrypoints: EntrypointSpec[]

  dataPlanes?: Record<string, DataPlaneSpec>
  dataViews?: Record<string, DataPlaneViewSpec>

  limits: LoopLimits
  concurrency?: LoopConcurrencyPolicy
}
```

Graph 在 create/freeze 后固定。运行期间变化的是 Activation、State、Artifact、Evidence、Event 和 workspace revision，不允许运行中由 Agent 静默改图。

Distill 只作者化逻辑 `dataPlanes/dataViews`、Lane `dataAccess`、Node 精确 View 与 publication。Freeze 将它们编译到固定 `state | record | journal | workspace` 后端，同时生成内部 Artifact channel、Evidence/Artifact View、Workspace Binding、`compiledLaneDataAccess` 物理 ACL 和物理 Context Provider，并把最终能力加入 capability lock。物理字段是 Frozen Graph 实现细节，不属于 Distill 输出 ABI。

逻辑 Plane 的 `semanticRole`、名称和 schema 可以随任务变化；Kernel 不解释领域含义。新的物理存储执行语义不能由 LLM 在 JSON 中创造，必须先由版本化、带 integrity 的 Capability Pack/Runtime 扩展 Freeze 与能力目录。

## 5. `$state`：全图控制状态

Distill 根据自然语言声明全局、持久化、强类型状态变量：

```ts
interface StateVariableSpec {
  type: ShapeSpec
  initial: JsonValue
  description?: string
}
```

例如：

```yaml
state:
  retry_count:
    type: { type: integer, minimum: 0 }
    initial: 0
  best_score:
    type: { type: number }
    initial: 0
  current_stage:
    type: { type: string, enum: [implement, test, deploy, verify] }
    initial: implement
```

`$state` 适合存放影响控制流的小型事实：

- retry/count/streak；
- current stage；
- best score；
- approval status；
- active candidate ID；
- deadline；
- 最新 Artifact/Evidence 引用。

完整日志、Patch、报告、大量历史记录不进入 `$state`，而进入 Artifact/Evidence Plane。

## 6. Reducer 与 Function Registry

State 只能由 Kernel 调用冻结后的 Reducer 更新：

```ts
interface StateUpdateSpec {
  target: string
  reducer: string
  args: Expression[]
}
```

```yaml
updates:
  - target: retry_count
    reducer: builtin/increment@1
  - target: best_score
    reducer: builtin/max@1
    args: ["$output.score"]
  - target: recent_failures
    reducer: builtin/bounded-append@1
    args: ["$output.error", 20]
```

首批内置 Reducer：

```text
builtin/set@1
builtin/add@1
builtin/subtract@1
builtin/increment@1
builtin/decrement@1
builtin/min@1
builtin/max@1
builtin/toggle@1
builtin/bounded-append@1
builtin/set-union@1
builtin/remove@1
builtin/ema@1
builtin/object-merge@1
```

Provider manifest 必须声明输入输出 Schema、纯函数属性、版本和完整性：

```ts
interface ReducerManifest {
  id: string
  version: string
  integrity: string
  stateSchema: ShapeSpec
  argsSchema: ShapeSpec
  outputSchema: ShapeSpec
  pure: true
  deterministic: true
  associative?: boolean
  commutative?: boolean
}
```

网络、随机数、未记录的系统时间、文件写入和 LLM 调用不得出现在 Route Function/Reducer 中。

## 7. 确定性路由

用户描述：

```text
state >= 2 进入 xxx1；state >= 8 优先进入 xxx2；否则继续。
```

Distill 编译为：

```yaml
transitions:
  - id: state-to-xxx2
    from: check_state
    on: success
    when: "$state.state >= 8"
    priority: 200
    to: { node: xxx2 }

  - id: state-to-xxx1
    from: check_state
    on: success
    when: "$state.state >= 2"
    priority: 100
    to: { node: xxx1 }

  - id: state-default
    from: check_state
    on: success
    default: true
    priority: 0
    to: { node: continue_work }
```

Freeze 时表达式编译成 AST，验证变量和类型。运行时 Kernel 在 state commit 临界区机械求值，不调用 LLM。

因为 `state >= 8` 同时满足 `state >= 2`，必须显式定义 priority，或把区间标准化为：

```text
state < 2       → continue_work
2 <= state < 8  → xxx1
state >= 8      → xxx2
```

重叠条件没有明确优先级时，静态验证拒绝 Freeze。

状态更新与路由采用固定顺序：

```text
1. 验证节点输出
2. 执行 node.onComplete Reducer
3. 得到 postNodeState
4. 基于 postNodeState 求值 Transition
5. 选择唯一 Transition
6. 执行 Transition 自己的 Reducer
7. 原子提交并创建下游 Activation
```

## 8. Node 类型

```ts
type NodeSpec =
  | AgentNodeSpec
  | FunctionNodeSpec
  | EffectNodeSpec
  | WaitNodeSpec
  | JoinNodeSpec
  | TerminalNodeSpec
```

### 8.1 Agent Node

Planner、Worker、Judge、Pivot、Reviewer、Router 都是普通 Agent Node：

```ts
interface AgentNodeSpec {
  kind: 'agent'
  lane: string
  prompt: string
  inputs: Record<string, DataBinding>
  outputSchema: ShapeSpec
  tools?: string[]
  skills?: string[]
  budget: NodeBudget
  retry?: NodeRetryPolicy
  reads?: ResourceSelector[]
  writes?: ResourceSelector[]
  consistency?: 'snapshot' | 'serializable'
}
```

### 8.2 Function Node

调用预注册的确定性 Function，例如运行 schema validator、计算指标、执行本地测试结果解析。

### 8.3 Effect Node

通过 EffectAdapter 执行部署、训练提交、审批、取消和 rollback 等外部副作用。每个副作用必须有稳定 idempotency key。

### 8.4 Wait Node

Timer/Event 是图的一等节点。Agent 可以输出动态等待时间，Wait Node 从输入绑定读取，但等待和恢复由 Kernel 执行。

### 8.5 Join Node

当前支持 `all` 和 `any`，并持久化 fork group 和分支结果。`quorum` 留作后续 ABI 扩展。

### 8.6 Terminal Node

明确产生 done/escalated/failed/cancelled，不再依赖固定 finalize/escalate route。

## 9. Execution Lane：上下文与工作副本连续性

Lane 是本方案最重要的执行抽象。

### 9.1 多个图节点共享一个 LLM 执行体

例如：

```text
implement → test → diagnose → fix → test
```

这些是不同的控制图节点，但可以全部绑定到 `development` Lane：

```yaml
lanes:
  development:
    context:
      mode: persistent
    workspace:
      mode: lane_overlay
      writeScope: ["src/**", "tests/**"]
    maxConcurrency: 1

nodes:
  implement: { kind: agent, lane: development, ... }
  test:      { kind: function, lane: development, ... }
  diagnose:  { kind: agent, lane: development, ... }
  fix:       { kind: agent, lane: development, ... }
```

这里“共享一个 LLM 节点”更精确的含义是：

> 多个强相关 Graph Node 仍保留各自输入、输出和路由语义，但由同一个长期存在的 LLM Execution Lane/session 执行。

不能把它们重新折叠成一个不透明大节点，否则会丢失图的审计、恢复和确定性路由。

### 9.2 Lane 拥有什么

一个 Lane 实例拥有：

- 稳定 session/lineage ID；
- 底层模式管理的对话上下文；
- 私有 workspace overlay/worktree；
- 单线程 mailbox；
- state/artifact/evidence cursor；
- workspace revision；
- 资源租约；
- 上下文 Anchor。

### 9.3 自动 Lane 分组

Distill 完成图后，Compiler 计算 Strongly Connected Components：

```text
implement → test → fix
    ▲              │
    └──────────────┘
```

默认规则：

1. 同一 SCC 内共享 workspace 的 Agent Node 放入同一个 persistent Lane；
2. 同一 Lane `maxConcurrency = 1`；
3. Judge/Reviewer 默认 fresh + readonly；
4. Function Node 可在 Lane 内执行，但不占用 LLM上下文；
5. fork 分支默认创建独立 Lane overlay；
6. join 后返回原主 Lane或进入显式 merge Lane。

### 9.4 Context Assembly Plan

Loop 不压缩聊天。每个 Agent 自动获得 Kernel 强制的最小 activation section；其他上下文由节点声明有序计划：

```ts
interface ContextSectionSpec {
  name: string
  provider: string                 // versioned id@version
  refresh: 'activation_start' | 'every_segment' | 'continuation_only'
  config?: JsonValue
  required?: boolean
  maxBytes?: number
}
```

Context Provider Catalog 的内置 provider 包括 activation、input、state、命名 evidence/artifact view、clock 和 continuation。Capability Pack 可以注册新 provider；Freeze 把实际引用写入 `capabilityLock.contextProviders`，resume 时 integrity 不匹配则拒绝执行。

`activation_start` 的解析结果进入 Activation journal，跨 timer/retry/process restart 保持同一快照；`every_segment` 每个物理段刷新；`continuation_only` 只在恢复段注入。Runtime 不再把全局最多 100 条 Evidence/Artifact 注入所有节点。

每个最终 prompt section 包含 provider/source/trust/refresh/resolvedAt/stateVersion/truncated/bytes/content 元数据并统一做字节上限与边界转义。Lane `agentProfile.systemInstructions` 和 Node `systemInstructions` 位于 graph-authored system 区域；数据 section 始终位于 user context，不能冒充系统指令。

文件协议不是 Research Scenario 的固定结构。Distill 用逻辑 `workspace` Data Plane 将用户自行命名的相对路径映射为 Input、State projection、Evidence、Artifact、Audit 或 Observability；没有该 Plane 的图完全不启用文件机制。Node 用 `builtin/data-plane-view@1` 选择逻辑 View，Freeze 生成 `builtin/workspace-binding@1` 和物理 binding；`WorkspacePlaneMaterializer` 在 commit/recovery 后从 Kernel State、Record View 或 Journal 幂等重建投影。由此控制状态仍以 `$state` 为权威，Agent 不再双写 materialize 文件，且任何领域都能声明自己的目录协议。

## 10. 显式数据流

每个下游 Activation 创建时立即物化输入快照，不依赖“当前最新某节点输出”。

支持的数据来源：

```text
$input.*
$output.*
$state.*
$event.*
$effect.*
$artifact.*
$evidence.*
$clock.*
```

```yaml
- id: test-failed-to-fix
  from: test
  on: success
  when: "$output.passed == false"
  updates:
    - target: retry_count
      reducer: builtin/increment@1
  to:
    node: fix
    input:
      error: "$output.summary"
      error_type: "$output.error_type"
      retry: "$state.retry_count"
```

恢复时使用已经保存的 input snapshot，不重新猜测当时的数据依赖。

## 11. 全图 Artifact/Evidence Plane

图需要一个贯穿所有 Node/Lane/循环的公共知识平面，但不能是所有 Agent 随意写入的共享目录。

```text
Loop Knowledge Plane
├── Artifact Channels
├── Evidence Metadata
├── Proposals
├── Admission/Gates
├── Immutable Snapshots
└── Bounded Views/Queries
```

### 11.1 数据边界

| 数据 | 用途 | 更新方式 |
| --- | --- | --- |
| State | 小型控制状态 | Reducer |
| Artifact | 持久化业务产出 | Transaction |
| Evidence | 带 provenance 的判断依据 | Proposal + Admission |
| Context | 临时对话、推理、工具历史 | 底层模式压缩 |
| Workspace | 业务文件 | Lane overlay + Commit Coordinator |

任何需要被其他节点长期依赖的信息，都不能只存在于聊天上下文中，必须提升为 Artifact/Evidence。

### 11.2 Evidence Record

```ts
interface EvidenceRecord {
  id: string
  channel: string
  type: string
  content?: JsonValue
  externalRef?: string
  contentHash: string
  producer: { activationId: string; nodeId: string; laneId: string }
  provenance: {
    inputArtifactIds: string[]
    workspaceRevision?: string
    effectId?: string
    externalRefs?: string[]
  }
  status: 'proposed' | 'admitted' | 'rejected' | 'superseded'
  supports?: string[]
  contradicts?: string[]
  confidence?: number
  tags?: string[]
}
```

Agent 只能提出 proposal，Kernel 经过 schema/function/judge gate 后 admission。Judge、Pivot 等决策节点默认只读 admitted Evidence。

### 11.3 快照一致性

节点启动时固定 Evidence Snapshot：

```ts
interface EvidenceSnapshotRef {
  storeRevision: number
  channelCursors: Record<string, number>
  recordIds: string[]
  queryHash: string
}
```

并行节点之后提交的新 Evidence 不会偷偷改变一个正在运行的 Judge 的输入。需要新证据时创建新的 Judge Activation。

### 11.4 Judge/Pivot 是普通 Agent Node

```yaml
judge:
  kind: agent
  lane: independent-review
  inputs:
    evidence:
      from: evidence_query
      query:
        channels: [test-results, verification-evidence]
        status: [admitted]
        maxItems: 40
```

```yaml
pivot:
  kind: agent
  lane: strategy
  inputs:
    dead_ends:
      from: evidence_query
      query:
        tags: { any: [failed, rejected, dead-end] }
        maxItems: 50
```

它们没有 Kernel 特权，只是输入视图和输出 Schema 不同。

## 12. Activation：调度和恢复的最小单位

```ts
interface NodeActivation {
  id: string
  nodeId: string
  laneId?: string
  parentActivationId?: string
  status: 'ready' | 'running' | 'waiting' | 'committing' |
    'succeeded' | 'failed' | 'cancelled'
  input: Record<string, JsonValue>
  inputStateVersion: number
  attempt: number
  segmentCount: number
  parkCount: number
  usage: { turns: number; costUsd: number; durationMs: number }
  firstStartedAt?: number
  readyReason?: 'initial' | 'continuation' | 'retry'
  continuationVersion: number
  lease?: { token: string; owner: string; expiresAt: number }
  output?: JsonValue
  outcome?: string
  wakeAt?: number
}
```

Activation ID 由 loop、parent activation、transition、target node、branch index 等稳定信息派生，重复调度同一条已提交边不会制造重复 Activation。

Activation 是逻辑业务执行，不等于一次 Agent 进程调用。一次 Agent 进程调用称为 segment；hard park 结束当前 segment，唤醒后仍以同一 Activation ID 在原 Lane 开始下一 segment。`attempt` 只统计初次执行和 lease 失效后的 retry，timer continuation 不增加 attempt；`segmentCount`、`parkCount` 和 `continuationVersion` 分别记录执行段、已提交 park 和恢复 fencing 版本。

## 13. Durable Graph Kernel

```text
RECONCILE
→ CLAIM READY ACTIVATION
→ RESOLVE INPUT SNAPSHOT
→ ACQUIRE/RESUME LANE
→ EXECUTE NODE
→ VALIDATE OUTPUT
→ WRITE COMMIT INTENT
→ VERIFY FENCE
→ APPLY NODE REDUCERS
→ EVALUATE TRANSITIONS
→ APPLY EDGE REDUCERS
→ COMMIT ARTIFACT/EVIDENCE
→ APPEND EXECUTION JOURNAL
→ CREATE CHILD ACTIVATIONS
→ UPDATE PROJECTIONS
→ RELEASE CLAIM
```

每个 Activation 使用 recoverable commit intent。Kill -9 后 RECONCILE 继续未完成提交；已经 committed 的 Activation 不再运行节点。

## 14. Execution Journal

权威日志是按 sequence 编号的 append-only 文件：

```text
.loop/<instanceId>/graph/journal/000000000001.json
```

当前 ABI 的事件包括：

```text
graph_created
activation_claimed
activation_released
activation_committed
graph_status_changed
```

`activation_released.reason` 区分 `parked`、`resumed`、`lease_expired` 和 Kernel failure；`activation_committed` 原子携带 state、instance、选中 transition、下游 Activation、取消项与 Artifact/Evidence。由此可以重建所有 projection，并保证 replay 可解释。

## 15. Time、Event、Effect 与 Resume

Wait 不再是 worker/pending_round 特例，而是 Activation continuation：

```text
timer → wakeAt
event → eventType + correlationKey + timeoutAt
effect → effectKey + adapter + retry/deadline
```

唤醒只将对应 Activation 从 waiting 变为 ready。Resume 恢复的是同一 Activation 和同一 input/evidence snapshot，而不是从 entrypoint 重跑整张图。

物理执行进程可以在等待后退出；Timer 是落盘的 durable Wake，不是进程内 `setTimeout`。时间到后可由新进程重新加载 Frozen Graph 并继续原来的图位置。

### 15.1 显式 Wait Node

适合等待前的工作已经完整提交，且下一步在 Distill 阶段已经确定的流程，例如发布后的固定冷却窗口：

```text
publish_release → wait_30_minutes → verify_rollout
```

```yaml
nodes:
  wait_rollout:
    type: wait
    wait:
      kind: timer
      delayMs: { literal: 1800000 }
      maxDelayMs: 86400000

transitions:
  - id: verify_after_wait
    from: wait_rollout
    on: timer
    to: { node: verify_rollout }

  - id: escalate_wait_failure
    from: wait_rollout
    on: failure
    to: { node: escalate }
```

不要用这一结构机械拆分同一个远端训练生命周期。如果提交任务、观察曲线、决定是否继续等待和最终收口需要同一个 Agent 的连续判断，应使用下一节的单一长生命周期 Agent Activation。

执行过程：

```text
进入 Wait Node
→ 持久化 waiting Activation/Continuation
→ 注册 activation-scoped Wake
→ 当前进程和 Lane 资源可以释放
→ wakeAt 到期
→ Scheduler claim Wake
→ Wait Activation completed
→ 按 timer outcome 的 Transition 创建下游 Activation
```

### 15.2 Agent 自调用 Timer（Hard Park）

适合必须由 Agent 根据语义判断“是否还值得继续等待”的场景，例如观察训练曲线、等待实验收敛或检查远端任务中间状态。

```yaml
nodes:
  inspect_training:
    type: agent
    lane: training
    budget:
      turns: 20
      usd: 1
      wallTimeMs: 900000
    lifetimeBudget:
      turns: 200
      usd: 10
      elapsedMs: 21600000
    timerPolicy:
      allowHardPark: true
      maxDelayMs: 3600000
      maxParks: 12
```

Agent 调用受控 timer tool：

```json
{
  "afterMs": 1800000,
  "reason": "训练指标仍在改善，30 分钟后重新检查",
  "checkpoint": {
    "jobId": "train-42",
    "lastObservedStep": 18000,
    "decision": "loss is still decreasing"
  }
}
```

timer 调用具有 hard-park 语义：

1. 立即终止当前 Agent 执行段；
2. 不允许在 timer tool result 后继续调用工具或提交 Node output；
3. 当前 Activation 不标记 completed，而是进入 waiting；
4. 已产生的费用、输入、Evidence snapshot 和 Lane lineage 全部落盘；
5. 时间到后恢复同一个 Agent Activation，而不是创建一次全新业务执行。

`checkpoint` 是 Agent 自主选择的、小型 JSON 恢复锚点。Kernel 把它物化为下一 segment 的 `__continuationCheckpoint` 输入。它不保存完整对话，也不替代底层 session 的上下文压缩。

### 15.3 Timer Continuation 的持久投影

```ts
ActivationRecord {
  id: string
  nodeId: string
  laneId?: string
  status: 'waiting'
  continuationVersion: number
  wakeAt: number
  input: {
    __agentTimerReason?: string
    __continuationCheckpoint?: JsonValue
  }
  usage: { turns: number; costUsd: number; durationMs: number }
  parkCount: number
}

WakeRecord {
  loopId: string
  activationId: string
  fireAt: number
  status: 'pending' | 'claimed' | 'done' | 'cancelled'
}
```

Journal 写入：

```json
{
  "type": "activation_released",
  "reason": "parked",
  "activation": {
    "id": "act-123",
    "nodeId": "inspect_training",
    "status": "waiting",
    "continuationVersion": 2,
    "wakeAt": 1893456000000,
    "parkCount": 2
  }
}
```

### 15.4 时间到后的恢复协议

```text
Wake 到期
→ Scheduler 原子 claim Wake
→ 校验 Wake claim token
→ 校验 Activation.status == waiting
→ 校验 continuationVersion 仍是当前版本
→ Activation waiting → ready
→ 重新获取原 Execution Lane
→ 恢复原 lineage session
→ 注入 Timer Resume Envelope
→ 继续同一个 Node/Activation
```

Resume Envelope 至少包含：

```text
activation/node/lane
原始 timer reason
scheduledAt/wakeAt/实际 wokeAt
parkCount/累计等待时间
原始 input snapshot
当前 committed State
固定 Evidence snapshot
workspace revision 变化提示
```

`graph_agent` 继续负责 session resume 和上下文压缩；当前适配器复用 Meta-Agent KernelLoop 的实现。如果原 session 已丢失，Lane Manager 从 Activation Envelope、Journal、Artifact/Evidence 和 workspace revision 重建一个新 session。

### 15.5 Scheduler/进程不需要常驻

Timer Wake 必须存储在 durable store。以下情况都不能丢失执行位置：

```text
当前 tick 进程退出
daemon 空闲退出
机器重启
scheduler 在 wakeAt 之后才恢复
```

Scheduler 启动时执行 RECONCILE：发现 waiting Activation 的 Wake 文件缺失时先从 `wakeAt` 重建 durable Wake；到期后 Kernel 将其恢复为 ready。即使晚了数小时，也只恢复一次，不按错过的时间间隔重复执行。这也关闭了“park journal 已提交、Wake 文件尚未写入时进程退出”的双存储崩溃窗口。

### 15.6 幂等、Fencing 与重复 Wake

Wake 交付可以是 at-least-once，但 resume commit 必须幂等。去重身份由以下信息共同确定：

```text
activationId
continuationVersion
wakeId
claimToken
```

如果 Agent 在恢复后再次 park，`continuationVersion` 增加。旧版本 Wake 即使延迟到达，也只能写入 stale-wake 审计，不能恢复或修改当前 Activation。

Activation waiting→ready 的 CAS、Wake token 校验和 journal append 必须处于同一个受 fencing 保护的恢复协议中。

### 15.7 Pause/Resume

人工 pause：

- 保留 TimerContinuation 和原始 `wakeAt`；
- 冻结或取消可触发的 Wake；
- 不消费 timer、不恢复 Lane。

人工 resume：

- 若 `wakeAt` 尚未来到，按剩余时间重新注册 Wake；
- 若 `wakeAt` 已经过期，立即把 Activation 恢复为 ready；
- 仍使用相同 Activation、input snapshot 和 continuation identity。

### 15.8 硬上限与超时路由

Agent 自调用 timer 必须同时受以下限制：

```text
timerPolicy.maxDelayMs
timerPolicy.maxParks
lifetimeBudget.turns
lifetimeBudget.usd
lifetimeBudget.elapsedMs
Loop deadline
Loop activation/cost budget
```

达到上限后，Kernel 不提交新的 park，而是把当前执行段转换成确定性的失败结果：

```text
outcome = failure
output.error = "Agent Activation ... exceeded"
```

并按 Graph 中预先冻结的边路由：

```yaml
- id: training_lifetime_exceeded
  from: inspect_training
  on: failure
  to: { node: escalate }
```

不能让 Agent 通过无限 timer park 绕过 activation、费用或 lifetime 限制。

### 15.9 Event 与 Effect 延续同一模型

Event continuation 保存 `eventType + correlationKey + timeoutAt`；Effect continuation 保存 `effectKey + adapter + retry/deadline`。两者和 Timer 共用 Activation waiting/ready 状态机、continuation version、fencing 和 first-wins 恢复协议。

Agent 需要动态等待但不需要保留未完成会话时，也可以结构化输出 `wait_ms` 或 correlation key，完成当前 Node 后路由到显式 Wait Node。选择原则：

- 等待前 Node 工作已经完整提交：使用显式 Wait Node；
- 需要时间到后继续同一 Agent 的未完成判断过程：使用 Agent self-timer hard park。

## 16. 并发与竞态写

### 16.1 Claim 粒度

从：

```text
一个 Loop 最多一个 live claim
```

改为：

```text
一个 Activation 最多一个 live claim
一个 Loop 最多 N 个并行 Activation
一个 Lane 默认最多一个运行 Activation
```

### 16.2 Lane Overlay

Writable Lane 长期持有私有 overlay：

```text
Workspace Base
├── development overlay
├── experiment-A overlay
├── experiment-B overlay
└── reviewer readonly snapshot
```

同一开发循环不再每个节点创建 worktree，也不在节点间反复 merge。

### 16.3 执行与提交分离

慢执行在 Lane overlay 中进行；共享 commit 临界区只做 revision 校验、Reducer、Artifact transaction、Patch 应用和 journal append。

### 16.4 MVCC 与分片资源锁

资源键示例：

```text
state:retry_count
artifact:test-results
workspace:<workspaceId>:src/backend/**
workspace:<workspaceId>:src/frontend/**
external:k8s:production
```

不相交资源可以并行提交。重叠写入处理方式：

- 同一因果闭环：放入同一 Lane 串行；
- 竞争方案：独立 overlay，选择 winner 后只提交一个；
- 必须合并：进入 Merge Node；
- commutative Reducer：按 manifest 合并；
- 不可证明安全：静态拒绝或冲突后重跑。

不同 Loop Instance 操作同一 workspace 时，也经过 workspace identity 级 Commit Coordinator。

## 17. Distill Compiler

Distill 是编译器，而不是固定流程填表器：

```text
需求提取
→ Capability Catalog 解析
→ Node/State/Dataflow/Transition 生成
→ Lane/SCC 分组
→ Function/Reducer/Effect 绑定
→ 类型检查
→ 路由重叠与 totality 检查
→ 并发读写冲突分析
→ Cycle/Wait/Join 有界性分析
→ 有界控制流模拟
→ LLM 修复
→ 人工审核
→ Freeze
```

静态验证至少保证：

- 所有节点从 entry 可达；
- terminal/escalation 可达；
- 每组 route 有唯一选择或显式 fork；
- 每个 cycle 有 activation/budget/deadline 上限；
- wait 有 timeout route；
- join 不会静态死锁；
- 所有 DataBinding 类型匹配；
- Reducer/Function/Effect ID 真实注册；
- 副作用有 idempotency key；
- 并行 write set 不冲突；
- Lane context/workspace 策略闭合。

产物：

```text
loop.graph.draft.json
loop.explain.md
loop.validation.json
capability-lock.json
```

## 18. Capability Pack 取代具体 Scenario

Capability Pack 提供领域组件；当前 v1 loader 已正式支持 Function/Reducer、Effect、Context Provider 和 advisory Scenario Guidance：

```text
Function/Reducer
Effect Protocol
Context Provider
Scenario Guidance + bounded advisory Graph Fragment（已实现，非模板、可组合/可忽略）
Capability input/output schema（已实现）
Graph Preset / Report Renderer / 新物理 Backend（规划中）
```

Research direction/finding、Release manifest/note、Compliance bundle/approval 等只能作为 guidance 或未来 preset 的例子，而不是 Kernel 或整个领域 Scenario 的固定语义。多个 Pack 可以同时参与同一 Graph；Distill reviewer 不得以某个 guidance 为固定拓扑判据。

## 19. 唯一执行模型

实例只记录并执行 `durable-graph-v1`。CLI、runner、daemon、Wake scheduler 和公开导出均不再探测或分派其他 Loop engine；`create` 只接受 `graph-1.0`。旧格式不会在 load 时静默转换，避免两套恢复语义、状态真相和插件 ABI 长期共存。

领域复用统一落到 Capability Pack、Graph preset 和 Distill guidance。Kernel 不包含 Research、Release、Compliance 或其他领域分支。

## 20. 实施阶段

1. **架构冻结**：GraphSpec、Activation 状态机、Journal 和 commit protocol。
2. **IR/Validator**：类型系统、表达式、Reducer/Function Registry、模拟器。
3. **确定性 Kernel**：Function/Wait/Terminal，无 LLM先跑通恢复。
4. **Execution Lane/Agent Node**：持久 session、Context Envelope、Lane overlay。
5. **Artifact/Evidence Plane**：proposal/admission/snapshot/query。
6. **Effect/Event/Resume**：外部副作用和 continuation。
7. **Fork/Join/Commit Coordinator**：Activation 级并发和冲突分析。
8. **Distill Compiler**：自然语言生成、修复、解释和 Freeze。
9. **Capability Packs**：领域 Function/Reducer/Effect/Schema/Guidance/preset 可组合加载。
10. **产品化**：CLI inspect/trace/simulate 和完整 crash matrix。

## 21. 验收场景

必须覆盖：

1. implement → test → fix，最多三次；
2. `state >= 2` 与 `state >= 8` 的确定性优先级路由；
3. persistent development Lane 跨多个循环保持上下文和 overlay；
4.底层 session 发生压缩后仍收到完整 Activation Envelope；
5.三个 readonly reviewer 并行并 all/any join（quorum 留作后续 ABI 扩展）；
6.两个竞争实现分支只提交 winner；
7.并行分支写同一 state/workspace 时静态拒绝；
8. Judge 基于固定 Evidence Snapshot，后到 Evidence 不污染本次判断；
9. timer/event/effect resume 同一 Activation；
10.每个 commit 边界 kill -9 后不重复提交；
11. stale claim 不能写 State/Artifact/workspace；
12. reducer/plugin integrity 变化时拒绝 resume；
13.无出口 cycle、缺失 fallback、无界 Effect 与无界 Agent hard park 在 create 前被拒绝；
14.不同 Loop 写同一 workspace 路径时由全局 Coordinator 协调。

## 22. 最终定位

目标 Runtime 的核心不是“每轮运行哪些固定角色”，而是：

```text
Kernel 如何可靠地执行 Distill 生成的任意受约束图节点和边
```

最终职责边界：

```text
Distill             设计图、State、Lane、数据流、Reducer 和路由
Graph Kernel        执行 Activation、Transition、Wait、Commit 和 Recovery
Execution Lane      让强相关节点共享 LLM context 和私有工作副本
graph_agent SPI      管理 Agent segment、对话、工具循环和上下文压缩
Artifact/Evidence   提供全图一致、可审计、可快照的公共知识
Commit Coordinator  处理 State、Artifact 和 workspace 的共享提交
```

其中最关键的设计判断是：

> Graph Node 保留精确控制语义；多个强相关 Graph Node 由同一个持久 Execution Lane/LLM session 执行。

这样同时保留图的泛化、审计和恢复能力，又避免“每节点一个 Agent”造成的上下文断裂与并发写退化。

## 23. 可靠性加固（2026-07-14 复核）

当前实现进一步固定以下不变量：

- daemon abort 是 replay，不是业务 failure；确认取消前绝不重放同一 Lane，无法确认取消则 fail-stop；
- Agent 常规失败受 `maxAttempts` 约束，runner 未分类故障最多退避五次；
- Event 先落持久 inbox，按事件时间与 timeout first-wins；
- fork group 标识一个 Join epoch，`Join(any)` 的迟到分支不能二次触发；
- Journal 使用 sequence counter、周期 checkpoint 和 tail fold，heartbeat 不增长 Journal；
- Artifact 容量是 publication gate，不是实例级异常；
- Effect 的 `timeoutMs` 覆盖 submit 后的完整 poll 生命周期；
- Lane merge 冲突 pause 图并保留 terminal replay，使用 `loop lane-repair` 显式恢复；
- entrypoint Function 物化在 Graph transaction lock 外执行。

完整逐项证据见 [Durable Graph Loop Runtime 代码评审与复核](loop-graph-runtime-review-2026-07-14.md)。
