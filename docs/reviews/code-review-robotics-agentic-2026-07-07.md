# Robotics / Agentic 双模式全面审核 — 2026-07-07

**审核范围**：`agentic` 模式（MetaAgentSession → AgenticSession → KernelSession/KernelLoop 及 modes/ 适配层）与 `robotics` 模式（RoboticsSession 及其学习系统：Experience / Principle / PhysicalAnchor 各 Store、WorkingSet、ContextPager、QueryAnalyzer、RoboticsProjectStore 持久化、experiment_dispatch 等工具）。

**审核目标**：作为人机协作式解决问题 Agent，面向短周期与长周期任务，评估五个维度——无 bug、稳定、性能高、越用越好、健壮。

**验证手段**：全量 TypeScript 类型检查 + 分区运行测试套件。

---

## 1. 总体结论

代码质量显著高于平均水平。架构分层清晰（两模式共享同一 kernel 执行引擎，robotics 以组合而非继承叠加领域能力），历史 review 发现的问题在代码注释中有完整的修复留痕（S1/S3/S16/L5/M3/P2-2 等编号），关键不变量均有文字说明。**未发现会导致数据损坏、死锁或崩溃的高危 bug**。本次发现的问题均为 P2/P3 级：注释与实现不一致、极端场景下的防御缺口、度量口径不一致、仓库卫生问题。

验证结果：

| 检查项 | 结果 |
|---|---|
| `tsc --noEmit` 全仓类型检查 | ✅ 0 错误 |
| `src/modes` 测试 | ✅ 5 文件 / 23 用例 |
| `src/robotics` 测试 | ✅ 23 文件 / 147 用例 |
| `src/kernel` 测试 | ✅ 32 文件 / 317 用例 |
| `src/context` + `src/core/memory` + `src/core` | ✅ 17 文件 / 127 用例 |
| `src/subagent` + `src/routing` + `src/workflow` | ✅ 13 文件 / 66 用例 |
| `src/tools` + `src/infra` | ✅ 11 文件 / 69 用例 |

合计 **101 个测试文件、749 个用例全部通过**。

---

## 2. 五维度评估

### 2.1 无 bug（发现的问题清单见 §3）

核心循环（KernelLoop）对协议不变量的保护非常完整：tool_use/tool_result 配对保证（isCompleteTailUnit）、压缩后 keep-set 的 usage 字段清洗（防止压缩后误判 token 仍超限而反复压缩）、steering 消息在压缩中的存活保证、fallback 模型的 tombstone 防递归。本次逐行审读未发现逻辑错误，仅有 §3 所列的边角问题。

### 2.2 稳定

稳定性设计是这套代码的强项：

- **模型调用失败恢复**：流式错误不再直接抛出，而是注入错误上下文让模型自行决策重试（有次数上限）；空响应有独立的有界恢复路径；PromptTooLong 触发被动压缩后 continue。
- **卡死防护三层**：连续相同工具签名（含叙述文本时也计数，L5 修复）、A↔B 周期 2 振荡守卫（6 窗口 3 全周期）、auto 模式的全错误熔断 + 无文件进展软提醒 + 重复错误签名反思。
- **崩溃恢复**：robotics 心跳（30s touch）+ 3× TTL 判定僵尸会话，resume 时强制回收孤儿 worktree 并 purge 任务记录；init 半失败时 bridge 的注册回滚（#6 修复）；dispose 幂等且顺序正确（知识提取在 inner dispose 之前）。
- **并发防护**：submit 重入在 RoboticsSession / MetaAgentSession / KernelSession 三层都有守卫；文件持久化统一走 `withFileLock` + `atomicWriteJson`（load-modify-save 均在锁内）。

### 2.3 性能

- **KV 缓存友好性是贯穿性设计**：稳定 prompt 与易变上下文严格分离（稳定段进 system message 且做逐字节去重，易变段进 user 前缀），R4/R5 冻结快照只在会话启动/恢复/压缩时刻刷新——这是正确且少见的精细做法。
- **消息数组零拷贝**（S3/L3：state.messages 与 mutableMessages 共享引用，消除每 turn O(n) 复制）；keep-set 仅在真正压缩时构建（P2-2）。
- **主 Agent web_fetch 8k 预算 + research_dispatch 隔离全文阅读**，从机制上消灭了长上下文噪声放大与压缩返工循环。
- **值得注意的缺口**：`estimateMessageTokens` 与粗估计路径按 4 字符/token 估算，对中文（约 1~1.5 字符/token）**低估约 3 倍**。后果是压缩尾部预算（40k）在中文重会话中实际保留可能远超预期、压缩触发偏晚。有 PromptTooLong 被动压缩兜底所以不致命，但属于可量化的改进点（见 R-5）。

### 2.4 越用越好

学习闭环是完整且克制的（克制本身是质量——防知识库污染）：

- **三层知识**：Experience（具体案例）→ Principle（可迁移机制，识别先于生成：先 claim 已有原理做 reinforce，不命中才聚类收敛，凑够 N 条且无未决矛盾才提议，judge 默认拒绝）→ PhysicalAnchor（物理事实，被证伪时单跳传播降权依赖它的原理）。
- **人工审核门**：experience_write / anchor / principle 全部先进 pending 队列，`/experience review` 等命令人工批准后才入共享库；会话结束的 flash 抽取同样只进 pending。**没有任何自动入库路径**，符合人机协作定位。
- **检索质量随使用提升**：confidenceTier 权重 + 观察次数加成 + 矛盾惩罚（挑战过的知识自动下沉待复审）；WorkingSet 每 turn 用启发式排序 + flash 相关性双层筛选，注入上限 4 条并有 ContextPager TTL 分页，被引用的经验自动续期。
- 反向信号闭环：失败经验会对其引用的原理记 contradiction，anchor 被矛盾时传播到原理层。

