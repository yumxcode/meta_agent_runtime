# Durable Graph Loop v2

`durable-graph-v2` 是 Meta-Agent 唯一的长周期 Loop 执行模型。它的目标定位是**强 Agent 的持久化治理与协调内核**：Kernel 可靠执行冻结的治理合同，开放规划、搜索、工具调用、子 Agent 并行与领域判断全部保留给 Agent。它不是通用 Workflow DSL，也不通过细粒度节点分解帮助弱模型完成任务。

## 1. 最小架构

```text
Requirement
  -> Distill (Architect -> Compiler -> Reviewer)
  -> graph-2.0
  -> Validate + Freeze
  -> Kernel
       |- control State / transitions
       |- Activation journal / recovery
       |- timer / external event
       |- Lane session + write ownership
       `- graph_agent -> real project Workspace
             `- autonomous inner loop / tools / sub-agents / verification
```

Runtime 有四个治理面：

- Execution Contract：Node、Transition、`$state`、Reducer、timer/event、恢复和终态。
- Trust & Ownership：Lane 连续会话、串行化、Agent profile、Workspace 所有权、预算与能力锁。
- External I/O Contract：Effect intent/receipt、幂等键、外部 event delivery/correlation。
- Evidence & Operations：journal、timeline、可靠性画像、诊断、归档和受控 handoff。

Workspace 是用户真实文件。Agent 直接读写；它不是 Kernel State 的镜像。Graph State 只保存治理所需的小型事实，不同步模型内部计划、完整工作过程或逐工具调用。

Kernel 不理解 Research、Release、Compliance，也不预设任何领域字段或目录。Scenario guidance 只能建议设计，不能改变 Kernel 语义。

## 2. Graph ABI

源图固定为 `schemaVersion: "graph-2.0"`：

```ts
interface LoopGraphSpec {
  schemaVersion: 'graph-2.0'
  id: string
  version: number
  goal: string
  state: Record<string, StateVariableSpec>
  lanes: Record<string, ExecutionLaneSpec>
  nodes: Record<string, NodeSpec>
  transitions: TransitionSpec[]
  entrypoints: EntrypointSpec[]
  limits: LoopLimits
  concurrency?: LoopConcurrencyPolicy
  capabilityPacks?: FrozenCapabilityRef[]
  annotations?: Record<string, JsonValue>
}
```

未知可执行字段直接拒绝；领域备注只能放在 `annotations`，且不会自动注入 Agent prompt、不能单独满足 hard constraint。Freeze 生成 `capabilityLock`、`graphHash` 和 `frozenAt`，其中也锁定图实际引用的 `graph_agent` 工具名；运行时重新校验内容 hash 与能力可用性。

### Node

基础节点是：

- `agent`：开放领域工作，绑定一个 Lane。
- `wait`：Kernel timer 或命名外部 event。
- `terminal`：`done | failed | exhausted | paused`。

按需扩展：

- `function`：只调用已注册纯函数。
- `effect`：只调用已注册且可幂等恢复的外部操作。
- `join`：显式并发汇合。

默认从“一条 Lane、一个厚 Agent、done/failed”开始。自然语言步骤不是拆节点的理由；确定性提交、权限/并发边界、Kernel 等待、失败隔离和终态才是节点边界。

### 节点边界判据

只有下列任一条件成立才拆节点：

1. 需要跨进程持久等待或外部事件；
2. 即将执行不可逆 Effect，并需要独立幂等收据；
3. 需要人工或监督 Agent 审批；
4. 发生 Lane、Workspace 或 capability 所有权切换；
5. 需要独立预算、失败隔离或爆炸半径；
6. 需要把一个确定性决策写入审计；
7. 到达业务终态。

不同 prompt、角色名、第一轮/后续轮、内部计划阶段或模型预算不同本身都不是节点边界。随着模型增强，允许多个 Agent 节点收缩为一个厚 Agent；Kernel 合同不因此扩张。

## 3. Lane 与直接 Workspace

