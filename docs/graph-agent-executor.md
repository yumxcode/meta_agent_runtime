# graph_agent 执行底座

`graph_agent` 是 Durable Graph Runtime 调用 LLM 的专用执行边界。它不是 CLI 的用户会话模式，也不属于 `agentic | auto | simple_auto | campaign | robotics` 的模式选择。

```text
Durable Graph Kernel
  └─ GraphAgentExecutor SPI
       └─ MetaAgentGraphAgentExecutor（当前适配器）
            └─ MetaAgentSession
                 └─ AgenticSession / KernelLoop
```

Graph Kernel 只依赖 `GraphAgentExecutor`，不依赖 `ISubAgentDispatcher`、`SubAgentRecord` 或 Meta-Agent 的具体 Session 实现。当前适配器位于 `src/loop/graph/agent/MetaAgentGraphAgentExecutor.ts`；以后替换模型运行时、远端 Agent 服务或新的执行内核，只需实现同一 SPI。

## 职责边界

Graph Kernel 负责：

- Activation、attempt、segment、timer continuation；
- Lane admission、State、Transition、Reducer；
- Artifact/Evidence commit；
- retry、预算累计、fail-stop 和恢复。

`graph_agent` 负责：

- 执行一个物理 Agent segment；
- system/user prompt 的最终提交；
- 工具循环和上下文压缩；
- 根据 Lane lineage 恢复、持久化会话；
- 把底层结果、用量、取消状态和 timer 请求归一化返回。

`graph_agent` 不得决定下一节点，不得直接修改权威 `$state`，也不得自行把一个底层失败解释为 Graph retry 或 terminal。

## 稳定 SPI

公开接口定义在 `src/loop/graph/agent/GraphAgentExecutor.ts`：

```ts
interface GraphAgentExecutor {
  readonly id: string
  execute(request: GraphAgentExecutionRequest): Promise<GraphAgentExecutionResult>
}
```

请求是底座无关的数据：

- `prompt.system/user`：本 segment 的完整请求；
- `allowedTools`：节点允许的工具；
- `workspace`：工作目录、工作模式和写入边界；
- `continuity`：Lane lineage、workspace id、Loop instance id；
- `limits`：本 segment 的 turns/USD/wall-time 上限；
- `timer`：是否提供 hard-park 能力及延时上限；
- host model-call admission 和 AbortSignal。

结果被归一化为：

- `completed`：带 success、output、summary、error 和 usage；
- `aborted | timed_out | lost`：由 Graph Kernel决定是否安全重放；
- `cancellation_unconfirmed`：Graph Kernel 必须 fail-stop，防止同一 Lane 出现两个活写者；
- 可选 `park`：带 delay、reason 和有界 JSON checkpoint。

底层专有的 task record、轮询状态和工具对象不会穿过该边界进入 Node Executor。

## 当前 Meta-Agent 适配器

当前执行器 ID 为：

```text
meta-agent/graph-agent-kernel@1
```

它复用 `MetaAgentSession → AgenticSession → KernelLoop`，因此继续获得多轮工具调用、上下文压缩和 session resume。公共 `graph_agent` 层为它提供专用 `GRAPH_AGENT_SYSTEM_PROMPT`，适配器使用 `externalPromptAssembly=true` 原样提交，不会装载 Auto 的 Verify/Drift/Checkpoint 编排；Graph Kernel 已经承担这些控制职责。

Loop CLI 仍预热 Auto backend，以获得无人值守授权、workspace jail、工具注册和 SubAgentBridge。Auto jail 由 dispatcher 作为部署策略传给当前适配器，但 Auto 编排不是 `graph_agent` 的一部分。

## Prompt 所有权

有效 prompt 分为两层：

```text
graph_agent protected system prompt
  └─ graph_authored_system_instructions
       ├─ Lane agentProfile.systemInstructions
       └─ Agent Node systemInstructions
current segment user prompt
  ├─ agent_context
  │    ├─ kernel_activation（强制）
  │    └─ prompt_section[]（Distill 声明的 context data）
  ├─ activation_instruction
  ├─ output_contract
  └─ kernel_invariants
```

Lane 历史不重复拼进 user prompt；persistent Lane 通过 `lineageSessionId` 恢复为历史 messages。Distill GraphSpec 为 Agent Node 声明有序 Context Assembly Plan，并用 `builtin/data-plane-view@1` 精确选择逻辑 View；Freeze 再按 State/Record/Journal/Workspace backend 改写为版本化的物理 Context Provider。Workspace 文件不会被扫描或隐式注入；冻结后的 `builtin/workspace-binding@1` 只读取已编译 binding，并附带路径、plane、字节数和 SHA-256 元数据。

每个 user prompt 部分都封装为 `prompt_section`，统一携带 `name/source/trust/role/truncated/originalBytes/renderedBytes/content`；Provider 数据还带 `provider/refresh/resolvedAt/stateVersion`。数据 section 永远标记为 `context_data`；Evidence、Artifact、Input 和 continuation 标记为 `untrusted_data`，不会进入 system 指令段。

刷新策略：

- `activation_start`：首段解析后写入 Activation journal；timer、retry 或进程重启后复用同一快照；
- `every_segment`：每个物理执行段重新解析；
- `continuation_only`：首段不注入，只在 `continuationVersion > 0` 时刷新。

Runtime 不再向所有 Agent 注入全局最多 100 条 Evidence/Artifact。Distill 节点必须选择逻辑 `dataView`，且该 View 必须位于 Lane `dataAccess.read` 上限内；Kernel 最终只看到 Freeze 生成的 `builtin/state@1`、`builtin/evidence-view@1`、`builtin/artifact-view@1`、`builtin/journal-view@1` 或 `builtin/workspace-binding@1`。

## 替换执行底座

嵌入方可直接注入实现：

```ts
const graphAgent: GraphAgentExecutor = new RemoteGraphAgentExecutor(...)
await tickOnce({ projectDir, graphAgent })
```

替换实现必须保持以下语义：

1. persistent lineage 的恢复和持久化是原子的，且校验 workspace/instance scope；
2. Abort 后只有确认底层终止才能返回 `aborted`；
3. 无法确认取消必须返回 `cancellation_unconfirmed`；
4. usage 是本物理 segment 的增量，不能返回整个 lineage 的累计值；
5. timer 调用必须机械结束当前 segment；
6. 不得在执行器内部提交 Graph State、Artifact 或路由；
7. workspace 和 tool allowlist 必须 fail-closed；
8. executor `id` 应版本化，行为不兼容时升级版本。
