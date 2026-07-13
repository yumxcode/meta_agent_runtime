# Loop 长周期结构泛化方案（2026-07-13）

> 状态：设计已吸收 `loop-structural-generalization-review-2026-07-13.md` 的初审至四审意见；
> G0 已启动首个兼容切片（`producer_ok`、judge-dependent meter AST 改写、显式 retain warning、
> 旧 frozen Charter 内存升级），并完成第二个兼容切片（`observationResults` 三态双写、
> Tripwire/Health absent/error 策略、Objective absent/error/null 策略与 `rule_error` fail-stop）。
> 第三个契约切片也已完成（frozen observable obligation 图、Judge 输出契约绑定、Reducer
> 三态输入 ABI、穷尽策略校验与 fail-stop/skip 准备边界）。第四个切片已将
> `builtin/conditional-counter-set@1` 接入真实 METER 路径，并冻结固定 Seat/GateBinding
> execution plan；wait/diversity/schema/judge 的 producer/execution retry 已从该计划读取。
> 第五个切片已引入通用 Artifact proposal/Gate/decision 协议与 append-only Artifact
> authority；findings/directions 的草稿解析、专用 Gate、事务提交、兼容 projection、收割提示
> 和报告已迁入内置 Research Scenario，Kernel/Worker 仅通过 `ScenarioRuntime` 能力边界调用。
> 第六个切片已将 Scenario ID、完整 ArtifactSpec 和有 handler/gateIds 的有序 GateBinding
> 冻结进 GenericCharter；多 Scenario registry 可按实例快照选择 `builtin/research@1` 或
> `builtin/generic@1`，schema/judge/Scenario Gate 均以冻结 binding 为执行权威，legacy 快照
> 缺省确定性升级到 Research。通用 Projection 配置、外部 Scenario/plugin 注册和第三方
> reducer 执行仍未开放。第七个切片进一步抽出通用 Artifact transaction executor：proposal、
> Gate result、terminal decision 统一 append-only 提交，事务按 ID 幂等；append/replace/versioned
> stream 均可仅从 terminal events 重放。Generic Scenario 已支持 Charter 声明的 JSON/text/
> workspace_diff/external_ref Artifact，并以 `artifact_drafts` Gate 对 malformed draft 做有界纠偏；
> Research Scenario 已复用同一 executor。第八个切片冻结 typed ProjectionBinding（Artifact
> stream → `builtin/artifact-view@1` → count/latest/window），window 强制有界；Artifact
> checkpoint 已升级为 v3：记录 projector/config/state hash、sealed segment head、活动文件完整行
> offset、事件数和有界 view。Artifact authority 按阈值轮转为不可变 segment，manifest 保存连续
> sequence range、segment hash 与 previous hash；正常热路径只解析活动尾部，checkpoint/manifest
> 不匹配、配置变化或 checkpoint 损坏时校验哈希链后确定性全量重建。
> transaction ID 与 versioned content hash 使用 SHA-256 分片的磁盘派生索引，支持任意旧事务
> 精确幂等而不把历史 ID 集合塞入内存；replace/versioned 的 logical stream state 保持在有界
> checkpoint 中。segment manifest 已升级为常量大小 root + 64 段一页的不可变 metadata page，
> page 之间哈希链接，旧 v1 全量 manifest 自动迁移。
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
WAKE → RECONCILE → MODE → CAPSULE → SEAT → GATE → METER → LEDGER → ROUTE
```

固定的是控制流、事务和安全边界；可扩展的是状态、产物、观测、Reducer、Gate、Effect、
Capsule 与报告。Loop 不演变成任意 DAG 工作流引擎。

其中 `METER` 是为现有生命周期与 Ledger parity 保留的阶段名，泛化后执行所有确定性
projection reducer；计数器只是 `builtin/conditional-counter-set@1` 的一种 projection，
Kernel 不再为业务 meter 保留特殊求值分支。

### 1.1 2026-07-13 评审决策

| 评审项 | 决策 | 落点 |
|---|---|---|
| D1 observable 缺失语义 | 接受，G1 阻断 | §7.1、G0 |
| D2 Seat 任意集合会滑向 DAG | 接受，G1 阻断 | §4.1 |
| S1 Gate 纠偏协议缺失 | 接受，G1 阻断 | §8.1 |
| S2 Effect Rule 欠规格 | 接受并限制为硬边界 | §9.2 |
| S3 Distiller 自由生成风险 | 接受，改为模板参数化 | §11.1 |
| S4 凭据管理缺失 | 接受 | §10.1 |
| C1 与 F12 决策关系不清 | 接受，声明为部分回退 | §9.1 |
| C2 未从 postState 演进 | 接受，不另起双权威 | §13.1 |
| C3 九步顺序错误 | 接受并更正 | §1 |
| X1 waiting 兼容金样本 | 接受 | §12.1、G0/G1 |
| A1 三态未贯穿 Reducer/Meter | 接受，提升为统一输入协议 | §6.1、§7.1、§12 |
| A2 纠偏上界破坏 Research parity | 接受，改为每 GateBinding 一次 | §8.1、G1 |
| A3 证据、崩溃重跑与 hash 措辞 | 接受并澄清 | §4.1、§8.1、§12.1 |
| B1 counter fallback 依赖 producer 状态 | 接受，改为内置 `producer_ok` observable | §6.1、§7.1、§12 |
| B2 HealthRule 缺少三态语义 | 接受，与 RouteRule 使用同一失败策略 | §7.1 |
| B3 G0 混入模板实现 | 接受，G0 只冻结契约，实现移入 G1 | §15 |
| B4 Objective present-null 未定义 | 接受，显式 skip/fail 策略 | §7.2 |
| C1' meter-only 改写偏离 parity | 接受，只改写引用 judge observable 的表达式 | §6.1、§12 |
| C2' cancel 与 abort 语义冲突 | 接受，abort 不生成 `producer_ok` | §7.1 |
| C3' `seat.blocked` 事件缺失 | 接受，补入核心事件 | §13.1 |

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

### 2.3 实例特化隔离（设计不变量）

Loop 的 schema、Kernel、内置 Scenario 和 Distill 默认提示不得识别任何具体项目的目录名、
业务命令、skill 名、远端平台、指标或凭据布局。项目值只能通过需求文档、实际 workspace
检查、宿主 registry/catalog 或人工审阅后的 Charter 进入单个实例。

- `workspace:<relative-path>` 是通用的只读证据寻址协议，不代表某个固定“历史目录”；宿主不
  自动发现约定目录，create 只验证 Charter 已明确声明的文件存在、为项目内真实路径且不能
  经 symlink 越界。
- Scenario ID、ArtifactSpec、GateBinding 和 EffectAdapter ID 来自冻结 registry；业务系统
  名称只允许作为某个注册项或 Charter 实例值，不能成为 Kernel 分支。
- 文档示例必须标明其名称和路径是可替换实例值；测试可保留脱敏项目 fixture，但只能验证
  通用 ABI/兼容性，不得让 fixture 名称参与运行时选择或赋予额外权限。
- Distill 可列出当前宿主实际发现的 skill/adapter/证据 catalog，但不得优先某个名字，也不得
  因发现某种目录结构而推导跨项目约定。

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
  seats: {
    producer: SeatSpec
    reviewers?: ReviewerSeatSpec[]
    pivoter?: SeatSpec
    finalizer?: SeatSpec
  }

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

### 4.1 固定 Seat 角色槽位

`seats` 不能是可任意命名、任意排序的步骤集合，否则会退化成隐式 DAG。Kernel 固定拥有
以下角色及执行顺序：

1. `pivoter`：仅在 MODE 消费到 pivot 指令时运行，最多一个；
2. `producer`：每轮唯一主执行座位，负责提出 Artifact proposal；
3. `reviewers`：零到三个隔离 reviewer，按声明顺序读取各自声明的 evidence whitelist；
   每个 proposal attempt 的所有 whitelist 冻结于同一时点快照，但不同 reviewer 不必读取
   相同文件；
4. Gate 失败且协议允许时，Kernel 把 messages 回传给 producer，执行有界同轮纠偏；
5. `finalizer`：仅在终止决策已经确定后运行，最多一个，失败不改变终止事实。

角色显示名、prompt、模型和工具可以配置，但角色、最大数量、顺序、重试次数与控制后果
由 Kernel 固定。Reviewer 不能共享 producer lineage；producer 是否按 round/loop 保持
lineage 仍由 SeatSpec 声明。Reviewer 执行因 API error、timeout、进程崩溃或非法输出而失败时，
Kernel 只允许原 evidence snapshot 原地重跑一次；再次失败则对应 Gate `error` 并 fail-closed，
不得把基础设施错误当作 pass，也不得触发 producer 纠偏。

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

`commit.mode: "replace"` 只是 projection 层的“最新值覆盖”语义：底层仍追加
`artifact.committed` 事件，历史版本不可删除或覆盖。

### 5.1 Artifact 到 Effect 的交接

写入工作区的代码、配置或数据是 Artifact；push remote、发起训练、部署、发邮件等是
Effect。Effect 输入只能引用已经 commit 的 Artifact：

```ts
interface ArtifactRef {
  artifactId: string
  version: number
  contentHash: string
  commitEventId: string
}
```

```json
{
  "effects": {
    "push_branch": {
      "adapter": "builtin/git-push@1",
      "input": {"fromArtifact": "code_patch"}
    }
  }
}
```

Effect submit 事件必须保存 ArtifactRef，形成 artifact→effect→outcome 的 provenance 链。
未经 Gate/commit 的 workspace diff 不得被 adapter 推送到外部系统。

## 6. State Projection 与 Reducer

长期状态由事件投影得到，不能由 seat 或插件直接覆盖。

```ts
interface Reducer<State, Event> {
  id: string
  version: string
  reduce(
    previous: Readonly<State>,
    input: Readonly<ReducerInput<Event>>
  ): State
}