```ts
interface ExecutionLaneSpec {
  context: 'persistent' | 'fresh_per_activation'
  workspace: {
    read?: string[]
    write?: Array<{
      path: string
      mode: 'owned' | 'atomic_replace' | 'append_only'
      schema?: ShapeSpec
      description?: string
    }>
    deny?: string[]
  }
  maxConcurrency?: 1
  agentProfile?: { systemInstructions: string }
}
```

所有 Lane 都绑定项目根，不创建 worktree。Agent Node 继承 Lane 合同：

- `read` 是显式输入/依赖清单，用于 Prompt、审阅和 Operator View；它不是机密性沙箱。
- `write` 是运行时强制的可写路径上限；没有 write rule 的 Lane 只读。
- `deny` 从可写范围中剔除路径；`.loop`、`.meta-agent`、`.git` 还会被 Kernel 固定保护。
- Freeze 拒绝不同 Lane 的重叠 write path。
- `write_file` 采用同目录临时文件 + rename 的原子替换。
- `append_file` 在进程写互斥锁下追加，适用于 JSONL 和日志。

`owned` 允许在路径前缀下编辑；`atomic_replace` 和 `append_only` 同时是 Agent 工具合同与 Reviewer 的语义检查项。Shell 是用户明确授权的开放能力，Kernel 不尝试解析任意 shell 命令来证明文件操作语义。

## 4. Control 与确定性

Graph State 只保存小型控制事实，例如 iteration、retry count、status code。用户文件不复制进 State。

`ValueExpression` 只有三种形式：

```json
{"literal": 1}
{"ref": "$state.iteration"}
{"call": "builtin/identity@1", "args": [{"ref": "$output.value"}]}
```

Transition `when` 由程序计算，读取更新前 State；State 只通过注册 Reducer 在 commit 中修改。条件路由必须有唯一 priority 和恰好一条 default。所有非终态 outcome 必须覆盖。有界循环使用 `maxTotalActivations`；持续/反应式循环可省略 total，但必须设置 `maxLiveActivations`，并由业务停止事件、预算或 wall limit 管理生命周期。旧 `maxActivations` 仅为兼容字段。

## 5. 长生命周期、timer 与 event

强相关工作使用 persistent Lane 上的一个 Agent Activation。Agent 调用 timer 后：

- Kernel 持久化等待原因、deadline、checkpoint、累计 usage 和 continuation version；
- 当前物理进程段结束；
- 到时在同一 Activation 和 Lane lineage 上恢复；
- `budget` 限制单段，`lifetimeBudget` 限制完整生命周期，`timerPolicy` 限制等待次数和单次时长。

独立 `wait` Node 支持 timer 和命名 event。外部 event 支持早到 inbox、timeout first-wins，以及 `source + deliveryId` 幂等去重。

## 6. 持久化与恢复

`.loop/<instanceId>/graph/` 只包含 Runtime 自身记录：

```text
spec.json
state.json
activations/
journal/
commit-intents/
effect-intents/
events/
lanes/
checkpoint.json
```

Journal 是控制提交的权威记录；JSON 文件是可修复的 Runtime 索引。Prepared commit 可在 worker 崩溃后重放，commit key 保证同一 continuation 只提交一次。用户文件位于项目本身，由 Agent 按 Lane 合同维护，不写入实例目录。

长期实例必须区分 hot/cold/external 三层：hot 只保留当前执行和恢复需要的有界集合；cold 保存压缩审计段；external archive 按 retention 外送。完整历史若永久保留，总审计字节仍随事件数线性增长，因此只承诺热执行成本有界，不承诺本地完整历史永久有界。

## 7. Distill 对齐

Distill 三阶段共用 v2 术语：

1. Architect：读取需求和必要项目合同，输出 Constraint Ledger 与 `workspace / lanes / control` Blueprint。
2. Compiler：调用 `graph_reference` 获取精确 ABI，生成完整 Graph 和 hard-constraint traceability，并在当前 turn 内调用 `graph_validate` 到 `valid=true, frozen=true`。
3. Reviewer：重新读取原始需求，并使用包含 Agent prompt 的机械 Manifest 核验 intent、每个声明写入目标、Workspace 路径/owner、Lane ownership、控制闭环和 capability resolution。Reviewer 是准入门，不是建议阶段；发现差异必须拒绝，不能降级为 warning。语义拒绝会触发一次有界 Architect 重审，再从完整合同重新 Lower。

