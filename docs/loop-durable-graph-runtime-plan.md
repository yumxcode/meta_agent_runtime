# Durable Graph Loop v2

`durable-graph-v2` 是 Meta-Agent 唯一的长周期 Loop 执行模型。设计目标是让 Kernel 可靠执行 Distill 生成的受约束图，同时把开放领域工作保留给 Agent。

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
```

Runtime 只有三个核心面：

- Control：Node、Transition、`$state`、Reducer、timer/event、边界和终态。
- Lane：连续会话、串行化、Agent profile 和 Workspace 所有权。
- Workspace：用户真实文件。Agent 直接读写；它不是 Kernel State 的镜像。

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
- `terminal`：`done | failed | paused`。

按需扩展：

- `function`：只调用已注册纯函数。
- `effect`：只调用已注册且可幂等恢复的外部操作。
- `join`：显式并发汇合。

默认从“一条 Lane、一个厚 Agent、done/failed”开始。自然语言步骤不是拆节点的理由；确定性提交、权限/并发边界、Kernel 等待、失败隔离和终态才是节点边界。

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

Transition `when` 由程序计算，读取更新前 State；State 只通过注册 Reducer 在 commit 中修改。条件路由必须有唯一 priority 和恰好一条 default。所有非终态 outcome 必须覆盖，循环还必须有业务终态与 `limits.maxActivations` 保险丝。

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

这些边界保持 Kernel 通用且可部署，同时让 Distill 和用户通过 Tool、Skill、Capability Pack 与项目治理补充领域能力。
