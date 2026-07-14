# Durable Graph Loop Runtime 重构方案

> 状态：目标架构设计，尚未替代当前 `legacy-round-v1` Runtime。
>
> 核心目标：**Kernel 可靠执行 Distill 生成的任意受约束图节点和边。**

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

`agentic`、`auto`、`simple_auto` 已经负责：

- 会话历史压缩；
- 工具结果裁剪；
- token 预算控制；
- tool call/result 结构修复；
- session resume。

Graph Loop 不再实现第二套 LLM context compactor。它只负责每次 Activation 的确定性上下文装配，并把稳定 session 交给底层执行模式管理。

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

  artifacts?: Record<string, ArtifactChannelSpec>
  evidenceViews?: Record<string, EvidenceViewSpec>
  effects?: Record<string, EffectBinding>

  limits: LoopLimits
  concurrency?: LoopConcurrencyPolicy
}
```

Graph 在 create/freeze 后固定。运行期间变化的是 Activation、State、Artifact、Evidence、Event 和 workspace revision，不允许运行中由 Agent 静默改图。

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
-最新 Artifact/Evidence 引用。

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

支持 `all`、`any` 和 `quorum`，并持久化 fork group 和分支结果。

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

-稳定 session/lineage ID；
-底层模式管理的对话上下文；
-私有 workspace overlay/worktree；
-单线程 mailbox；
- state/artifact/evidence cursor；
- workspace revision；
-资源租约；
-上下文 Anchor。

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

### 9.4 Activation Context Envelope

Loop 不压缩聊天，但每次调用底层 session 都重新注入：

```ts
interface ActivationContextEnvelope {
  loop: { id: string; goal: string; graphHash: string }
  lane: { id: string; workspaceRevision?: string }
  activation: { id: string; nodeId: string; attempt: number }
  stateRevision: number
  state: JsonValue
  input: JsonValue
  artifactViews: ArtifactView[]
  evidenceViews: EvidenceView[]
  openObligations: string[]
}
```

底层 session 可以自行压缩旧历史；当前节点的权威输入不会因压缩消失。session 丢失时，也能从 Envelope、Journal 和 Artifact/Evidence 重建。

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
  activationId: string
  loopId: string
  nodeId: string
  laneId: string
  parentActivationId?: string
  forkGroupId?: string
  status: 'ready' | 'claimed' | 'running' | 'waiting' |
    'completed' | 'failed' | 'cancelled'
  inputSnapshot: JsonValue
  stateRevisionAtEnqueue: number
  evidenceSnapshots: EvidenceSnapshotRef[]
  attempt: number
  claim?: { token: string; owner: string; expiresAt: number }
  output?: JsonValue
  continuation?: ContinuationSpec
}
```

Activation ID 由 loop、parent activation、transition、target node、branch index 等稳定信息派生，重复调度同一条已提交边不会制造重复 Activation。

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

新增权威日志：

```text
ledger/execution.jsonl
```

事件包括：

```text
loop.created
activation.enqueued
activation.started
activation.committed
activation.waiting
activation.resumed
activation.retry_scheduled
activation.cancelled
transition.selected
loop.paused
loop.resumed
loop.terminal
graph.migrated
```

每次 transition 记录当时 state revision、表达式结果、函数版本、选中边和子 Activation ID，确保可解释和 replay。

## 15. Time、Event、Effect 与 Resume

Wait 不再是 worker/pending_round 特例，而是 Activation continuation：

```text
timer → wakeAt
event → eventType + correlationKey + timeoutAt
effect → effectKey + adapter + retry/deadline
```

唤醒只将对应 Activation 从 waiting 变为 ready。Resume 恢复的是同一 Activation 和同一 input/evidence snapshot。

Agent 需要动态等待时，输出 `wait_ms` 或 correlation key，路由到 Wait Node，由 Kernel 注册 continuation。

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

-同一因果闭环：放入同一 Lane 串行；
-竞争方案：独立 overlay，选择 winner 后只提交一个；
-必须合并：进入 Merge Node；
- commutative Reducer：按 manifest 合并；
-不可证明安全：静态拒绝或冲突后重跑。

不同 Loop Instance 操作同一 workspace 时，也经过 workspace identity 级 Commit Coordinator。