interface ReducerInput<Event> {
  event: Event
  observations: Readonly<Record<string, ObservableResult>>
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

### 6.1 三态在 Reducer 与 Meter 的传播

Observable 的 `present/absent/error` 是从采集到 Route 的统一协议，不能在进入 Reducer 或
METER 阶段时退化为 `undefined`、`null` 或默认布尔值。每个 Reducer manifest 必须声明所消费
的 observable、value type，以及是否直接处理 `absent/error`；每个 binding 必须覆盖所有未被
Reducer 接受的状态：

```ts
interface ReducerObservableInput {
  observable: string
  valueType: ShapeSpec
  accepts: Array<'present' | 'absent' | 'error'>
  onAbsent?: 'skip_reduction' | 'fail_stop'
  onError?: 'skip_reduction' | 'fail_stop'
}
```

- `accepts` 包含某状态时，Reducer 收到完整 `ObservableResult`，必须穷尽分支；
- 不包含某状态时，binding 必须声明对应 `onAbsent/onError`，不得存在隐式默认；
- `skip_reduction` 表示该事件不改变此 projection，并记录诊断事件；它不是吞错；
- Reducer 抛错、返回非法状态或漏掉已声明分支，均使本轮 fail-stop；
- Charter 冻结执行输入完备性、类型兼容性和分支覆盖校验；插件 conformance test 对三态逐一
  生成样例，防止 manifest 声明接受但实现未处理。

METER 是 Kernel 在 G1 保留的兼容阶段，其本质是受限的确定性 counter reducer。长期统一为
`builtin/conditional-counter-set@1`，每个条件表达式的结果同样是三态，并显式配置
`onAbsent/onError: increment | reset | retain | fail_stop`。但这些策略只能由观测状态决定，
不得读取未声明的执行上下文。

现有 Research 的“producer 失败且 `incWhen` 因 judge observable 缺失而求值失败时
increment；producer 成功但同一 observable 缺失时 retain”不能编码为静态 `onError` 枚举。
兼容 binding 只把 AST 引用了 judge 来源 observable 的 legacy `incWhen: E` 改写为
`producer_ok == false || (E)`，并将 `onAbsent/onError` 都设为 `retain`；只引用 meter/恒
present state 的表达式保持 `E` 原样。Expr 的 `||`、`&&` 使用确定性的从左到右短路求值。
因此 producer 失败时无需读取缺失的 judge observable 就能得到 true，producer 成功时缺失
仍产生 absent/error 并 retain，同时 meter-only 条件在 producer 失败轮仍按真实结果求值。
`resetWhen` 保持原表达式并使用 `onAbsent/onError: retain`，inc 与 reset 同真仍由 inc 优先。
这会删除最后一处依赖 `!worker.ok` 的 `safeEval` 隐式 fallback。

`present` 且 `value: null` 仍是合法观测，但把该值用于任何 Expr 运算（包括与 `null` 比较）
都会产生 Expr `error`，再由使用方的 `onError` 处理；不得做 truthiness、数值强转或回退。
若业务需要区分真实空值，应直接在 Reducer 中匹配三态和值，或定义单独的布尔 observable。

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
  | { from: 'kernel'; name: 'producer_ok' }
```

Kernel source 不是可扩展命名空间。`producer_ok` 是保留且恒 present 的布尔 observable：对每个
到达 METER 的 proposal attempt，producer 返回合法成功结果时为 true；API error、timeout、
进程崩溃、非法输出或预算阻止执行时为 false。其 provenance 指向对应
`seat.completed`/`seat.blocked` 事件。Charter 不得覆盖同名 observable，插件也不能伪造
Kernel source。abort/cancel 以及没有到达 METER 的 waiting attempt 不生成 counter/objective
更新，也不生成 `producer_ok`。

Observable 使用显式三态，不用 `null` 同时表示“真实空值、没有产出、读取失败”：

```ts
type ObservableResult =
  | {
      status: 'present'
      value: number | string | boolean | null
      source: string
      observedAt: number
      provenance: string[]
      confidence?: number
    }
  | {
      status: 'absent'
      source: string
      observedAt: number
      reason: 'not_produced' | 'not_concluded' | 'pointer_missing' | 'not_applicable'
      provenance: string[]
    }
  | {
      status: 'error'
      source: string
      observedAt: number
      errorCode: string
      message: string
      provenance: string[]
    }
```

三种状态都写入本轮审计事件和 `RoundEntry.warnings` 等价的诊断投影，不能通过
`safeEval` 默认值静默吞掉。

RouteRule 和 HealthRule 必须声明缺失和错误行为：

```ts
type ObservationFailurePolicy = 'skip' | 'false' | 'fail_stop'

interface RouteRule {
  when: string
  then: RouteAction
  onAbsent: ObservationFailurePolicy
  onError?: ObservationFailurePolicy // 默认 fail_stop
}

interface HealthRule {
  when: string
  then: HealthStatus
  onAbsent: ObservationFailurePolicy
  onError?: ObservationFailurePolicy // 默认 fail_stop
}
```

- `skip`：本规则本轮不参与匹配；
- `false`：将本规则判为 false，但保留 warning；
- `fail_stop`：实例进入 attention/failed，不继续花费；
- 不允许 Kernel 为缺失 observable 猜测业务默认值。

Route 与 Health 使用相同策略，`skip/false` 仅影响当前规则，不得沿用上一轮的条件结果。

Charter 冻结时进行 obligation 静态校验：每个规则引用的 observable 必须能追溯到一个
声明了产出义务的 Artifact、Effect、Projection、Adapter 或 Reviewer output。对于
Reviewer/Judge 来源，Kernel 将所需键注入输出契约；对于 Shape/Adapter 来源，所需 pointer
必须能由输出 schema 静态解析。可选来源必须配套显式 `onAbsent`，否则冻结失败。

Route 和 Health 只能消费已经写入本轮审计事件的 Observable，不能直接读取 worker 文本。

### 7.2 多目标 Objective

```ts
interface ObjectiveSpec {
  source: string
  direction: 'max' | 'min'
  weight?: number
  hardMin?: number
  hardMax?: number
  onAbsent?: 'skip_update' | 'fail_stop' // 默认 fail_stop
  onError?: 'skip_update' | 'fail_stop'  // 默认 fail_stop
  onNull?: 'skip_update' | 'fail_stop'
}
```

```json
{
  "objectives": {
    "quality": {"source": "evaluation.score", "direction": "max", "weight": 0.6},
    "latency": {"source": "benchmark.p95_ms", "direction": "min", "hardMax": 500},
    "cost": {"source": "budget.total_usd", "direction": "min", "weight": 0.2},
    "research_metric": {
      "source": "judge.metric",
      "direction": "max",
      "onAbsent": "skip_update",
      "onNull": "skip_update"
    }
  }
}
```

Kernel 负责保存和展示 Objective，不内置具体优化算法。加权、瓶颈、Pareto 等策略由确定性
objective adapter 提供。Objective source 为 present-null 时不参与比较或 best-value 更新；
source schema 允许 null 时必须显式声明 `onNull`，`skip_update` 同样写入诊断事件。不得把
null 当作 0、无穷值或 Expr error。absent/error 则按各自策略处理。

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

```ts
interface GateBinding {
  id: string
  gate: string
  artifacts: string[]
  retryProducer: 0 | 1
  executionRetry?: 0 | 1
  feedback: 'messages' | 'generic'
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
- 每个 proposal attempt 的 whitelist 在首个 Gate 执行前解析为不可变 ArtifactRef/hash
  快照；producer 纠偏产生新 attempt 和新快照，旧快照只读保留；
- Gate verdict、证据 hash 和插件版本必须进入 Ledger。

### 8.1 同轮纠偏协议

Gate 不只是 commit 过滤器。纠偏预算按 `GateBinding` 计算，而不是整轮共用一次：

1. Gate 按冻结顺序执行；同一次 proposal 上已经执行的失败结果及 messages 先汇总；
2. 首个失败且尚有 `retryProducer: 1` 预算的 binding 触发 producer 纠偏；
3. messages 为空时生成确定性通用纠偏说明；
4. 原 proposal 保留为 `artifact.rejected` 事件但不 commit，记录触发 binding id；
5. Kernel 用同一 round、同一 producer lineage 生成新 proposal，并从第一个相关 Gate 起重新执行，
   防止新 proposal 使先前 pass 失效；
6. 每个 binding 的 producer 纠偏预算最多消费一次；已耗尽预算的 binding 再失败即 fail-closed；
7. 一轮总纠偏次数上界为声明 `retryProducer: 1` 的 binding 数，并另受 round USD、seat call
   和 wall-time 总预算约束；Charter 冻结拒绝超过 Kernel 上限的 binding 数；
8. `correctiveRetries`、各 binding 预算、Gate messages 和所有 proposal hash 均进入 Ledger。

`executionRetry` 与上述纠偏正交：它只对同一 evidence snapshot 重跑 Gate 执行，不调用
producer、不产生新 proposal，也不计入 `correctiveRetries`。`builtin/research@1` 的 judge
binding 固定 `executionRetry: 1`；第二次 API error、timeout、崩溃或非法输出后 verdict 为
`error` 并 fail-closed。这样保留现有 diversity/schema/judge 各自一次 producer 纠偏，以及
judge 崩溃原地重跑一次的兼容语义，同时仍有静态、可审计上界。

## 9. Effect Adapter

```ts
interface EffectAdapter {
  readonly id: string // 版本进入 ID，例如 vendor/task@2
  submit(context: EffectAdapterContext): Promise<EffectSubmitResult>
  inspect(context: EffectAdapterContext): Promise<EffectInspection>
  cancel(context: EffectAdapterContext): Promise<EffectCancellation>
  reconcile?(context: EffectAdapterContext): Promise<EffectInspection>
}

interface EffectAdapterContext {
  effectKey: string                 // 稳定远端幂等键
  payload?: Record<string, unknown>
  receipt?: Record<string, unknown>
  attempt: number
  deadlineAt: number
  signal: AbortSignal
}

interface EffectBinding {
  adapter: string                    // 必须含 ABI 大版本，例如 vendor/task@2
  observations: Record<string, {
    pointer: string                  // 指向 {state, verdict?, data?} 的安全 JSON Pointer
    type: 'number' | 'string' | 'boolean'
  }>
  rules: Array<{
    when: string
    then:
      | {act: 'harvest'; verdict: string}
      | {act: 'cancel_and_harvest'; verdict: string}
      | {act: 'continue_waiting'}
      | {act: 'escalate'; reason: string}
    onAbsent: 'continue_waiting' | 'escalate' | 'fail_stop'
    onError: 'escalate' | 'fail_stop'
  }>
  admission?: {maxConcurrentCalls: number; minIntervalMs?: number}
}
```

Charter 示例：

```json
{
  "effects": {
    "experiment": {
      "adapter": "vendor/task@2",
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
- submit intent 和 pending round 必须在跨越 adapter 边界前持久化；ack 丢失时以同一
  `effectKey` 先 reconcile，禁止生成第二个逻辑远端任务；
- submit/inspect/cancel/reconcile 均有 deadline、单调用 timeout、有界指数 retry 和审计；
- event 是低延迟路径，inspect/poll 是事件丢失时的确定性保底；
- 首个 terminal verdict 胜出，后续 verdict 保留为重复事件但没有控制效果；
- adapter 不得直接调度 round 或写 Ledger；
- 无法确认取消时实例 fail-stop，禁止旧任务与重放任务并存。

当前首版实现为宿主进程内的受信任 ABI：registry 拒绝重复/未知 ID，adapter 必须服从
`AbortSignal`。它尚不是第三方插件安全边界；忽略 abort 的恶意同步/异步代码无法由同进程
强制杀死。第三方 adapter 只能在 G4 JSON-RPC 子进程隔离、输出上限和进程组 kill 落地后开放。

### 9.1 与现有 worker-driven wait 的关系

引入 `inspect/reconcile` 是对 2026-07-13 F12“退役通用 probe、等待归 worker”的**部分
回退**，但不恢复旧的任意 ProbeAdapters 机制。两条等待路径并存且边界固定：

- `self_timer`：没有 EffectAdapter，唤醒后由 producer 做语义性判断；适合研究平台期、
  reward hacking、阶段切换等无法由机械阈值可靠判断的任务；
- `effect_wait`：有 EffectAdapter；event 提供低延迟完成通知，adapter inspect 只负责
  硬状态与事件丢失保底；
- event、inspect、timeout 同时到达时，全部通过同一个 EffectLedger 原子状态转换，首个
  terminal conclude 胜出；后到结果只记 duplicate observation，不再调度 harvest；
- effect timeout 的确定性升级语义继续保留，inspect 不能无限延长总 deadline。

### 9.2 Effect Rule 的标识符与能力边界

Effect Rule 复用受限 Expr DSL，但标识符宇宙来自 adapter 的版本化 observation schema：

```ts
interface EffectBinding {
  adapter: string
  observations: Record<string, { pointer: string; type: 'number' | 'string' | 'boolean' }>
  rules: Array<{
    when: string
    then: 'harvest' | 'cancel_and_harvest' | 'escalate' | 'continue_waiting'
    onAbsent: 'continue_waiting' | 'escalate' | 'fail_stop'
  }>
}
```

冻结时解析表达式并拒绝未声明标识符、类型不匹配和悬空 pointer。Rules 只用于硬边界：

- terminal status；
- timeout/SLA；
- 余额或配额耗尽；
- 明确的失败码；
- 最大重试次数；
- 可证明安全的数值上下限。

研究方向是否有效、训练是否出现 reward hacking、是否应改变假设等语义判断不得塞入
Effect Rule，继续由 self-timer 唤醒后的 producer/reviewer 完成。

首版已实现：EffectBinding ID、adapter 版本、observations、rule AST 与 admission 一并冻结；worker
只能提交 `effectBinding` ID，不能自行选择 raw adapter。inspection/reconcile 返回值被视为
`{state, verdict?, data?}`，经安全 JSON Pointer、严格有限数值/字符串/布尔类型解码后按声明顺序
first-match。每次规则判定连同 binding ID、rule index、typed observations、action 和 diagnostic
写入 EffectLedger。`harvest` 与 `cancel_and_harvest` 进入统一 conclude CAS，后者只有取消确认才
harvest；`escalate` 直接形成 audited terminal round、attention report 与 paused_attention，
`fail_stop` 保留 pending/effect 供人工对账。

Adapter registry 同时提供宿主进程内 FIFO admission：adapter 自身 safety ceiling 与 Charter binding
上限取更严格值，限制并发调用和 start-to-start 间隔，排队可由 AbortSignal 中止且计入单调用
deadline。由于每个 workspace 已由单 daemon lease 排他，这覆盖单 workspace 多 Loop 并发；跨
workspace/跨集群的全局 provider quota 仍必须由 G5 分布式 admission service 完成，不能把进程内
semaphore 误称为全局配额。

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
  credentials?: Array<{
    name: string
    pool: string
    rotateOn?: string[]
    maxRotations?: number
  }>
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

### 10.1 凭据代理

Charter、冻结快照、prompt、Artifact、Event Ledger 和插件输入日志中都不得出现凭据本体。
Runtime 提供 SecretBroker：

```ts
interface SecretBroker {
  lease(request: { pool: string; pluginId: string; effectKey?: string }): Promise<CredentialHandle>
  rotate(handle: CredentialHandle, reasonCode: string): Promise<CredentialHandle>
  revoke(handle: CredentialHandle): Promise<void>
}
```

- 插件只得到进程内短期 handle/环境注入，不得到可持久化的池实现细节；
- manifest 声明允许使用的 pool 和允许触发轮换的标准错误码；
- 轮换次数有上限，耗尽后 escalate/fail-stop；
- stdout/stderr、异常、trace 和审计 payload 统一做 secret redaction；
- Ledger 只记录 credential lease ID、pool 名、轮换原因和结果，不记录 secret；
- 插件退出、取消或超时后 Runtime 必须撤销 lease 并清理环境。

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

### 11.1 Distiller 降级为模板参数化

GenericCharter 的插件绑定、pointer、ShapeSpec、obligation 和权限关系不能依赖 LLM 从零
生成。Distiller 的职责收缩为：

1. 从已安装且兼容的 Scenario Pack 中选择场景；
2. 提取模板允许的参数，如 goal、rubric、阈值、预算、write roots 和 adapter 参数；
3. 生成面向人工的 TaskSpec；
4. 调用 Scenario Pack 的确定性模板渲染器生成 Charter；
5. 运行完整 Charter/ABI/obligation/permission 校验；
6. 校验失败时只允许修正模板参数，不允许自由改写绑定结构。

```ts
interface ScenarioTemplate {
  scenario: string
  version: string
  parameterShape: ShapeSpec
  render(parameters: unknown): GenericCharter
}
```

自由文本只进入 goal、seat domain prompt、review rubric 等明确字段。Plugin ID、版本、
Artifact/Gate 连接、Observable pointer、Reducer 和 Effect 状态机由模板固定。高级用户可
手写 Charter，但仍必须通过相同冻结校验，不能借 Distiller 绕过。

## 12. Research Loop 兼容迁移

当前研究语义迁移到 `builtin/research@1`：

| 当前硬编码 | 泛化后 |
|---|---|
| `findings_draft.json` | `finding` Artifact draft |
| `findings.jsonl` | `findings` Artifact stream |
| `direction.json` | `direction` Artifact draft |
| `directions.json` | `research_state` projection |
| `bestMetric` / nullable judge metric | `onNull: skip_update` 的单一 Objective projection，并记录诊断 |
| producer 本轮成败 | 保留的 Kernel observable `producer_ok`，恒 present 且不可被插件覆盖 |
| `meters`（`incWhen/resetWhen` DSL） | `research_meters` projection + `builtin/conditional-counter-set@1`；仅引用 judge observable 的 `incWhen` 改写为 `producer_ok == false || (legacyExpr)`，meter-only 表达式保持原样，缺失/错误 retain；各 counter 导出同名 state observable |
| diversity check | `direction-diversity` Gate |
| 同轮纠偏与 `correctiveRetries` | GateBinding retryProducer 协议 |
| judge crash 原地重跑一次 | judge GateBinding `executionRetry: 1`；再次失败为 error/fail-closed |
| self_timer pending round | Kernel 原生 wait state，跨场景保持兼容 |
| escalate/re-arm/resetMeters | Kernel attention/ack policy |
| JUDGE_CONTRACT 注入 observable 键 | Reviewer output obligation 注入 |
| `RoundEntry.warnings` | Observable absent/error 诊断 projection |
| CapsuleBuilder 研究字段 | research capsule view |
| final report 研究模板 | research report view |

兼容策略：

1. 当前 Charter schema 继续可读；
2. load 时映射到等价的内置 Research scenario binding；
3. 既有实例不就地改写冻结快照；
4. 显式 `loop migrate` 才生成新 schema/version；
5. 迁移前后对同一历史 Ledger 做 projection parity 测试；
6. 至少保留一个大版本的只读旧 Ledger 支持。

### 12.1 项目特例兼容性金样本（非通用约定）

把 `agibot_x1_train_oma/.loop/x1-walking-control-v1` 的脱敏副本纳入迁移 fixture，覆盖：

- legacy observable 键及 `results_improved` 缺失事故；
- 富结构 findings；
- stale_count、连续 pivot 和 warnings；
- 已试方向禁重复；
- 训练 Effect 与分支 push provenance；
- 正停泊于 self_timer 的 pending round；
- attention/migrate ack/resetMeters。

这里的项目名、`.loop` 路径、训练平台和状态布局仅是旧实例 fixture 的输入。Kernel 不识别
其中任何名称，其他项目也不需要创建同名目录；该 fixture 与任意其他旧实例走完全相同的
Charter/Scenario/Effect/Artifact ABI。

验收必须从 waiting 快照原地加载：不改写旧冻结 Charter，恢复同一个 pending round，保持
round number、已花成本、lineage、timer deadline 和已有 Ledger 前缀段 hash；恢复后允许且
必须追加新事件，已有 sequence/event 不得重写。完成收割或再次停泊后再显式迁移。只验证
“旧 done 实例能 inspect”不算兼容。

## 13. Event Ledger 与 Projection

### 13.1 从 rounds.jsonl + postState 演进

Event Ledger 不另起新存储体系。当前 `rounds.jsonl` 是 round commit 事件的雏形，
`RoundEntry.postState` 已使 `progress.json` 成为可重建缓存。演进顺序：

1. 为现有 RoundEntry 增加稳定 eventId/sequence/schemaVersion；
2. 将 postState 明确为 `round.committed` 的 projection checkpoint；
3. 把 seat/effect/gate/artifact 等中间事实逐步迁入统一事件 envelope；
4. 双读校验新 projection 与现有 progress/postState 一致；
5. parity 稳定后才切换新 projector 为权威实现。

不得在 G1 直接复制一套新 Ledger 并让两套权威并存。

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
round.aborted
seat.started
seat.completed
seat.blocked
artifact.proposed
gate.completed
artifact.committed
effect.submitted
effect.observed
effect.concluded
state.projected
route.decided
budget.reserved
budget.settled
budget.exhausted
round.committed
human.feedback
loop.terminated
```

`progress.json`、Capsule、inspect 输出和报告都是可重建 projection。

`round.aborted` 必须保留 attemptId、taskId、已确认成本、取消是否 terminal 和 wake
disposition；现有 `abortedCostUsd` 作为其兼容 projection。预算事件必须能重建 round 与
lifetime spend，不能只保留最终总数。

### 13.2 分段与快照

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

### G0 — 泛化契约冻结（G1 阻断）

实施迁移说明：legacy Charter 未声明策略时，为保持既有业务语义 parity，Tripwire/Health 在
冻结或内存加载时显式补为 `false`，Objective 补为 `skip_update`；新 GenericCharter 契约仍按
§7 要求显式声明。迁移期 RoundEntry 双写权威 `observationResults` 与兼容标量 `observables`，
旧 Ledger 没有三态字段时继续可读。

在迁移任何研究硬编码前先完成：

- Observable present/absent/error 三态；
- RouteRule `onAbsent/onError`；
- Reducer/Meter 三态输入、Expr null/error 与穷尽分支协议；
- 保留的 `producer_ok` Kernel observable 与 legacy counter 改写规则；
- HealthRule 与 Objective 的 absent/error/null 策略；
- observable source obligation 静态校验；
- producer/reviewer/pivoter/finalizer 固定角色槽位；
- GateBinding per-binding 纠偏与 execution retry 分离协议；
- 冻结 ScenarioTemplate 接口、参数边界与渲染结果校验规则，不实现渲染器；
- rounds.jsonl/postState 到 LoopEvent 的演进映射；
- Research 行为与 X1 waiting 金样本基线。

验收：对 Route、Health、Reducer、Meter 和 Objective 分别注入 present、present-null、
absent、error，必须按声明得到确定结果且审计完整；静态校验必须拒绝未穷尽分支。验证
producer 失败且 judge observable 缺失时 legacy counter increment、producer 成功且同样缺失时
retain，并验证纯 meter 条件在 producer 失败轮不被强制 increment；不得出现 meter 静默冻结、
隐式 `safeEval` fallback 或连续错误 pivot。

### G1 — 去研究硬编码

当前实施状态：首个 Research 迁移切片已完成。`ledger/artifacts.jsonl` 记录 baseline、proposal、
Gate result 与 transaction decision；同一 `round:<n>` 提交幂等且 required Gate fail-closed。
旧 `findings.jsonl`/`directions.json` 首次建立 baseline，之后降为可从 Artifact authority 重建的
兼容 projection。Kernel 不再解析、写入或报告 finding/direction，Research 输出契约和
presentation 也已移入场景包。后续 Registry/GenericCharter 切片亦已完成：新实例的 frozen
Charter 显式保存 `scenario/artifacts/gateBindings`，旧实例加载时确定性补为 Research；Registry
已同时注册 Research 与无研究语义的 Generic runtime，并由同一 Kernel 完成端到端验证。

- 引入 Artifact stream；
- 实现 ScenarioTemplate 确定性渲染器与参数化 Distiller；
- findings/directions 迁入 `builtin/research@1`；
- bestMetric 映射为 Objective；
- Capsule 和报告变成 scenario view；
- 保持当前业务行为和旧字段的 projection parity；允许追加版本化三态/诊断字段。

验收：现有 Research Loop 测试在兼容层和新场景包上产生相同 route、meter、findings、
best metric、纠偏次数、业务 warnings、timer/attention 生命周期和报告关键信息；允许新增
`observationResults` 和明确标记为 compatibility diagnostic 的 warnings，但旧 warning 不得
丢失或改义。覆盖同轮依次
发生 diversity、schema、judge 失败且各纠偏一次，以及 judge 崩溃一次重跑、再次崩溃
fail-closed；X1 waiting 金样本能原地恢复同一 pending round。

### G2 — 通用状态演进

当前实施状态：Artifact 执行链首版已完成。通用 executor 不理解 finding/direction，只有 terminal
transaction event 授予 commit 权威；悬空 proposal/Gate event 在 replay 时被忽略。Generic
Scenario 已验证非 Research JSON Artifact 的提案、纠偏、提交、草稿清理与报告，且不会污染
legacy `totalFindings` projection。typed projection binding、v3 snapshot/checkpoint、日志分段和派生索引亦已完成：
Generic Scenario 的 reconcile、commit、report 均读取 checkpoint，2,000 事务性能测试验证首次
replay 后无变化读取为 0 字节，单事务增量远小于历史日志，window checkpoint 大小保持有界。
活动 `artifacts.jsonl` 只有在 checkpoint 原子落盘后才会 rename 封段；manifest 原子更新前崩溃
留下的连续 orphan segment 可恢复，已声明 segment 的长度/hash/previousHash/sequence 不一致则
fail-stop。Research 的 `findings.jsonl/directions.json` 仍作为大版本兼容投影保留，但正常提交已
通过 `research.projection.json` watermark 增量追加 finding 并原子更新 direction，不再每轮重写
完整 finding 历史；兼容文件缺失、watermark 不一致或显式 reconcile 时，从分段 authority 校验后
全量重建。该 watermark 以文件尺寸提供热路径一致性检查，同尺寸 bit-rot 由显式 reconcile/全量
校验发现，不能把兼容投影误当 authority。

通用幂等不再只比较 `lastTransactionId`：每个 terminal transaction 建立 SHA-256 分片原子索引，
Generic 与 Research 都可 O(1) 找回任意旧事务的原始 decision；authority commit 后、索引写前
崩溃时，由 checkpoint replay 先补索引再推进 watermark。checkpoint 的 `streamStates` 为 append、
replace、versioned 分别记录 logical/committed count，replace/current 与 versioned/latest 只保存
不含 content 的 proposal reference；versioned content hash 的精确去重集合落在磁盘分片索引，
恢复时允许全量重建，热路径内存不随历史增长。Artifact manifest v2 的 mutable root 只保存不足
64 个 open segment，完整批次封入带 previous-page hash 的不可变 page；root 带自身 state hash，
从而避免每次封段重写线性增长的 segment 数组。

G2 的多场景验收现已补齐：Registry 新增 `builtin/release@1` 与
`builtin/compliance@1`，二者都复用 Generic Artifact executor/runtime factory，Kernel 没有
release/compliance 业务分支。Release 冻结 replace `release_manifest` 与 versioned
`release_note`；Compliance 冻结 versioned `compliance_bundle` 以及 `human_approval` Gate。
Human Gate 复用已有 event EffectLedger：worker 只声明等待，Scenario runtime 根据当前草稿
content hash 生成确定性 effect key 与审批 payload；harvest 时同时校验请求 hash、first-wins
审批 outcome 和当前草稿 hash，防止“审批 A、提交 B”。审批已 concluded 但 harvest wake 丢失时，
通用 reconcile 会重建 wake 并恢复同一 round；错误 hash、拒绝、重复/乱序审批均 fail-closed。
Human Gate 的公开入口现为宿主侧 `writeAuthenticatedEffectEvent`：HMAC envelope 绑定
`principal`、`roles`、effectKey、verdict、内容 hash、nonce、issuedAt 和 expiresAt；Compliance
强制要求 `approver` role。实例签名密钥存放于 `META_AGENT_HOME/loop/event-auth`（0600），不在
worker 可读的 `.loop` 工作区。无签名、签名错误、过期或身份角色不足均 fail-closed 并隔离为
`.unauthorized`。这是受信任宿主 signer 的身份断言；企业 IdP、逐主体密钥和轮换属于后续
SecretBroker，不把共享 HMAC 文件误称为最终生产身份系统。

- typed projection；
- pure reducer；
- 将已落地的 artifact proposal/gate/commit 内核协议绑定到 GenericCharter；（已完成首版）
- projector snapshot；
- replay 与 crash-injection 测试。

验收：已用 release、compliance 两个非研究场景证明 Kernel 无需新增业务分支；Compliance
同时覆盖 human approval、first-wins、hash binding 和丢失 harvest wake 恢复。

### G3 — 确定性外部系统

当前单 workspace 的收敛闭环、宿主接入约束和示例验收矩阵见
[`loop-single-workspace-closure.md`](./loop-single-workspace-closure.md)。后续扩展不得改变该文档
冻结的 effectKey、first-wins、Rule terminal 和 fail-stop 语义。

当前实施状态：EffectAdapter ABI 与 typed Effect Rule 首版已完成。宿主可注入多 adapter registry；Kernel 按
`pending round → durable submit intent → adapter call → ack` 顺序跨越边界，ambiguous dispatch
优先 reconcile。EffectLedger 覆盖 dispatching/submitted/probing/retry_wait/cancelling 和 terminal
状态，event 与 poll 共用单一 conclude CAS；`effect_poll` 只推进 adapter，不在 pending 状态启动
LLM seat。deadline、单调用 abort timeout、有界 retry、cancel、lost-wake reconcile、daemon/CLI
registry 透传及带身份认证的 Human Gate 入口已落地。EffectBinding/typed observations/静态 AST
校验、规则动作审计和宿主 adapter FIFO admission 亦已落地。尚未完成跨集群全局 admission、
SecretBroker/企业 IdP，以及 G4 的不受信第三方子进程隔离。

- EffectAdapter ABI；（宿主内受信任首版已完成）
- inspect/cancel/reconcile；（已完成）
- event + poll 双通道；（已完成）
- deadline、retry、SLA 和 adapter 限流；（deadline/retry 与宿主限流已完成，全局限流待 G5）
- observation schema、Effect Rule 标识符静态校验；（已完成）
- SecretBroker、credential pool 与有界轮换；
- self_timer 与 event+inspect 双路径 first-wins 裁决。（已完成）

验收：外部事件丢失、重复、乱序、adapter timeout、取消不确认和 daemon kill -9 均有
确定性结果。

### G4 — 插件与场景包

- plugin manifest；
- JSON-RPC 子进程；
- 权限与 ABI 校验；
- 外部可安装 Scenario registry（内置多 Scenario registry 已完成）；
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

1. 先完成 G0：端到端三态协议、固定 Seat、Gate 双重重试预算、ScenarioTemplate 契约与 X1 基线；
2. 定义 `LoopEvent / ArtifactSpec / ProjectionSpec / Reducer`，不要先写插件加载器；
3. 实现确定性模板渲染器，将现有 Research 行为迁入内置 scenario，建立兼容基线；
4. 用 release 场景验证非 finding 型 artifact；
5. 用 compliance 场景验证 human gate 和不可变审计；
6. 再开放 EffectAdapter、双通道 wait 与 SecretBroker；
7. ABI 稳定后才允许第三方插件；
8. 最后切换 Round 子进程与生产级 admission control。

每一阶段都要求旧测试全绿、事件重放一致、迁移可逆或 fail-stop，不允许通过隐式降级维持
表面兼容。

## 17. 完成定义

结构泛化完成至少满足：

- Kernel 源码中不再出现 finding、direction、training 等场景业务分支；
- Observable 三态贯穿 Reducer、Meter、Health、Objective 和 Route；缺失、错误或 present-null
  不会经默认值静默冻结 meter，每个消费方都有可审计且穷尽的处理语义；
- `producer_ok` 是唯一表达 producer 成败的 counter 输入，legacy 条件不再读取隐式 worker
  上下文；Health 和 Objective 对 absent/error/null 也有冻结且可审计的策略；
- Seat 只有固定角色槽位，Charter 不能配置任意执行图；
- Gate producer 纠偏按 binding 最多一次、执行重跑独立有界，proposal/rejection/retry 全部可审计；
- Distiller 只做已验证 ScenarioTemplate 的参数填充；
- 两个新场景只通过 Charter/Scenario/Plugin 完成，无需修改 Kernel；
- 所有 projection 可由 Event Ledger 重建；
- 所有外部 Effect 可对账、取消、超时和幂等收割；
- 第三方插件崩溃、超时、无限输出、越权和遗留进程都有结构性防护；
- 当前 Research Loop 可显式迁移且语义一致，X1 waiting 金样本可原地恢复；
- 月级历史下 hot-path 读取与近期窗口/活跃 effect 数相关；
- 多 Loop 并发、daemon 重启和 kill-point chaos 测试通过。

达到以上条件后，Loop 才能从“可靠的研究型长周期运行时”升级为“通用的长周期自主研发
与运营内核”。
