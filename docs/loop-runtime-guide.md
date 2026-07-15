# 通用长周期 Loop 机制与使用指南

> Loop 当前且仅有一个执行架构：`durable-graph-v1`。自然语言在 Distill 阶段生成受约束图，Kernel 可靠执行冻结后的节点和边。领域能力通过 Capability Pack 扩展，不通过另一套 Loop Kernel 扩展。

## 1. 快速开始

```bash
# 1. 把自然语言场景编译为可审核的图
meta-agent -w /path/to/workspace loop distill requirements.md --out loop.graph.json

# 2. 人工审核节点权限、Lane、状态、路由、预算和 terminal 覆盖
meta-agent -w /path/to/workspace loop create loop.graph.json --id my-loop

# 3. 推进当前到期的 wake，直到没有立即可执行的工作
meta-agent -w /path/to/workspace loop tick --until-quiescent

# 4. 查看实例、状态、Activation、wake 与 Artifact/Evidence
meta-agent -w /path/to/workspace loop inspect my-loop
```

`distill-graph` 和 `create-graph` 暂作为同义命令保留；文档统一使用 `distill` 和 `create`。`create` 只接受 `schemaVersion: "graph-1.0"`，执行逻辑与编译后双重校验，并冻结 Function、Reducer、Effect、Context Provider 和 Capability Pack 的版本与 integrity；运行和恢复时会重算 Frozen Graph 内容 hash，再核对 capability lock，任何图内容篡改或能力漂移都会 fail closed。

Distill 使用的系统提示直接描述当前唯一的 `durable-graph-v1` ABI 和执行语义：Graph/Activation/Lane 边界、六种 Node、State/Reducer/Transition、Artifact/Evidence、timer/event/effect continuation、Join epoch、预算、retry/replay、journal 恢复和当前实际 Capability Catalog。候选图通过结构/Freeze 校验后，还由独立 LLM reviewer 对照原需求检查明确遗漏和矛盾；reviewer 被禁止规定节点数量、角色名或 Scenario 模板，因此可靠性检查不取代编译模型的领域创造性。若用户要求的确定性 Function/Effect 不在本次 Catalog 中，Distill 不得虚构能力，而应合并到受控 Agent 或在 `loop.graph.review.md` 中列为部署前缺口。

以人形机器人远端训练研究为输入的过程说明见 [x1 Loop Distill 模拟](examples/x1-loop-distill-simulation.md)，完整结构化结果见 [x1 Loop Distill 输出](examples/x1-loop.distill-output.json)。其中 `graph` 是 CLI 写入 `loop.graph.draft.json` 的内容，`taskSpec` 是 CLI 写入 `loop.graph.review.md` 的审阅说明；该示例由默认 Catalog 的真实 Validator 与 Freeze 回归校验。

运行时 conformance suite 不依赖固定 Scenario executor，而是分别用不同图验证三类组合：Research 使用 persistent Lane + 自定义 Evidence Plane + 语义退出；Release 使用幂等 Effect ledger + durable approval Event；Compliance 使用两个独立 readonly Lane + publication + Join。它们共享同一个 Kernel，测试位于 `src/loop/graph/__tests__/ScenarioConformance.test.ts`。

## 2. 执行模型

```text
自然语言 Loop 场景
  → Distill Compiler（自由生成 → 保守静态校验 → 独立语义审阅 → 错误反馈修复）
  → Logical Data Plane/View + Lane ACL
  → Freeze Compiler（逻辑 Plane → 固定物理 Backend）
  → Frozen LoopGraphSpec + Capability Lock
  → Wake Scheduler
  → Activation Scheduler
  → Node Executor
  → deterministic Transition + Reducer commit
  → Journal / State / Artifact / Evidence / Wake
```

职责边界：

