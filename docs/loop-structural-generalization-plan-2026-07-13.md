# Loop 长周期结构泛化方案（2026-07-13）

> 状态：设计提案，尚未实现。
>
> 范围：meta-agent Loop 运行时；Campaign 不在本文范围内。
>
> 前置工作：`loop-review-fix-plan-2026-07-11.md` 中的可靠性、安全、预算、调度与
> 长周期性能修复。

## 1. 背景与结论

当前 Loop 已具备固定轮次、持久化账本、等待/恢复、Gate、预算、人工升级和并发调度等
长周期运行时基础，但业务模型仍偏研究场景：Kernel 直接理解 finding、direction、
numeric metric 和研究报告。

长期推荐采用：

```text
薄内核 + 声明式 Charter + 受控插件 + 场景包
```

九步生命周期保持固定：

```text
WAKE → RECONCILE → CAPSULE → MODE → SEAT → GATE → METER → LEDGER → ROUTE
```

固定的是控制流、事务和安全边界；可扩展的是状态、产物、观测、Reducer、Gate、Effect、
Capsule 与报告。Loop 不演变成任意 DAG 工作流引擎。

## 2. 设计目标

### 2.1 必须满足

1. 同一内核覆盖研究、软件研发、发布、运维、合规、数据流水线和人工审批。
2. 任意时刻 kill -9 后，可以由持久化状态恢复，不重复结算已提交轮次。
3. LLM 不能直接修改长期状态；所有长期状态都由确定性 Reducer 生成。
4. 外部副作用有幂等键、状态机、超时、取消、对账和审计记录。
5. 插件不能绕过预算、Gate、Ledger、路径和进程隔离。
6. 当前 Research Loop 能通过兼容场景包迁移，既有实例可继续读取和运行。
7. 月级运行时的热路径成本与近期数据规模相关，而不是与全部历史线性相关。

### 2.2 明确不做

- 不提供 Charter 内嵌任意代码。
- 不提供图灵完备控制流 DSL。
- 不允许插件直接写 Ledger。
- 不允许 LLM seat 直接写 state projection。
- 不把各类业务系统的逻辑继续硬编码进 LoopKernel。
- 不通过删除审计历史换取性能。

## 3. 分层架构

```text
┌──────────────────────────────────────────────────────────┐
│ Scenario Pack                                            │
│ research / software / release / ops / compliance / data │
├──────────────────────────────────────────────────────────┤
│ Controlled Plugin Runtime                                │
│ reducer / gate / observable / effect / capsule / report │
├──────────────────────────────────────────────────────────┤
│ Generic Loop Kernel                                      │
│ wake / attempt / seat / budget / commit / route / audit │
├──────────────────────────────────────────────────────────┤
│ Durable Runtime                                          │
│ event log / projection / snapshot / lease / child proc  │
└──────────────────────────────────────────────────────────┘
```

### 3.1 Generic Loop Kernel

Kernel 长期只负责：

- Wake claim、lease、并发、重试和恢复；
- Round/attempt 的事务提交与幂等；
- Seat 启动、终止、预算、上下文血缘和 sandbox；
- Artifact proposal、Gate 和 commit；
- Effect 提交、等待、对账、收割和超时；
- Reducer 的确定性调用；
- Route 优先级与终止语义；
- Ledger、snapshot、迁移和审计。

Kernel 不理解 finding、direction、训练平台期、发布审批或运维告警等业务词汇。

### 3.2 Controlled Plugin Runtime

插件提供确定性的业务构件。内置插件可与 runtime 同版本发布；第三方插件必须通过独立
子进程 JSON-RPC 调用，并受 timeout、输出上限、权限和进程组终止约束。

### 3.3 Scenario Pack

场景包组合 Charter 模板、Artifact、Reducer、Gate、Effect adapter、Capsule view、报告
和迁移脚本，不拥有调度、账本或安全机制。

## 4. 通用 Charter

建议的顶层模型：

```ts
interface GenericCharter {
  identity: {
    id: string
    version: number
    goal: string
    scenario: string
  }

  state: Record<string, StateProjectionSpec>
  artifacts: Record<string, ArtifactSpec>
  observables: Record<string, ObservableSpec>
  objectives?: Record<string, ObjectiveSpec>
  reducers: ReducerBinding[]
  gates: GateBinding[]
  effects: Record<string, EffectBinding>
  seats: Record<string, SeatSpec>

  policies: {
    route: RouteRule[]
    health: HealthRule[]
    budgets: BudgetPolicy
  }

  capsule?: ViewBinding
  reports?: ReportViewSpec[]
}
```

