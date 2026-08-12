# `graph_agent` 执行底座

`graph_agent` 是 Graph Kernel 与具体 Agent runtime 之间的稳定 SPI，不是用户 SessionMode。当前适配器 ID 为 `meta-agent/graph-agent-kernel@1`，复用 Meta-Agent 的 KernelLoop、工具调用、会话续接和上下文压缩，但不启用 Auto 的第二层编排。

## 请求边界

Kernel 向 executor 传递：

- protected system prompt；
- 已计算的 Node inputs；
- Frozen Graph 中的 Node instruction 与 output schema；
- Lane Workspace 合同；
- 允许的工具和 Skill；
- 单段预算；
- persistent Lane 的 lineage session id；
- 可选 timer capability。

Agent prompt 固定分区为 node inputs、Lane Workspace contract、activation instruction、output contract 和 Kernel invariants。Node/Lane 可以追加 system instructions，但不能覆盖 Kernel 对路由、State、commit、timer 和终态的所有权。

## Workspace

Executor 始终在真实项目根运行：

- 有 write rule 时使用 `shared_write`，沙箱只开放这些路径；
- 没有 write rule 时使用 `shared_readonly`；
- `.loop`、`.meta-agent`、`.git` 和 Lane deny 路径不可写；
- 不分配、merge 或 repair worktree。

`write_file` 是原子替换原语，`append_file` 是带同路径写互斥的追加原语。Lane 的 `read` 清单用于输入说明和审阅，不作为机密读取隔离；机密隔离仍应使用项目沙箱、凭据边界或独立 workspace。

## 结果边界

执行段返回：

- `completed`：success、结构化 output、单句 summary 和 usage；
- `aborted | timed_out | lost`：供 Kernel 决定 replay/retry；
- `cancellation_unconfirmed`：Kernel fail closed；
- 可选 park intent：afterMs、reason、checkpoint。

Agent 必须用 `return_result` 提交结果。summary 是 Operator View 的阶段结束原因；timer reason 是等待原因。Executor 不决定下一节点，不修改 Kernel State，也不提交 Transition。

## 连续性

fresh Lane 每个 Activation 使用新会话。persistent Lane 使用稳定 lineage id；同一长 Activation timer park 后仍沿用该 lineage。上下文压缩属于 Agent runtime，不在 Graph Kernel 再实现一套。

## 替换要求

新的 executor 必须保持：

- 精确 allowed-tools；
- Workspace 写沙箱；
- abort 和 wall-time 边界；
- usage 归一化；
- persistent lineage；
- timer park 的单段终止语义；
- 结构化 output 与单句 summary。

只要遵守 SPI，Kernel 无需知道底座来自 agentic、远端 worker 或其他模型 runtime。