- Distill 决定节点、边、Lane、变量、预算和领域能力组合；
- Distill 可定义任务专属的逻辑 `dataPlanes`、精确 `dataViews`、Lane 数据访问上限和 Node publication，但不能生成存储代码；
- Freeze 把逻辑 Plane 编译到固定的 `state | record | journal | workspace` 后端，校验 schema/trust/admission/retention/Lane ACL，并锁定最终 Provider 与 Capability integrity；
- Kernel 只执行冻结图和注册能力，不执行 Distill 生成的任意代码；
- `$state`、表达式、Function 和 Reducer 负责确定性计算，LLM 不心算控制条件；
- Graph Node 是控制语义，不是 Agent session 或 workspace 的隔离边界；
- 专用 `graph_agent` SPI 管理 Agent segment、LLM 会话和上下文压缩；当前 Meta-Agent 适配器复用 Agentic KernelLoop，Graph Kernel 不依赖具体底座。

`graph_agent` 不是用户可选择的 CLI SessionMode，而是 Graph Runtime 的可替换执行接口。当前实现 ID 为 `meta-agent/graph-agent-kernel@1`。它不启用 Auto 的 Verify/Drift/Checkpoint 编排；无人值守 workspace jail 作为部署权限策略由当前 dispatcher 适配器继承。接口、结果语义和替换约束见 [`graph_agent` 执行底座](graph-agent-executor.md)。

## 3. Node、Lane 与上下文

节点类型：

- `agent`：在 Lane 中调用 LLM，按可选 `outputSchema` 返回结构化 JSON；
- `function`：调用已注册的纯确定性 Function；
- `effect`：使用稳定 idempotency key 调用已注册 Effect Provider，并要求一个覆盖所有 poll continuation 的 `timeoutMs`；
- `wait`：等待 timer 或外部 event；
- `join`：以 `all` 或 `any` 收口并发分支；
- `terminal`：`done/failed` 结束图；`paused` 是带唯一 `resume` 路由的持久恢复点。

Lane 把“控制图节点”和“执行上下文”解耦。强相关节点放在同一 `persistent` Lane，复用稳定 lineage session；写 Lane 使用私有 `lane_overlay` 和单写者约束，不同 Lane 可以并发。只读审查节点可使用 `fresh_per_activation + readonly`，避免把生产节点与审查节点的上下文混在一起。

每个 Agent Activation 都接收 Kernel 强制的最小 `kernel_activation` section；其他信息由 Agent Node 的 Context Assembly Plan 显式声明。Runtime 不再隐式注入全局 Evidence/Artifact。每个 section 带来源、provider 版本、trust、刷新策略、解析时间、state version 和截断信息，即使底层 session 被压缩，关键快照仍可从冻结图和 journal 恢复。

```json
{
  "lanes": {
    "work": {
      "context": "persistent",
      "workspace": "lane_overlay",
      "maxConcurrency": 1,
      "dataAccess": {
        "read": [
          { "plane": "control", "views": ["current_control"] },
          { "plane": "observations", "views": ["decision_evidence"] }
        ],
        "publish": ["observations"]
      }
    }
  },
  "nodes": {
    "work": {
      "type": "agent",
      "lane": "work",
      "prompt": "完成当前工作并返回结构化结果。",
      "context": {
        "sections": [
          { "name": "control", "provider": "builtin/data-plane-view@1", "refresh": "every_segment", "config": { "view": "current_control" }, "maxBytes": 4096 },
          { "name": "evidence", "provider": "builtin/data-plane-view@1", "refresh": "activation_start", "config": { "view": "decision_evidence" }, "maxBytes": 32768 },
          { "name": "resume", "provider": "builtin/continuation@1", "refresh": "continuation_only" }
        ]
      },
      "publishes": [{ "plane": "observations", "value": { "ref": "$output" } }]
    }
  }
}
```

`activation_start` 在首段解析并写入 Activation journal，适合一次判断必须固定的 Evidence；`every_segment` 在 timer 恢复后读取最新数据；`continuation_only` 仅在恢复段注入。Context Provider 是版本化、带 integrity 的 Capability Pack 扩展点。

### 逻辑 Data Plane、精确 View 与 Lane ACL

Distill 输出的是领域无关但任务专属的逻辑数据声明。`semanticRole` 可以是任何自然语言语义，Kernel 不分支判断它；执行语义必须落到四种固定 backend：

- `state`：小型、类型化、可信的确定性控制事实；
- `record`：带 provenance、admission、retention 的 append-only/superseding Evidence 或 Artifact；
- `journal`：Kernel 因果事件的有界只读视图；
- `workspace`：显式文件输入或 State/Record/Journal 的幂等投影。

