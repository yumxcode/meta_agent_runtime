# Auto / Simple-Auto 双模式全面审核 — 2026-07-07

**审核范围**：`auto` 与 `simple_auto` 两种无人值守模式的完整链路——MODE_PROFILES 定义、SessionRouter（goal 锚定/重锚/续跑判定）、AgenticBackendFactory（gate/checkpoint/learn 装配）、PermissionPolicy（工作区监狱）、KernelLoop 的 auto 分支（stall 熔断、verify/drift 门、runtime/batch 上限）、VerifyJudge、DriftAgent、AutoCheckpointStore/Coordinator、AutoWorktreeCoordinator、AutoExperienceStore、StructuralTruncate、SubAgentBridge 的 jail 继承与 shared_readonly 强制。

**审核目标**：同 robotics/agentic 审核（见 code-review-robotics-agentic-2026-07-07.md）——无 bug、稳定、性能高、越用越好、健壮，面向短周期与长周期任务的人机协作定位。

---

## 1. 总体结论

auto 链路是全仓安全设计最重的部分，整体质量与 robotics/agentic 一致。**未发现高危 bug**。安全边界（监狱）是多层且 fail-closed 的；自监督（verify/drift/checkpoint）的独立评审设计正确且处处防「橡皮图章」。本次发现 3 个 P2（均为无人值守场景下的成本/一致性缺口，非功能错误）与若干 P3。

验证结果：`tsc` 0 错误；`src/core/auto` + `src/core/roles` 6 文件 71 用例通过；此前已跑通的 kernel（317，含 loop 全部 auto 分支测试）、modes（23）、routing/subagent/workflow（66）覆盖其余链路。

### 两模式差异（确认与设计一致）

| 机制 | auto | simple_auto |
|---|---|---|
| 工作区监狱（lockWorkspace + deniedTools + 自动批准） | ✅ | ✅ 相同 |
| stall 熔断 / 2h / 300 批次上限 / 无模型压缩兜底 | ✅ | ✅ 相同 |
| verify 完成度独立审核 | ✅ | ❌（信任模型自判，模式提示已明示） |
| drift 航向校正 + 经验沉淀 | ✅ | ❌ |
| 持久 checkpoint / --resume 续跑 | ✅ | ❌（#6 修复保证提示语不虚假承诺 resume） |
| worktree 清理策略 | preserve（可续跑合并） | safe（会话结束回收） |

差异全部由「hook 缺席 → 内核 no-op」实现，无 if-mode 分支散布，扩展性好。

---

## 2. 五维度评估

### 2.1 无 bug
逐行审读未发现逻辑错误。几处曾经的高危坑均有修复留痕并被测试锁定：重锚 goal 时 checkpoint revision 保持单调（防 drift 饿死）、run-health 计数用 latest-wins 而非 max（重锚归零不被吞）、内核 `_buildResultEvent` 报累计 usage 与 costUsd 口径一致（M3）。

### 2.2 稳定（无人值守的核心要求）
- **监狱是多层 fail-closed**：`lockWorkspace` 强制覆盖 permissions.json 的 allowOutsideWorkspace；绝对路径扫描 + 相对逃逸检查（`~`、`$HOME`、`..`、`/`、`/*`）+ 敏感命令识别；OS sandbox 无后端时直接报错而不是裸跑；deniedTools（memory_write/cron/powershell）在任何路径检查之前拒绝，并覆盖 embedder 手工注册的工具；jail 通过 `setAutonomyJail` 继承给所有子 Agent。
- **shared_readonly 是 sandbox 强制而非提示词约束**：drift/verify 审查者在活树上的 bash 被 `readonlyWorkspace + writeAllowPaths:[] + allowUnsandboxedFallback:false` 锁死；verify 优先在一次性 git 快照上取证。
- **卡死防护**：三层签名守卫 + 全错误硬熔断（5 轮）+ 无 FS 进展软提醒（12 轮）+ 重复错误签名反思（窗口 40、阈值 6），层层互补。
- **压缩永不致死**：模型压缩器熔断后，StructuralTruncate 保证无模型前向进展——不删消息不重排（协议永远合法），只渐进裁剪旧段文本。
- **checkpoint 单写者**：Coordinator 微任务合并相邻边界、原子写、失败不推进 revision；恢复路径把 run-health 计数跨 resume 携带。

### 2.3 性能
- 与 agentic 共享全部 KV 缓存优化；auto 特有的经验召回块只在 drift 写入后变化（有界频率：≥30 批次/次）。
- gate 是**结构边界触发**而非每轮触发：drift 需要「checkpoint 推进 AND ≥30 批次」双门；verify 只在模型自称完成时运行；checkpoint 写入被合并。开销设计克制。
- 编辑摘要 flash 调用 fire-and-forget，带 runGeneration 防止旧任务的摘要写进新 goal 的 checkpoint。

### 2.4 越用越好
auto 的学习闭环与 robotics 刻意不同：**机器自治写入**（无人值守没有人可审）。风险由四道闸控制——只有 drift 审查者持有 `experience_write`（主 Agent 与普通子 Agent 均无）、rubric 要求确凿 error_source（软约束+工具描述强化）、精确标题去重、容量硬上限 60 条（最旧先淘汰）。召回块「失败优先、上限 8 条、仅作参考」的措辞正确。相比 robotics 的人工审核门，这是合理的模式差异而非缺陷；但见 P3-4 的重复累积问题。