### 2.5 健壮

- 短周期：QueryAnalyzer 5s 软等待 + 启发式兜底，flash 不可用时全链路（分类、经验选择、原理晋升）都有降级路径，无 API key 也能以 single 模式工作。
- 长周期：30 天 resume 窗口、会话级 R5 里程碑、压缩确定性锚（任务 ID、硬件安全限值、经验工作集、研究报告路径「只重读不重跑」）、auto 模式 checkpoint/verify/drift 三门 + 2h/300 批次上限。
- 权限：auto 越权工具显式 deny 表，sandbox 无后端且锁工作区时 fail-closed。

---

## 3. 发现的问题

按严重度排列（无 P0/P1）。

### P2-1 `RoboticsSession._classifyAgentMode` 注释与实现相反
`RoboticsSession.ts:1337` 注释写「On any error or timeout, falls back to **'multi'** (conservative: full capability)」，实现是任何错误/超时/无 flash 都停留在 **'single'**（且注释后文自己也写了 safe default 是 single）。行为本身合理（single 更安全），但注释会误导维护者。**建议**：改注释。

### P2-2 `experiment_dispatch` await_completion 轮询无自身墙钟上限
`tools/experiment_dispatch/index.ts:211`：`timeoutMs: 0` 退出 kernel 超时后，2s 轮询循环完全依赖子 Agent 侧的运行上限来终止。若 bridge 记录因任何缺陷停留在 `running`（进程内状态机 bug、事件丢失），主 turn 将无限阻塞且用户只能 interrupt。**建议**：加一个宽松的兜底墙钟（如 max_turns × 单 turn 预期时长，或固定 30min），超时返回 isError + task_id 让主 Agent 转异步轮询。

### P2-3 CJK token 估算系统性低估（约 3×）
`KernelLoop.estimateMessageTokens` 及粗估路径按 `chars/4` 估算。中文场景下压缩尾部实际 token 可达预算的 2~3 倍、压缩触发偏晚（更依赖被动压缩兜底）。**建议**：估算函数区分 CJK 字符（按 ~1.5 字符/token）与 latin（按 4），一处修改全链路受益。

### P3-1 `numTurns` 度量口径不一致
`AgenticSession.submit` 里 `state.turnCount` 按 tool_use **事件数**累加，eventAdapter 的 result 事件用它作 numTurns；而 kernel 内部 numTurns 是**工具批次数**。同一会话两个出口报不同的「轮数」。仅影响显示/统计，不影响控制流。**建议**：让 eventAdapter 直接透传 kernel 的 numTurns。

### P3-2 `toolAdapter.validateValue` 无递归深度上限
模型可构造深嵌套输入触发深递归（V8 栈上限前会先撞 JSON 解析成本，实际风险低）。**建议**：加 depth 参数（如 32 层封顶）。

### P3-3 `RoboticsProjectStore.mutate` 对缺失/损坏 state 静默 no-op
progress_note、touch 等在 state.json 损坏或超过 30 天窗口时静默丢写。心跳场景合理，但 progress_note 工具可能报成功而实际未落盘。**建议**：mutate 返回 boolean，progress_note 据此向模型报错。

### P3-4 ExperienceStore 主文件与 search-index 双写非事务
`write()` 先写主 entry 文件、再在锁内更新索引；两步之间崩溃会留下「已存在但搜不到」的经验，需手动 `rebuildIndex()` 自愈。**建议**：`_ensureIncrementalIndex` 顺带对比主目录与索引目录的 ID 差集，自动补齐。

### P3-5 仓库卫生
`src/robotics/` 下有 14 个 `.fuse_hidden*` 残留文件（不参与编译但污染目录），根目录有 `__trash_stale_auto_orch/`、`__wtest__/`、`test-debug-pipeline.mjs`。**建议**：删除并在 `.gitignore` 补 `.fuse_hidden*`。

### P3-6 微小性能点（无需立刻处理）
`KernelSession.upsertTool` 每次注册复制整个 tools 数组（注册期 O(n²)，n≈50 可忽略）；`buildR6Section` 每次失效后全量重载三 scope 锚点（低频，可忽略）。

---

## 4. 建议的改进优先级

1. **修 P2-1 注释**（1 分钟，防误导）。
2. **P2-2 兜底墙钟**（长周期任务的最后一道保险）。
3. **P2-3 CJK 感知的 token 估算**（中文为主的使用场景收益直接：压缩时机更准、尾部预算符合预期）。
4. P3-1 / P3-3 提升可观测性与诚实性（工具不应报虚假成功）。
5. P3-5 仓库清理。

## 5. 免修清单（审读过、确认为刻意设计）

- classify 失败停留 single、escalation 无回调时静默拒绝——安全默认，正确。
- ContextPager 中 sticky slot 可超预算渲染——安全事实优先于预算，正确。
- pending 队列永不自动提交、principle judge 默认拒绝——防知识库污染的核心机制。
- steering 在 idle 时被丢弃（KernelSession.submitMessage 开头清队列）——防止上一轮遗留指令污染新任务。
- 压缩 keep-set 中 assistant 消息剥离 stale usage——防止「压缩摘要再被压缩」死循环的关键，勿动。