Lane 的 `dataAccess` 是访问上限，不是隐式注入。`read` 可收窄到 View，`publish` 只授权 record Plane，`write` 只授权属于该 Lane 的 workspace Plane；Node 仍需逐项声明实际 Context View 和 publication。

```json
{
  "dataPlanes": {
    "control": {
      "backend": "state",
      "semanticRole": "确定性流程控制",
      "trust": "trusted_runtime",
      "stateKeys": ["iteration", "status"]
    },
    "observations": {
      "backend": "record",
      "semanticRole": "本任务的判断依据",
      "trust": "untrusted_data",
      "recordKind": "evidence",
      "mutability": "append_only",
      "admission": "automatic",
      "retention": { "maxItems": 200 }
    },
    "observation_file": {
      "backend": "workspace",
      "semanticRole": "用户协议要求的结果文件",
      "trust": "untrusted_data",
      "binding": {
        "plane": "evidence",
        "path": "results/accepted.jsonl",
        "format": "jsonl",
        "direction": "materialize",
        "appendOnly": true,
        "projection": { "kind": "data_view", "view": "accepted", "record": "content" }
      }
    }
  },
  "dataViews": {
    "current_control": { "plane": "control", "stateKeys": ["iteration", "status"] },
    "accepted": { "plane": "observations", "statuses": ["admitted"], "maxItems": 40 }
  }
}
```

Freeze 会把上例编译为内部 `dp_*` channel/binding、`dv_*` View、`compiledLaneDataAccess` 物理 ACL，以及 `builtin/state@1`、`builtin/evidence-view@1`、`builtin/workspace-binding@1` 等物理 Provider。Distill 草图不应直接输出 `artifacts`、`evidenceViews`、`artifactViews`、`workspaceBindings`、`compiled*`、物理 `channel` 或这些物理 Provider。Capability lock 只记录编译后的实际 Provider，不锁定编译期 marker `builtin/data-plane-view@1`。

Workspace binding 的 `plane` 进一步说明文件所有权：`input`/`observability` 只 ingest；`state_projection`、`evidence`、`artifact`、`audit` 分别投影 State、Record View 或 Journal View。Kernel 在 commit 后和恢复时幂等重建 materialize 文件。除获得 `dataAccess.write` 的 Plane 外，Lane 内绑定路径会进入 Agent sandbox deny list，避免输入篡改或 Agent 与 Kernel 双写。路径拒绝绝对路径、`..`、`.loop/.git/.meta-agent` 与 symlink 逃逸。

真正新增一种物理存储执行语义不属于 Distill 权限。当前 ABI 只接受四种固定 backend；扩展必须先以受信任、版本化、带 integrity 的 Capability Pack/Runtime 发布并加载，使其成为 Freeze 可验证的目录能力，再由 Distill 引用，不能在图 JSON 中临时生成执行代码。

Lane 可用 `agentProfile.systemInstructions` 声明 Lane 内稳定角色；Agent Node 可用 `systemInstructions` 增加当前节点约束。两者被放在受保护 system prompt 的 graph-authored 区域，不能覆盖 Kernel 路由、权限和状态规则。Evidence 等数据不会被拼入 system prompt。

这三个概念不能混用：

- **Activation** 是一次逻辑节点执行。一个远端训练生命周期可以始终是同一个 Agent Activation；
- **Lane** 是跨 Activation/节点复用的执行连续性，持有 lineage session 和工作副本；
- **执行段（segment）** 是一次实际 Agent 进程调用。timer hard park 会结束当前执行段，唤醒后在同一 Activation、同一 Lane 上开始下一段。

因此，长期训练不是 `submit_agent → wait → inspect_agent` 三个互相丢上下文的 Agent Activation。只要“提交、观察、判断是否继续、最终收口”属于同一语义任务，就应由一个长生命周期 Agent Activation 完成；显式 Wait Node 只用于等待前的工作已经完整提交、恢复后确实进入另一个控制步骤的场景。

## 4. 状态、函数与确定性路由