## 17. Distill Compiler

Distill 是编译器，而不是固定 Charter 填表器：

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

-所有节点从 entry 可达；
- terminal/escalation 可达；
-每组 route 有唯一选择或显式 fork；
-每个 cycle 有 activation/budget/deadline 上限；
- wait 有 timeout route；
- join 不会静态死锁；
-所有 DataBinding 类型匹配；
- Reducer/Function/Effect ID 真实注册；
-副作用有 idempotency key；
-并行 write set 不冲突；
- Lane context/workspace 策略闭合。

产物：

```text
loop.graph.draft.json
loop.explain.md
loop.validation.json
capability-lock.json
```

## 18. Capability Pack 取代具体 Scenario

Capability Pack 只提供领域组件：

```text
Artifact Schema
Function/Reducer
Effect Protocol
Agent Node Template
Evidence View Template
Report Renderer
Distill Guidance
Graph Preset
```

现有 Research direction/finding、Release manifest/note、Compliance bundle/approval 都应成为 preset，而不是 Kernel 或整个领域 Scenario 的固定语义。多个 Pack 可以同时参与同一 Graph。

## 19. 兼容策略

实例明确记录执行器：

```text
legacy-round-v1
durable-graph-v1
```

旧实例继续使用旧 Kernel；新 Distill 默认生成 GraphSpec。提供显式 `legacyCharterToGraphSpec` 和迁移模拟，但不在 load 时静默转换。

旧概念映射：

| 旧机制 | Graph Runtime |
| --- | --- |
| worker/judge/pivoter/finalizer | 任意 Agent Node |
| meters | State + Reducer |
| tripwires | Transition |
| continue/pivot | 普通回边/策略节点 |
| finalize/escalate | Terminal Node |
| pending_round | Activation Continuation |
| ScenarioRuntime | Capability Providers/Presets |
| RoundEntry | 可选 iteration 投影 |

## 20. 实施阶段

1. **架构冻结**：GraphSpec、Activation 状态机、Journal 和 commit protocol。
2. **IR/Validator**：类型系统、表达式、Reducer/Function Registry、模拟器。
3. **确定性 Kernel**：Function/Wait/Terminal，无 LLM先跑通恢复。
4. **Execution Lane/Agent Node**：持久 session、Context Envelope、Lane overlay。
5. **Artifact/Evidence Plane**：proposal/admission/snapshot/query。
6. **Effect/Event/Resume**：外部副作用和 continuation。
7. **Fork/Join/Commit Coordinator**：Activation 级并发和冲突分析。
8. **Distill Compiler**：自然语言生成、修复、解释和 Freeze。
9. **Capability Packs/Legacy Adapter**：现有 Scenario 降级为 preset。
10. **产品化**：CLI inspect/trace/simulate、迁移和完整 crash matrix。

## 21. 验收场景

必须覆盖：

1. implement → test → fix，最多三次；
2. `state >= 2` 与 `state >= 8` 的确定性优先级路由；
3. persistent development Lane 跨多个循环保持上下文和 overlay；
4.底层 session 发生压缩后仍收到完整 Activation Envelope；
5.三个 readonly reviewer 并行并 quorum join；
6.两个竞争实现分支只提交 winner；
7.并行分支写同一 state/workspace 时静态拒绝；
8. Judge 基于固定 Evidence Snapshot，后到 Evidence 不污染本次判断；
9. timer/event/effect resume 同一 Activation；
10.每个 commit 边界 kill -9 后不重复提交；
11. stale claim 不能写 State/Artifact/workspace；
12. reducer/plugin integrity 变化时拒绝 resume；
13.无出口 cycle、缺失 fallback、无 timeout wait 在 create 前被拒绝；
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
底层执行模式         管理 Agent 对话、工具循环和上下文压缩
Artifact/Evidence   提供全图一致、可审计、可快照的公共知识
Commit Coordinator  处理 State、Artifact 和 workspace 的共享提交
```

其中最关键的设计判断是：

> Graph Node 保留精确控制语义；多个强相关 Graph Node 由同一个持久 Execution Lane/LLM session 执行。

这样同时保留图的泛化、审计和恢复能力，又避免“每节点一个 Agent”造成的上下文断裂与并发写退化。
