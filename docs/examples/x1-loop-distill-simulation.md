# `x1_loop.md` Distill 模拟

模拟输入为同目录的 [x1_loop.md](x1_loop.md)。模拟命令：

```bash
meta-agent loop distill x1_loop.md
```

模拟 CLI 输出：

```text
LoopGraphSpec written to loop.graph.draft.json (validated, 1 attempt(s)); review then run: meta-agent loop create loop.graph.draft.json
```

完整的模型结构化响应见 [x1-loop.distill-output.json](x1-loop.distill-output.json)：

- `graph`：CLI 会写入 `loop.graph.draft.json`；
- `taskSpec`：CLI 会写入 `loop.graph.review.md`。

该模拟结果已经调用当前默认 Capability Catalog 的 `validateLoopGraph` 和 `freezeLoopGraph` 验证，不只是文档示意。

## 编译结果的关键变化

原需求列出的 `load_state → choose_direction → research_design_train → extract_findings → semantic_eval → reduce_progress → state_writer` 没有逐项翻译成七个隔离 Agent。Distill 将强相关语义阶段合并为一个 `research_cycle` Agent Node，并放入单写 `persistent + lane_overlay` 的 `research` Lane：远端训练提交、每 30 分钟观察、平台期终止和 finding 提取属于同一个长生命周期 Activation，等待通过 timer hard park/resume 完成；确定性 State 更新、publication 与文件投影由 Kernel commit 负责。

该 Lane 通过 `agentProfile.systemInstructions` 保持稳定研究身份，并用 `dataAccess` 声明对逻辑 Plane 的最大读/发布/写权限；每个 Agent Node 再用 Context Assembly Plan 的 `builtin/data-plane-view@1` 精确选择控制 View、`research_history` View、方向历史 View 和 continuation checkpoint。Evidence 快照不再由 Runtime 全局注入：研究周期与结构性调整使用 `activation_start` 固定本次判断证据，timer 恢复所需 checkpoint 使用 `continuation_only`，需要观察最新控制值的 State 使用 `every_segment`。

用户声明的 `state/` 与 `logs/` 协议由任意命名的逻辑 `workspace` Data Plane 表达，而不是写死在 Research Kernel：`task_definition` 是 ingest Input，`progress_file` 是 Kernel State projection，accepted findings 和 directions 分别来自 record View，iteration/orchestrator log 来自 Journal View，work log 是 Agent 可维护的 Observability input。Graph 不声明这些 Plane 时，Runtime 不创建、不扫描也不注入任何同名文件。

Freeze 将 `control`、`task_definition`、`research_history`、`directions`、`runtime_audit` 等逻辑 Plane 编译到固定 State/Record/Journal/Workspace backend，生成内部 `dp_*` channel/binding、`dv_*` View 和物理 Context Provider，并锁定最终 capability integrity。Kernel 执行时看不到 Research 特例，也不解释这些逻辑名字。

这些 materialize 文件不再由 Agent 双写。Agent 只返回结构化 cycle/pivot 输出；Kernel 先原子提交 State、路由和 publication，再幂等重建 workspace projection。文件丢失或进程在 commit 后退出时，下一次 open/tick 可从 Journal、State 与 Artifact Plane 重建。

确定性部分由 Kernel 接管：

- `iteration`、`stale_count`、`total_findings`、`status` 和 `updated_at` 是类型化 `$state`；
- `result_trend` 使用 `improved|unchanged|regressed`，只有 0 finding 或 regressed 才增加 stale；
- Agent 只输出 `new_findings_count`、`improved`、`goal_complete`、`cycle_error` 等命名标量；
- Transition 使用严格条件 DSL 判断；
- Reducer 在路由 commit 中原子更新 State；
- 阈值按“条件读取更新前 State”换算：旧 `stale_count >= 1` 且本轮 stale，提交 `+1` 后达到 2 并进入 pivot；旧值 `>= 3` 时提交后达到 4 并写 attention report。

默认 Catalog 没有 Gradmotion/account-pool Effect。因此模拟图没有虚构 `code`/`effect` 节点，而是让 Agent 调用用户提供的 bash/Skill。`progress.json`、findings、directions 和 audit 文件是 Kernel 权威数据的幂等 projection，不要求 Agent 文件写入与 State commit 同事务；若要新增当前四种 backend 之外的物理存储语义，必须先提供版本化 Capability Pack/Runtime 扩展，再重新 Distill 和 Freeze。