状态变量由 GraphSpec 声明类型和初值，只能通过注册 Reducer 更新。值绑定只有三种：

```json
{ "literal": 3 }
{ "ref": "$state.retry_count" }
{ "call": "builtin/length@1", "args": [{ "ref": "$state.failures" }] }
```

边条件由受限表达式解释器执行。例如：

```json
[
  {
    "id": "high",
    "from": "worker",
    "when": "$state.level >= 8",
    "priority": 100,
    "to": "high_path"
  },
  {
    "id": "medium",
    "from": "worker",
    "when": "$state.level >= 2",
    "priority": 50,
    "to": "medium_path"
  },
  {
    "id": "fallback",
    "from": "worker",
    "default": true,
    "to": "worker"
  }
]
```

重叠条件必须用唯一 priority 指定顺序；有条件的 `from + on` 分组必须提供 default。可产生 `failure` 的 Agent/Function/Effect/Wait 节点必须显式提供 `failure` 边或 `always` 边。条件引用的可选字段不存在时按“不匹配”处理并落入 default；类型错误和非法运算仍 fail closed。

表达式禁止数组索引、三元表达式、属性原型穿透和任意函数执行；不要写 `$output.0`。若路由依赖数组内容，先用带版本与 integrity 的 Function 把数组归约为有名字的标量，再在边条件中引用该标量。

Graph 的 executable ABI 严格拒绝未知字段，避免 `maxAttempt`、`ouputSchema` 一类拼写错误被静默忽略。领域分类、解释、UI 信息和实验标签可以自由写入 Graph/Lane/Node/Transition/Data Plane 的 `annotations`；它是开放 JSON，但不产生 Kernel 执行语义。Function/Reducer/Effect 可以提供可选 input/output schema；Freeze 只拒绝 schema 能证明不可能的引用或 literal 输入，未声明 schema 的开放 Agent 结果仍允许。推荐对参与路由的少量标量使用闭合 `outputSchema`，而不是给所有探索内容强加固定结构。

## 5. Record 公共平面

逻辑 `record` Plane 贯穿整个图，物理上编译为 Artifact/Evidence record channel。它保存 `proposed`、`admitted`、`rejected`、`superseded` 状态，并记录 node、activation、Lane、state version 和时间 provenance。生产、审查、转向、汇总等任意节点都可以读取固定 snapshot，而不是依赖脆弱的自然语言 handoff。

消费方必须先声明逻辑 View，再由 Node 精确选择；Freeze 生成物理 View 与 Provider：

```json
{
  "dataPlanes": {
    "observations": {
      "backend": "record",
      "semanticRole": "可用于决策的观察",
      "trust": "untrusted_data",
      "recordKind": "evidence",
      "mutability": "append_only",
      "admission": "automatic",
      "retention": { "maxItems": 200 }
    }
  },
  "dataViews": {
    "decision_evidence": {
      "plane": "observations",
      "statuses": ["admitted"],
      "maxItems": 20
    }
  }
}
```

节点输出不会直接并发覆盖公共状态。节点先写 commit intent，Commit Coordinator 再在临界区读取最新 `$state`，校验 activation lease，选择唯一边，执行 Reducer，发布 Artifact/Evidence 并创建下游 Activation。这样 LLM 工作可以并发，权威写入保持短小、串行和可重放。

## 6. Timer、Event 与 Resume

`wait` 节点、Effect Provider 和允许 hard park 的 Agent 都可以 durable park。等待期间没有常驻 LLM 或 Node 进程；运行时只保存 Activation、continuation、Lane lineage 和 wake：

```text
Activation running
  → segment N 调用 timer(afterMs, reason, checkpoint?)
  → usage/checkpoint 落盘，Activation waiting
  → Agent 进程退出，Lane lineage 保留
  → WakeStore reaches fireAt or receives event
  → continuationVersion + 1
  → 同一 Activation 在原 Lane 启动 segment N+1
```

身份与计数语义：