Charter 是声明和绑定，不包含任意执行代码。所有插件都绑定精确版本，并在实例化时冻结。

## 5. Artifact 模型

Artifact 替代当前 Kernel 内的 findings/directions 硬编码。

```ts
interface ArtifactSpec {
  kind: 'json' | 'text' | 'workspace_diff' | 'binary_ref' | 'external_ref'
  draftPath?: string
  shape?: ShapeSpec
  producer: string
  gates: string[]
  commit: {
    stream: string
    mode: 'append' | 'replace' | 'versioned'
  }
  retention?: 'permanent' | 'snapshot' | 'ephemeral'
}
```

示例：

```json
{
  "artifacts": {
    "experiment_result": {
      "kind": "json",
      "draftPath": "drafts/experiment-result.json",
      "producer": "worker",
      "shape": {
        "type": "object",
        "required": ["hypothesis", "evidence", "result"]
      },
      "gates": ["evidence_shape", "independent_review"],
      "commit": {"stream": "experiment_results", "mode": "append"}
    },
    "code_patch": {
      "kind": "workspace_diff",
      "producer": "worker",
      "gates": ["tests_pass", "review_pass"],
      "commit": {"stream": "code_changes", "mode": "versioned"}
    }
  }
}
```

每个已提交 Artifact 必须记录 producer、Gate verdict、schema version、provenance、内容
hash 和提交事件 ID。

## 6. State Projection 与 Reducer

长期状态由事件投影得到，不能由 seat 或插件直接覆盖。

```ts
interface Reducer<State, Event> {
  id: string
  version: string
  reduce(previous: Readonly<State>, event: Readonly<Event>): State
}
```

Reducer 约束：

- 纯函数；
- 无网络、文件写、环境变量和模型调用；
- 相同输入得到字节级等价输出；
- 输入、输出都经过 ShapeSpec 校验；
- 版本冻结，可由历史事件全量重放；
- 失败时本轮 fail-stop，不能部分提交 projection。

示例：

```json
{
  "state": {
    "release": {
      "initial": {
        "candidate": null,
        "failedChecks": 0,
        "approved": false
      },
      "reducer": "builtin/release-state@1"
    }
  }
}
```

## 7. Observable 与 Objective

### 7.1 Observable 来源

```ts
type ObservableSource =
  | { from: 'artifact'; artifact: string; pointer: string }
  | { from: 'state'; projection: string; pointer: string }
  | { from: 'effect'; effect: string; pointer: string }
  | { from: 'ledger'; aggregate: string }
  | { from: 'adapter'; adapter: string; params: unknown }
  | { from: 'judge'; seat: string; key: string }
```

```ts
interface ObservableValue {
  value: number | string | boolean | null
  source: string
  observedAt: number
  provenance: string[]
  confidence?: number
}
```

Route 只能消费已经写入本轮审计事件的 Observable，不能直接读取 worker 文本。

### 7.2 多目标 Objective

```ts
interface ObjectiveSpec {
  source: string
  direction: 'max' | 'min'
  weight?: number
  hardMin?: number
  hardMax?: number
}
```

```json
{
  "objectives": {
    "quality": {"source": "evaluation.score", "direction": "max", "weight": 0.6},
    "latency": {"source": "benchmark.p95_ms", "direction": "min", "hardMax": 500},
    "cost": {"source": "budget.total_usd", "direction": "min", "weight": 0.2}
  }
}
```

Kernel 负责保存和展示 Objective，不内置具体优化算法。加权、瓶颈、Pareto 等策略由确定性
objective adapter 提供。

## 8. Gate

统一 Gate 接口：

```ts
interface GateResult {
  verdict: 'pass' | 'fail' | 'error'
  messages: string[]
  evidence: string[]
  data?: unknown
}
```

Gate 类型：

- `shape`：Kernel 内置结构校验；
- `command`：受控命令、固定 cwd、timeout 和输出上限；
- `adapter`：确定性插件；
- `judge`：隔离 LLM seat；
- `human`：外部审批事件。

统一规则：

- 未执行、timeout、插件崩溃和输出非法均不是 pass；
- 声明了 Gate 的 Artifact 只有所有 Gate pass 才能 commit；
- Gate 输入是显式 evidence whitelist；
- Gate verdict、证据 hash 和插件版本必须进入 Ledger。

## 9. Effect Adapter

```ts
interface EffectAdapter {
  id: string
  version: string

  submit(input: unknown, idempotencyKey: string): Promise<SubmitResult>
  inspect(handle: EffectHandle): Promise<EffectObservation>
  cancel(handle: EffectHandle): Promise<CancelResult>
  reconcile(handle: EffectHandle): Promise<ReconcileResult>
}
```