Validator 只做可执行不变量：ABI、路径安全、单写者、Distill/Create/Runtime Tool Catalog 一致性、工具/能力存在、hard constraint 不仅映射到 annotations、路由全覆盖、图可达、终态可达和预算。Reviewer 承担不能机械证明的语义等价性，不以固定拓扑或领域模板限制 Agent 创造性。

## 8. 可靠性边界

Kernel 保证：

- 冻结图和能力完整性；
- State/Transition 的串行原子提交；
- prepared commit 恢复与去重；
- Lane 单并发和跨 Lane write ownership；
- timer/event 的耐久等待和恢复；
- 生命周期预算和终态闭合。

Kernel 不保证：

- Agent 领域判断一定正确；
- 任意 bash 内部操作符合 append/replace 意图；
- 外部平台本身具备幂等、配额锁或高可用；
- `workspace.read` 构成机密性隔离。

补充边界：

- Effect 的 Kernel 语义是 intent 先持久化、同幂等键至少一次 submit、首个持久 receipt 权威；业务 exactly-once 必须由 provider 通过 conformance 套件证明。
- `atomic_replace/append_only` 当前对任意 bash 仍是语义合同；Reliability Profile 必须区分 cooperative 与 OS-enforced。
- 默认 JSON 持久化是 write-then-rename，面向本地 POSIX 的进程崩溃恢复；掉电级 fsync、共享存储 HA 和分布式共识不在默认承诺内。
- Kernel 保证执行协议、失败边界和可恢复性，不保证 Agent 的领域结论正确。

这些边界保持 Kernel 通用且可部署，同时让 Distill 和用户通过 Tool、Skill、Capability Pack 与项目治理补充领域能力。

## 9. Reliability Profile 与领域扩展

每个冻结图和实例应能输出机器可读的 Reliability Profile，包含：bounded/continuous、wait 活性兜底、state consistency、Effect conformance、event delivery、workspace enforcement、durability、audit retention 和 soak/chaos evidence。它是事实清单，不是一个掩盖 unknown/degraded 项的总分。

领域扩展采用 Domain Capability Pack，而不是新增 Kernel 节点。它是围绕现有 `GraphCapabilityPackV1` 的发布约定：只有 Function/Reducer/Effect 注册和 advisory scenario guidance 属于现有可执行 pack API，Ingress、模板和测试证据是同版本伴随资产，不要求扩大 Kernel pack ABI。一个领域发布包由以下内容组成：

- Agent 原始事实 output schema；
- 纯 Function/Reducer；
- Effect provider 与 conformance 证据；
- Ingress、deliveryId 和 correlation 规范；
- Lane/Workspace 模板；
- 领域场景、soak 和 chaos 夹具。

动态高基数 fan-out、ETL、爬取、批量评测和高吞吐消息处理优先交给厚 Agent 内部并行、子 Agent 系统或外部批处理平台。Graph 只记录任务提交、等待、治理决策与结果收据。

## 10. 强 Agent 时代的演进约束

- Distill 从流程规划器收缩为治理合同起草器、静态检查器和可靠性画像生成器。
- Graph 不记录模型完整计划或思维过程，只接收路由、预算、权限和审计必需的结构化事实。
- 可续期运营 quota 使用可恢复的 budget pause；不可突破的安全上限才使用不可逆 `exhausted`。
- 单实例 graphHash 与 capability lock 保持冻结。模型、prompt、Capability 或 Graph 升级采用 checkpoint/export → 显式 state migration → 新实例 → 审批 handoff，不允许运行中任意改图。
- 默认拒绝新增节点类型、第二套 DSL 和领域控制语义；任何 ABI 扩展必须先证明无法放进厚 Agent、Effect、Capability Pack 或外部执行系统。