- `activation.id` 在所有 park/resume 之间保持不变；
- `attempt` 只在初次 claim 或真正 retry 时增加，continuation 不消耗 retry；
- `segmentCount` 记录启动过多少个 Agent 执行段；
- `parkCount` 记录成功提交过多少次 durable park；
- `continuationVersion` 为每次 continuation 提供 fencing，旧 wake 无权提交；
- `usage` 累加所有完成或 park 的执行段，等待不能绕过费用、轮次和时长限制。

长生命周期 Agent 必须在 `persistent` Lane 中，并同时配置每段预算、整个 Activation 的生命周期预算和 timer 上限：

```json
{
  "type": "agent",
  "lane": "training",
  "prompt": "提交训练并持续观察；未结束时调用 timer，结束后输出最终结论。",
  "budget": { "turns": 20, "usd": 1, "wallTimeMs": 900000 },
  "lifetimeBudget": { "turns": 200, "usd": 10, "elapsedMs": 86400000 },
  "timerPolicy": { "allowHardPark": true, "maxDelayMs": 3600000, "maxParks": 24 }
}
```

Agent 可在 timer 调用中附带小型 JSON `checkpoint`，例如远端 job id、上次观察到的 step 和判断依据。Kernel 将它写入下一执行段的 `__continuationCheckpoint` 输入；它是显式恢复锚点，不是另一套上下文压缩。底层 session 压缩由 `graph_agent` 负责，当前适配器复用 Meta-Agent KernelLoop 的 compactor。

Kernel 在 Agent 执行期间周期性续租 Activation lease。进程崩溃或心跳丢失后，租约到期才进入 retry；正常 hard park 则是 continuation。每段 `budget` 限制单次模型进程，`lifetimeBudget` 限制同一 Activation 的所有执行段，Graph 的 `maxCostUsd` 再限制整张图。

取消与失败采用不同语义：daemon 中断导致的已确认 abort 将 Activation 无提交地放回 ready，且不消耗 retry attempt；常规 Agent/dispatcher 失败在 `maxAttempts` 内按指数退避重试；无法确认远端 Agent 已取消时，为防止同一 Lane 出现两个写者，实例会 fail-stop。已知 usage 会累计，无法确认取消时至少保留当前执行段的预算费用，restart 不能重置生命周期费用。

发送外部事件：

```bash
meta-agent loop event my-loop approval.received \
  --correlation '"change-123"' \
  --payload '{"approved":true,"reviewer":"alice"}'
meta-agent loop tick --until-quiescent
```

`correlation` 用于只恢复匹配的等待者；`payload` 成为恢复输入。continuation version、activation lease token 和 commit key 共同阻止旧 timer、重复 event 或过期 worker 二次提交。

外部 Event 先持久写入实例收件箱，再尝试匹配当前 waiter；因此事件早于 Wait Activation 到达也不会丢失，后续 park 时会消费最早匹配事件。Event Wait 可配置 `timeoutMs`；事件先到时 outcome 为 `event`，超时先到时 outcome 为 `timeout`，两者由同一个 Activation continuation first-wins 恢复。若进程恰好在 park journal 提交后、Wake 文件写入前退出，scheduler 会从 waiting Activation 的 `wakeAt` 自动重建缺失 Wake。

## 7. 最小 GraphSpec

```json
{
  "schemaVersion": "graph-1.0",
  "id": "implement-test-loop",
  "version": 1,
  "goal": "实现需求，测试通过后结束",
  "state": {
    "retry_count": {
      "type": { "type": "integer", "minimum": 0 },
      "initial": 0
    }
  },
  "lanes": {
    "development": {
      "context": "persistent",
      "workspace": "lane_overlay",
      "maxConcurrency": 1
    }
  },
  "nodes": {
    "implement": {
      "type": "agent",
      "lane": "development",
      "prompt": "实现当前输入中的需求并返回结构化摘要。",
      "writes": ["src", "tests"],
      "outputSchema": {
        "type": "object",
        "required": ["ready"],
        "properties": { "ready": { "type": "boolean" } }
      },
      "budget": { "turns": 30, "usd": 2, "wallTimeMs": 1800000 }
    },
    "done": {
      "type": "terminal",
      "status": "done",
      "result": { "ref": "$input.result" }
    },
    "failed": {
      "type": "terminal",
      "status": "failed"
    }
  },
  "transitions": [
    {
      "id": "finish",
      "from": "implement",
      "when": "$output.ready == true",
      "priority": 100,
      "to": { "node": "done", "inputs": { "result": { "ref": "$output" } } }
    },
    {
      "id": "retry",
      "from": "implement",
      "default": true,
      "updates": [{ "target": "retry_count", "reducer": "builtin/increment@1" }],
      "to": "implement"
    },
    {
      "id": "implement-failed",
      "from": "implement",
      "on": "failure",
      "to": "failed"
    }
  ],
  "entrypoints": [{ "id": "start", "node": "implement" }],
  "limits": {
    "maxActivations": 20,
    "maxWallTimeMs": 86400000,
    "maxCostUsd": 20,
    "maxFanOut": 4,
    "maxPendingTimers": 8
  },
  "concurrency": {
    "maxActivations": 4,
    "maxPerNode": 2,
    "stateConsistency": "commit_latest"
  },
  "annotations": { "scenario": "由当前任务自由定义；Kernel 不解释" }
}
```