Charter 示例：

```json
{
  "effects": {
    "training": {
      "adapter": "gradmotion/task@2",
      "poll": {"everyMs": 7200000, "timeoutMs": 604800000},
      "rules": [
        {"when": "status == 'completed'", "then": "harvest"},
        {"when": "slope < 0.001 && samples >= 5", "then": "cancel_and_harvest"},
        {"when": "balance <= 0", "then": "escalate"}
      ]
    }
  }
}
```

Effect 要求：

- `effectKey` 在实例生命周期内唯一；
- submit/inspect/cancel/reconcile 均有 timeout、输出上限和审计；
- event 是低延迟路径，inspect/poll 是事件丢失时的确定性保底；
- 首个 terminal verdict 胜出，后续 verdict 保留为重复事件但没有控制效果；
- adapter 不得直接调度 round 或写 Ledger；
- 无法确认取消时实例 fail-stop，禁止旧任务与重放任务并存。

## 10. 插件 ABI 与隔离

```ts
interface LoopPluginManifest {
  id: string
  version: string
  apiVersion: string
  capabilities: Array<
    | 'effect-adapter'
    | 'observable-provider'
    | 'reducer'
    | 'gate'
    | 'capsule-view'
    | 'report-view'
  >
  inputSchemas: Record<string, ShapeSpec>
  outputSchemas: Record<string, ShapeSpec>
  permissions: {
    network?: string[]
    readPaths?: string[]
    writePaths?: string[]
    subprocess?: string[]
  }
}
```

第三方插件执行要求：

1. 独立进程组；
2. stdin/stdout JSON-RPC framing；
3. 启动、单请求和总生命周期 timeout；
4. stdout/stderr 字节上限；
5. timeout/abort 时终止完整进程组；
6. 默认无网络、只读工作区；
7. 输入输出双向 schema 校验；
8. manifest 权限与 Charter 引用交叉校验；
9. 实例冻结插件版本和内容 hash；
10. ABI 不兼容时拒绝启动，而不是降级运行。

## 11. 场景包

建议首批官方场景包：

```text
builtin/research@1
builtin/software-development@1
builtin/release@1
builtin/operations@1
builtin/compliance@1
builtin/data-pipeline@1
builtin/human-approval@1
```

目录约定：

```text
scenario.json
charter-template.json
artifacts/
reducers/
gates/
effects/
capsule-view/
report-view/
distiller-prompt.md
migrations/
tests/
```

场景包只能组合和提供构件，不允许替换 Kernel 的预算、提交、恢复和安全机制。

## 12. Research Loop 兼容迁移

当前研究语义迁移到 `builtin/research@1`：

| 当前硬编码 | 泛化后 |
|---|---|
| `findings_draft.json` | `finding` Artifact draft |
| `findings.jsonl` | `findings` Artifact stream |
| `direction.json` | `direction` Artifact draft |
| `directions.json` | `research_state` projection |
| `bestMetric` | 单一 Objective projection |
| diversity check | `direction-diversity` Gate |
| CapsuleBuilder 研究字段 | research capsule view |
| final report 研究模板 | research report view |

兼容策略：

1. 当前 Charter schema 继续可读；
2. load 时映射到等价的内置 Research scenario binding；
3. 既有实例不就地改写冻结快照；
4. 显式 `loop migrate` 才生成新 schema/version；
5. 迁移前后对同一历史 Ledger 做 projection parity 测试；
6. 至少保留一个大版本的只读旧 Ledger 支持。

## 13. Event Ledger 与 Projection

长期权威数据统一为事件：

```ts
interface LoopEvent {
  eventId: string
  instanceId: string
  roundId?: string
  attemptId?: string
  sequence: number
  type: string
  schemaVersion: string
  payload: unknown
  createdAt: number
  provenance?: string[]
}
```

核心事件：

```text
round.started
seat.started
seat.completed
artifact.proposed
gate.completed
artifact.committed
effect.submitted
effect.observed
effect.concluded
state.projected
route.decided
round.committed
human.feedback
loop.terminated
```

`progress.json`、Capsule、inspect 输出和报告都是可重建 projection。

### 13.1 分段与快照

- Event log 按大小或事件数轮转为只读 segment；
- segment 带序号范围、hash 和前段 hash；
- snapshot 带 projector version、last sequence、segment/offset 和 state hash；
- snapshot 写入成功后才能封存 segment；
- 原始 segment 不截断，可压缩或归档；
- 恢复时验证 snapshot watermark 和后续事件连续性；
- snapshot 不可信时退回事件重放；
- CI 验证 snapshot projection 与全量 replay 完全一致。

