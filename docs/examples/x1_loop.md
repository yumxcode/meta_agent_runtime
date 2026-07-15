目标：人形机器人行走控制开发是一个长周期自主研究任务，目标是建立可重复迭代的工作流。每轮都要围绕 task_spec.md 推进研究，产出可验证 findings，并更新标准 state 文件。

请按以下协议设计图：

1. 状态目录

任务状态放在 `{taskDir}/state/`：

- `task_spec.md`：目标、里程碑、成功标准
- `progress.json`：至少包含 iteration、status、stale_count、total_findings、updated_at
- `findings.jsonl`：append-only，记录每轮新增 findings
- `directions_tried.json`：记录已尝试方向
- `iteration_log.jsonl`：append-only，记录每轮摘要、判断和路由

日志放在 `{taskDir}/logs/`：

- `work.jsonl`
- `orchestrator.jsonl`

2. 每轮 loop

图中包含这些阶段：load_state、choose_direction、research_design_train、extract_findings、semantic_eval、reduce_progress、state_writer、route_by_status。

确定性 progress 规则：

- 0 new findings 或结果变差：stale_count + 1；
- 否则 stale_count 清零或降低；
- stale_count >= 2：status = pivot_required；
- stale_count >= 4：status = attention_required；
- 其他正常进展：status = healthy 或 stale。

state_writer append findings.jsonl、directions_tried.json、iteration_log.jsonl，并原子更新 progress.json。

3. 路由规则

- healthy：进入下一轮或完成检查；
- stale：换一个多样化方向继续；
- pivot_required：进入 structural_pivot；
- attention_required：写 attention_required 报告后停止，不要向用户提问；
- error：写错误状态和 iteration_log 后停止。

4. structural pivot

当 stale_count >= 2 时，不要只调参数，要改变结构性约束或研究框架，例如充分调研高置信度前沿论文、从相反假设出发、换数据源/证据类型、找跨领域结构相似案例、改变评估指标或环境假设。pivot 后必须更新 directions_tried.json。

5. 边界

- 所有节点要有合理 bounds，避免无限循环；
- 计划图必须有优雅退出路径，不要依赖撞上限退出。

6. 注意事项

- 训练在远端 Gradmotion 执行，建议 30 分钟看一次结果；若进入平台期，除非有明显改进倾向，请及时终止并进入 extract_findings；
- 当 Gradmotion 账号无余额时，执行 `account-pool remove <当前id>`，再执行 `account-pool get` 获取新的有额度账号。