生产图还应根据风险补充逻辑 record Plane/View、Lane dataAccess、Effect permission、timer policy、失败边和 terminal 覆盖。

## 8. Capability Pack：领域扩展机制

Research、Release、Compliance 等领域不拥有独立 Kernel。`GraphCapabilityPackV1` 当前可以提供可组合组件：

- Function / Reducer；
- Effect Provider 及权限声明；
- Context Provider 及其固定 trust 分类；
- 可选 Function/Effect input/output schema；
- 一组 advisory Distill Scenario guidance，以及有大小/数量上限的可选 Graph fragments。

Scenario guidance 只提供领域原则、约束和建议能力，不是 Graph 模板。Graph fragment 只是局部灵感，可以组合、改写或不使用，Kernel 从不直接执行 fragment；Pack 不能借此增加固定角色、固定字段或新 Kernel Node。完整 Graph preset、report renderer 和新的物理 Data Plane backend 仍需后续版本化 ABI，当前 loader 不会假装支持。

Loader 只加载 CLI 显式指定的本地可信模块，验证 allowed root 和入口文件 SHA-256。Frozen graph 锁定 `id + version + integrity`。Pack 是受信任的进程内代码，不是沙箱；更新 Pack 后，已有实例不会静默使用新实现。

```bash
meta-agent loop distill requirements.md --graph-pack ./packs/deployment.mjs
meta-agent loop create loop.graph.json --graph-pack ./packs/deployment.mjs
meta-agent loop tick --graph-pack ./packs/deployment.mjs
meta-agent loop-scheduler --graph-pack ./packs/deployment.mjs
```

扩展的原则是“给 Distill 更多受约束积木”，不是“把一个特定流程硬编码进 Scenario”。同一张图可以组合多个 Pack。

## 9. 调度、并发与单机可靠性

一次 `loop tick` 会 claim 到期 wake 并推进图；长期运行使用：

```bash
meta-agent -w /path/to/workspace loop-scheduler \
  --poll-ms 2000 \
  --idle-exit-ms 60000 \
  --max-concurrent-graphs 4
```

并发约束分层：

- daemon lock：同一 workspace 只允许一个 scheduler/tick owner；
- workspace lease：检测复制 workspace 的 identity 冲突；
- host graph-tick admission：限制同一台机器跨 workspace 的 Graph tick 数并保持公平；
- Graph activation admission：限制全图及每个节点并发；
- Lane admission：持久写 Lane 单写者；
- model-call/resource/effect admission：限制模型、共享资源与外部适配器并发。

`concurrency.stateConsistency` 有两种通用策略：

- `commit_latest`（默认）：并行计算，State/route/publication 串行按完成顺序提交；适合独立分支、交换/结合 Reducer 和需要最大吞吐的探索任务。
- `serializable`：若某个执行段计算期间 State version 变化，Kernel 将其作为 replay 重新执行且不消耗业务 retry；只适合纯 Function、只读且可重放的 Agent。它不能回滚已发生的 bash/外部副作用或 workspace 写入，因此不是默认值。