### 2.5 健壮
- 长周期：checkpoint 含 goal/done/pending/artifacts/在途子 Agent/run-health，resume 时区分「继续」与「新需求」（isAutoContinuationPrompt），新需求走完整重锚（清 todos/进度/artifacts + 硬重置 checkpoint + revision 单调保持）。
- 短周期：simple_auto 去掉全部重机制，路径干净。
- 降级：gate 失败策略三档（fail_closed / checkpoint_pause / fail_open），默认 checkpoint_pause——verify 不可用即诚实停止，不虚报成功。

---

## 3. 发现的问题

### P2-1 DriftAgent 放弃等待时不取消子 Agent，且其等待窗（20min）短于子 Agent 默认墙钟（30min）
`DriftAgent.ts:141`：`MAX_WAIT_MS = 20min`，但 spawn 时未传 `maxDurationMs`（默认 30min）。gate 超过 20min 放弃（skip）后**没有 `cancelTask`**，drift 子 Agent 最多再跑 10 分钟；叠加 `maxBudgetUsd: Infinity` 且 `internal: true` 绕过总预算闸，这段时间的花费完全不受控。对比 VerifyJudge 的等待窗刻意超出其墙钟（`maxDurationMs + 60s`），DriftAgent 是不一致的。**建议**：给 drift 子 Agent 传 `maxDurationMs`（略小于 MAX_WAIT_MS），并在 deadline/abort 分支调用 `cancelTask`。

### P2-2 verify/drift 审查者预算默认无界
两处均为 `maxBudgetUsd: Number.POSITIVE_INFINITY`，代码注释自认「pin to a concrete cap before real deployment」。verify 有环境变量兜底（`META_AGENT_VERIFY_MAX_BUDGET_USD`），drift 连环境变量都没有。无人值守模式恰恰是最需要成本上限的地方。**建议**：给出具体默认值（如 $2/次），drift 补一个对应 env 覆盖。

### P2-3 AutoCheckpointStore 读改写无文件锁，且存在两个写者
`updateAutoCheckpointWithStatus` 是无锁的 read-modify-write；写者有二：Coordinator 的 `_drain`（串行化了自己）与 `SessionRouter._reanchorAutoGoal` 的硬重置直写。当前控制流（重锚只发生在两次 submit 之间）避免了交叠，但没有任何机制强制这一点——一旦丢失更新，旧任务的 completedSteps 会经 union 复活到新 goal 的 checkpoint 里，直接误导 drift 判断。同仓的 RoboticsProjectStore 全部走 `withFileLock`，此处应对齐。**建议**：store 层加 `withFileLock`，或把重锚重置改为经 Coordinator 排队。

### P3-4 auto 经验去重过弱，容量淘汰可能挤掉高价值失败教训
去重仅对 top-20 搜索结果做**精确标题**匹配；drift 每次复述同一教训只要换个措辞就会新增条目，直到 60 条上限触发「最旧先删」——被删的可能恰是仍然有效的老失败教训，而留下的是新近重复。**建议**：淘汰时保护 failure 条目或按 (成功/低置信) 优先淘汰；去重可加 abstractPrinciple 相似度。

### P3-5 isAutoContinuationPrompt 的前缀匹配会吞掉短的新指令
`p.startsWith('继续')` 且 ≤24 字符即判为续跑——「继续，但换用 Python 重写」这类短句携带了新要求却不会重锚 goal，verify/drift 仍按旧 goal 评审。影响有限（指令本身进入上下文，只是 gate 锚点不变）。**建议**：仅当剥离标记词后剩余内容为空/纯标点时才算续跑。

### P3-6 CJK token 低估问题在 auto 影响加倍（交叉引用）
前次审核 P2-3：`chars/4` 对中文低估约 3×。auto 额外依赖该估算的地方更多——StructuralTruncate 的目标水位与 `tokenCountWithEstimation` 的阈值判断。修 TokenCount 一处即可全链路受益，无人值守模式收益最大。

### 免修清单（确认为刻意设计）
- simple_auto 无 verify 即信任模型自判——模式定位如此，提示词明确告知用户，且 stall/上限仍在。
- verify 失败时 `done:true + skipped:true` 的形状——仅在显式 fail_open 策略下生效，默认策略会诚实停机。
- auto 下全局 memory 只读（dispose 跳过 memory writer）——防无人值守污染全局记忆，正确。
- `internal: true` 让 gate 绕过队列/预算闸——防止被待审对象饿死，方向正确（P2-2 解决后风险闭合）。
- 空闲时清空 steer 队列、经验召回块进稳定提示——均有明确理由。

---

## 4. 建议优先级

1. **P2-1**（一处对齐 VerifyJudge 的等待/取消语义，消除后台烧钱窗口）。
2. **P2-2**（给两个审查者定具体默认预算——无人值守成本安全的最后缺口）。
3. **P2-3**（checkpoint 加锁，与 RoboticsProjectStore 对齐，防丢失更新）。
4. P3-6（与前份报告的 CJK 估算修复合并处理）。
5. P3-4 / P3-5 视使用反馈决定。