## 14. 大规模部署模型

### 14.1 Round 子进程

Daemon 只负责 claim、admission、监控和结果落账。每个 Round 在短生命周期子进程执行：

```text
daemon
  ├─ round-worker(loop-a, attempt-17)
  ├─ round-worker(loop-b, attempt-03)
  └─ round-worker(loop-c, attempt-42)
```

要求：

- attempt/task 绑定持久化；
- child 启动前写 dispatch intent；
- child 只能提交结果，最终 commit 仍由单一 Kernel 提交器完成；
- OOM、崩溃或 kill -9 不拖倒 daemon；
- daemon shutdown 停止 claim，取消/drain child，最后释放 host lease；
- orphan attempt 启动时对账，而不是直接重放。

### 14.2 Admission Control

至少支持：

- workspace 最大并发 Round；
- tenant/project 并发与 USD 配额；
- adapter 并发限制；
- provider/model 并发限制；
- waiting、ready、running 队列上限；
- 优先级和公平调度；
- backpressure 和拒绝原因审计。

### 14.3 可观测性

指标建议：

```text
loop_round_duration_seconds
loop_round_retries_total
loop_wake_lag_seconds
loop_effect_wait_seconds
loop_effect_duplicate_events_total
loop_seat_cost_usd
loop_gate_failures_total
loop_projection_rebuild_total
loop_scheduler_inflight
loop_scheduler_queue_depth
loop_plugin_failures_total
```

每个日志和 trace 统一携带 `instanceId / roundId / attemptId / taskId / effectKey`。

## 15. 实施阶段

### G1 — 去研究硬编码

- 引入 Artifact stream；
- findings/directions 迁入 `builtin/research@1`；
- bestMetric 映射为 Objective；
- Capsule 和报告变成 scenario view；
- 保持当前行为和 Ledger parity。

验收：现有 Research Loop 测试在兼容层和新场景包上产生相同 route、meter、findings、
best metric 和报告关键信息。

### G2 — 通用状态演进

- typed projection；
- pure reducer；
- artifact proposal/gate/commit 协议；
- projector snapshot；
- replay 与 crash-injection 测试。

验收：至少用 release、compliance 两个非研究场景证明 Kernel 无需新增业务分支。

### G3 — 确定性外部系统

- EffectAdapter ABI；
- inspect/cancel/reconcile；
- event + poll 双通道；
- deadline、retry、SLA 和 adapter 限流。

验收：外部事件丢失、重复、乱序、adapter timeout、取消不确认和 daemon kill -9 均有
确定性结果。

### G4 — 插件与场景包

- plugin manifest；
- JSON-RPC 子进程；
- 权限与 ABI 校验；
- scenario registry；
- migration framework。

验收：第三方插件无法直接写 Ledger、越权访问路径、无限输出或遗留子进程。

### G5 — 大规模部署

- round child process；
- admission control；
- 持久化 attempt registry；
- event inbox service；
- segment/snapshot；
- metrics/tracing；
- chaos 和 kill-point 矩阵。

验收：多实例长时间压力测试无重复 round、无双 worker、无无限目录/日志增长，调度延迟与
活跃规模满足目标 SLO。

## 16. 建议的工程顺序

1. 先定义 `LoopEvent / ArtifactSpec / ProjectionSpec / Reducer`，不要先写插件加载器；
2. 将现有 Research 行为迁入内置 scenario，建立兼容基线；
3. 用 release 场景验证非 finding 型 artifact；
4. 用 compliance 场景验证 human gate 和不可变审计；
5. 再开放 EffectAdapter；
6. ABI 稳定后才允许第三方插件；
7. 最后切换 Round 子进程与生产级 admission control。

每一阶段都要求旧测试全绿、事件重放一致、迁移可逆或 fail-stop，不允许通过隐式降级维持
表面兼容。

## 17. 完成定义

结构泛化完成至少满足：

- Kernel 源码中不再出现 finding、direction、training 等场景业务分支；
- 两个新场景只通过 Charter/Scenario/Plugin 完成，无需修改 Kernel；
- 所有 projection 可由 Event Ledger 重建；
- 所有外部 Effect 可对账、取消、超时和幂等收割；
- 第三方插件崩溃、超时、无限输出、越权和遗留进程都有结构性防护；
- 当前 Research Loop 可显式迁移且语义一致；
- 月级历史下 hot-path 读取与近期窗口/活跃 effect 数相关；
- 多 Loop 并发、daemon 重启和 kill-point chaos 测试通过。

达到以上条件后，Loop 才能从“可靠的研究型长周期运行时”升级为“通用的长周期自主研发
与运营内核”。