不同 `lane_overlay` 是隔离 worktree，只在最终 done/failed Terminal 合并。跨 Lane 的中间业务数据应通过 State/Record/Journal publication 或放回同一 Lane；下游 Lane 不会自动看到上游尚未 merge 的文件。

主机默认上限可用 `META_AGENT_LOOP_HOST_MAX_GRAPH_TICKS` 和 `META_AGENT_LOOP_HOST_MAX_MODEL_CALLS` 配置。`loop host-capacity` 查看实时租约，`loop schedulers` 查看活跃 workspace scheduler。

## 10. 持久化与崩溃恢复

```text
.loop/
  workspace.json
  daemon.lock
  wakes/*.json
  <instanceId>/
    instance.json
    graph/
      spec.json
      state.json
      activations/*.json
      journal/000000000001.json
      journal-sequence.json
      checkpoint.json
      commit-intents/*.json
      artifacts/*.json
      events/*.json
      lanes/*.json
```

Journal 是权威 append-only spine；state、activation、artifact、event 和 instance 是可重建 projection。sequence 计数器避免每次 append 扫描全目录，周期 checkpoint 让恢复只 fold journal tail；heartbeat 只更新带 fencing 的 Activation lease projection，不制造 journal 事件。崩溃发生在 journal 写入后、projection 写入前时，下一次 snapshot/tick 会重放。`commitKey = activationId:continuationVersion` 保证提交幂等；lease token 阻止 stale worker 覆盖新 owner；Wake claim 过期后可被回收。

当前保证是单机进程崩溃恢复，基于本地原子 rename 和文件锁；不承诺断电级 `fsync`，也不提供跨主机共享 lease backend。`lane_overlay` 需要 git workspace，否则 fail closed。

## 11. 生命周期与运维命令

```bash
meta-agent loop list
meta-agent loop inspect my-loop
meta-agent loop pause my-loop --reason "maintenance"
meta-agent loop resume my-loop
meta-agent loop lane-repair my-loop development
meta-agent loop stop my-loop --reason "operator stop"
meta-agent loop capabilities
meta-agent loop workspace-info
meta-agent loop workspace-fork
meta-agent loop schedulers
meta-agent loop host-capacity
```

- `pause` 取消 live wake，但保留可恢复状态；它在当前 tick/Activation 提交边界生效，不会强杀已经 claim 的模型调用；
- `resume` 对运维 pause 恢复原有 ready/waiting Activation；若当前来自 graph-authored paused Terminal，则通过其唯一 `on=resume` 边原子生成后续 Activation，并保证同一暂停点只恢复一次；
- `lane-repair` 重新 reconcile 并 merge 指定冲突 Lane；成功后会恢复因 Lane 冲突而 paused 的实例并安排 manual wake；
- `stop` 以 failed 终止并取消 wake；
- `workspace-fork` 用于复制 workspace 后显式生成新 identity，并重绑定实例记录；运行中的 scheduler 必须先停止。

排障顺序：先看 `loop inspect`，再检查实例的 `instance.json`、journal、activation、commit intent 和 wake。不要手工改 frozen spec、state projection 或 journal；修订流程应创建新图版本和新实例。

## 12. 可靠性边界

Freeze/Validator 会拒绝未知 executable ABI 字段、schema 能证明不存在的数据引用、不可达节点、拓扑上无法到达 done/failed 的闭合路径、歧义路由、未锁定能力、非法 Lane ACL 和超出策略的 timer/effect。它不会尝试证明任意 LLM 语义条件必然终止，也不会假装静态理解 Agent bash 的文件依赖。运行时还受 activation、wall time、cost、fan-out 和 pending timer 限额约束。

仍未提供的能力包括 quorum join、跨主机调度、断电级 durability，以及对不受信 Capability Pack 的进程隔离。Journal checkpoint 已限制恢复计算量，但 append-only 历史文件尚未做破坏性裁剪；Event 收件箱也尚未配置保留期。Effect 现在会在 submit 前持久化 intent、submit 后立即持久化 receipt，但外部服务与本地文件无法组成原子事务；极窄的 submit→receipt 崩溃窗口仍要求 Provider 真正按稳定 idempotency key 去重。需要更强保证时应先扩展 Kernel 的通用协议，而不是加入领域特例。
