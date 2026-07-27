# Meta-Agent 模式代码审查（robotics / agentic / auto）

审查日期：2026-06-18 · 仅审查，不改动代码
审查范围：按「入口配置 → 工具暴露/权限 → 主循环 → sub-agent → checkpoint/compact/verify → dispose/resume」逐阶段，并区分**共用内核问题**与**模式特有问题**。

涉及的核心文件：`core/modes.ts`、`core/MetaAgentSession.ts`、`modes/AgenticSession.ts`、`robotics/RoboticsSession.ts`、`routing/SessionRouter.ts`、`kernel/loop/KernelLoop.ts`、`kernel/KernelSession.ts`、`kernel/permissions/PermissionPolicy.ts`、`subagent/SubAgentBridge.ts`、`core/auto/*`。

---

## 0. 总体判断

整体架构是健康的：

- `core/modes.ts` 是模式的**单一事实源**（`MODE_PROFILES` 穷举 Record + 编译期 `Exact<>` 断言把内核 `CompactProfile` 锁在一起），加新模式只改一处。
- 分层干净：kernel 只定义 hook（`verifyGate` / `driftGate` / `onCheckpointBoundary` / `canUseTool`），具体行为由 session 层注入，kernel 从不反向 import。
- 主循环（`KernelLoop`）的健壮性护栏齐全：steering、压缩 keep-set、重复/震荡停滞守卫、fallback 模型、流式错误恢复、max-output 恢复、auto 失速电路。
- 测试覆盖密集（大量 `__tests__`）。

下面的问题按严重度标注：**[高]** 资源/正确性，**[中]** 健壮性/边界，**[低]** 一致性/可维护性。

---

## 0.1 解决进展（2026-06-18 同日修复）

本轮已落地修复并通过全量测试（`tsc --noEmit` 干净，`vitest` 808 通过；新增 9 条回归测试）。逐条状态：

| 编号 | 问题 | 状态 | 落点 |
|---|---|---|---|
| ROBO-高 | RoboticsSession.dispose 未释放内层会话 | ✅ 已修 | `RoboticsSession.dispose()` 末尾、知识抽取后调用 `this.inner.dispose()` |
| ROBO-中 | 同进程二次 resume 时 bridge 构造抛错 | ✅ 已修 | bridge 改在 `init()` 创建，先 `await getBridge(id)?.dispose()` 再 new；dispose 内 `this.bridge?.` 加可选链 |
| 1.5 / ROBO-低 | getStatus 读带写副作用且会抛 | ✅ 已修 | `SubAgentBridge.getStatus()` 改为纯读：缺 coordinator 跳过、finalize best-effort |
| 1.1 | 非 auto 模式 bash 相对/家目录逃逸漏拦 | ✅ 已修 | `findBashRelativeEscape` 对所有 jail-active bash/powershell 生效；`allowOutsideWorkspace` 为逃生口 |
| 1.2 | verify/drift 安全门被研究 sub-agent 预算/并发饿死 + 静默 fail-open | ✅ 已修 | 新增 `SubAgentConfig.internal` 侧道（绕过预算/队列上限+队首优先）；verdict 加 `skipped`，主循环对跳过发 `system_message` 警告 |
| 1.3 | JudgeSnapshot git 探测不一致致隔离降级 | ✅ 已修 | `isGitRepo` 改用 `git rev-parse --is-inside-work-tree`（子目录/worktree/submodule 正确识别） |
| AUTO-中 | isolated_write 失败重试泄漏旧 worktree | ✅ 已修 | `_maybeRetryFailed` 重试前 `discard` 旧 worktree |
| AUTO-中 | verify judge 快照失败时仍可写活动树 | ✅ 已修 | 无快照（活动树）路径下 judge 去掉 `bash`，仅 `read_file/grep/glob` |
| 1.4 | 三层 `_submitInFlight` 冗余 | ⏸ 评估后保留 | 三层各守不同可变状态（prompt 装配 / 消息历史），收敛收益 [低] 而风险更高，不改 |
| AUTO-低 | verify 同步阻塞等 judge | ⏸ 已缓解 | 1.2 的 internal 侧道给 judge 队首优先；同步 await 是完成门的固有语义，保留 |

下文第 1/3/4 节为修复前的原始分析，保留作为背景；具体落点见上表与各源码注释。

---

## 1. 共用内核问题（跨模式）

### 1.1 [中] ✅ 已修 — bash 工作区边界在非 auto 模式下对相对路径/家目录是「漏的」
`PermissionPolicy.findWorkspaceViolation` 对 bash 只扫描**绝对路径**。捕获 `~` / `$HOME` / 前导 `../` / 裸 `/`、`/*` 的 `findBashRelativeEscape` **仅在 `autonomy.lockWorkspace`（即 auto 模式）下运行**（KernelLoop 调用点 + PermissionPolicy 第 352 行的 `if (autonomy?.lockWorkspace …)`）。

后果：agentic / robotics 模式下 `bash cat ~/.ssh/id_rsa`、`cd ../../ && …` 不会被工作区守卫拦截。真正的边界落在 OS sandbox 上——但 agentic/robotics 默认 `allowUnsandboxedFallback:true`（只有 auto 在 `MetaAgentSession._getOrCreateSandboxHandle` 里强制 false）。所以在缺少 bwrap/sandbox-exec 的机器上，agentic 的 bash 既无路径守卫也无沙箱。
这可能是有意的「agentic 不做硬隔离」，但建议在文档里明确，或把相对/家目录逃逸检测也加到非 auto 路径（即便只是警告）。

### 1.2 [中] ✅ 已修 — verify / drift 安全门与研究 sub-agent 抢占同一预算与并发池
auto 的 `verifyGate`/`driftGate` 实现（`VerifyJudge`/`DriftAgent`）通过 `lazyDispatcher → this._autoBridge` **以 sub-agent 形式**运行。而 auto 的 bridge 用 `conservativeAutoDefaults`：`maxConcurrent=3`、`maxTotalSubAgentBudgetUsd=$5`。

两个耦合后果：
- **预算饥饿**：若主任务的 research sub-agent 已把累计预算逼近 $5，`spawnSubAgent` 会抛 "budget exceeded" → 被 `makeAutoVerifyGate` 的 try/catch 吞掉 → `passOpen()`。**完成度审核会在预算耗尽时静默失效**（fail-open 安全方向正确，但安全门被悄悄关闭，无可观测信号）。
- **队头阻塞**：verify 在主循环「无工具=完成」点同步 `await`，judge 作为 sub-agent 排队等 3 个 slot；`runJudge` 的 `MAX_WAIT_MS≈24min`。极端情况下 verify 会让整个会话阻塞较久。

建议：给安全门（judge/drift）单独的预算/并发预留，或至少在 fail-open 时发一条 `system_message` 让人知道审核被跳过。

### 1.3 [中] ✅ 已修 — verify judge 的隔离会「降级为只靠 prompt 约束」
`JudgeSnapshot.withReadonlySnapshot` 在非 git 仓库或任一 git 步骤失败时回退为 `fn(null)`，此时 judge 以 `workspaceMode:'shared_readonly'` 在**活动工作树**上跑。`JUDGE_TOOLS` 含 `bash`，而 bash 是否只读**仅由 rubric 文字约束**，没有机制强制；同时 auto 的 autonomy jail 对工作区内写入是 auto-approve。也就是说快照失败时，一个行为异常的 judge 理论上能写真实源码。注释已承认这点，但值得作为已知弱点记录。

相关一致性问题：`JudgeSnapshot.isGitRepo` 只检查 `projectDir/.git` 是否存在；而 `AutoWorktreeCoordinator` 用 `git rev-parse --git-common-dir`。当 `projectDir` 是仓库子目录（或 worktree/submodule 形态）时，judge 误判为非 git → 丢失快照隔离。建议两处统一用 `--git-common-dir` 探测。

### 1.4 [低] ⏸ 评估后保留 — 三层 `_submitInFlight` 并发守卫重复
`MetaAgentSession`、`RoboticsSession`、`KernelSession` 各有一份并发提交守卫。功能正确（最内层兜底），但三层重复，错误信息也不同。可考虑收敛到一层。

### 1.5 [低] ✅ 已修 — `SubAgentBridge.getStatus()` 是「带写副作用的读」且可能抛错
`getStatus` 读到 `completed` 的 `isolated_write` 任务时会触发 `finalize()`（即 git commit）。`finalize` 有 phase 守卫幂等，问题不大，但「查询状态」产生提交对调用方不直观；且当 `_worktreeCoordinator` 缺失时直接 `throw`，会以工具错误形式冒泡给主 agent。建议把 finalize 触发与状态读取解耦。

---

## 2. AGENTIC 模式

后端：`SessionRouter → MetaAgentSession → AgenticSession → KernelSession`。

| 阶段 | 评价 |
|---|---|
| 入口配置 | `MODE_PROFILES.agentic` 干净；`weight=1`，无 `agenticOverrides`。`_raiseMode` 的 explicit-hint 锁正确处理了 agentic/auto 同权重问题。 |
| 工具暴露/权限 | 全量标准工具；`write_file/edit_file` 标 `sensitive:false`（工作区内免确认），仅 plan-mode `ask` 把关——符合设计。 |
| 主循环 | 共用 `KernelLoop`，护栏齐全。`autonomousMode` 关闭，故失速电路/verify/drift 均不启用。 |
| sub-agent | router 注入 `research_dispatch` + `get_sub_agent_status`，bridge 用默认并发(4)/无总预算上限。 |
| compact | `MODE_PROFILES.agentic.compactProfile='agentic'`；compact 锚点含 research artifact + 子任务/契约状态，thunk 在 `compact_start` 拦截处刷新快照——正确。 |
| dispose/resume | `MetaAgentSession.dispose()` 释放 sandbox handle + `inner.dispose()` + 清缓存——完整。 |

模式特有问题：
- **[中] bash 路径边界漏洞**（见 1.1）：agentic 受影响最大，因为它既无 auto 的相对路径检测，默认又允许无沙箱回退。
- **[低]** agentic 无独立的失败可观测护栏（这是 auto 专属），属预期，但人值守模式依赖用户盯着，文档可点明。

---

## 3. AUTO 模式

后端：与 agentic 共用 `_createAgenticBackend`，差异全部由 `MODE_PROFILES.auto.agenticOverrides`（`autonomy` + `promptMode:'auto'`）携带。

| 阶段 | 评价 |
|---|---|
| 入口配置 | **仅显式进入**（`--mode auto`），`ModeDetector` 绝不从措辞推断 auto——安全决策正确。`_raiseMode` 锁保证 auto 不被 registerTool/检测信号顶掉。 |
| 工具暴露/权限 | 纵深防御到位：`AUTO_DENIED_TOOL_NAMES`（memory_write/delete、cron_*、powershell）在 `createStandardTools` 里被过滤掉 **且** `PermissionPolicy` 运行期再 deny；UI 用 `createAutoUiTools`（去掉 ask_user/send_message）。jail 绝对：`lockWorkspace` 强制忽略 permissions.json 的 `allowOutsideWorkspace`。 |
| 主循环 | `autonomousMode=true` 激活：all-error 硬停 + no-FS-progress 软提示 + 一次性自评估注入；verify/drift 门；autonomyFallback 结构化截断兜底。设计完整。 |
| sub-agent | `setAutonomyJail` 把 jail 透传到每个 sub-agent（fail-closed sandbox + autonomy + projectDir 绑定）；`isolated_write` 走 `AutoWorktreeCoordinator` 串行合并；失败 sub-agent 指数退避重试(2 次)。 |
| checkpoint/verify | `AutoCheckpointCoordinator` 单写者串行；verify 独立 judge + 确定性证据 + 只读快照；drift 双门（revision 推进 + 30 batch）。 |
| dispose/resume | 持久 worktree **故意保留**以便 resume；`reconcile()` 在下次启动回滚中断的 merge 事务。router.dispose 在 auto 下跳过 memory 写入（全局 memory 只读），flush dispose checkpoint。resume 经 `buildAutoResumePreamble` 把 goal/done/pending/artifacts/在飞 sub-agent 重注入上下文。 |

模式特有问题（均已修复或缓解，详见 §0.1）：
- **[中] ✅ 安全门预算/并发饥饿与 fail-open 静默**（见 1.2）——auto 专属且最关键，因为这是无人值守的最后保险。 **修复**：`internal` 侧道绕过预算/队列上限 + 队首优先；fail-open 经 verdict `skipped` 在主循环发 `system_message` 警告。
- **[中] ✅ verify judge 快照隔离降级**（见 1.3）。 **修复**：git 探测改 `--is-inside-work-tree`；且无快照（活动树）路径下 judge 去掉 `bash`，只留 `read_file/grep/glob`，关闭写入向量。
- **[中] ✅ isolated_write 失败重试会泄漏旧 worktree**：`_maybeRetryFailed` 用**新 taskId** 重新 spawn 同一 config，对 `isolated_write` 会 `allocate` 一个新 worktree；旧失败 worktree 仅被 `markFailed`，不 `discard`，直到 `reconcile`/`pruneStaleWorktrees` 才清。 **修复**：重试 spawn 前先 `discard` 旧 worktree。
- **[低] ⏸ 已缓解** verify 在「无工具完成」点同步阻塞等 judge sub-agent（队头阻塞，见 1.2 第二点）。 internal 侧道给 judge 队首优先；同步 await 是完成门固有语义，保留。

---

## 4. ROBOTICS 模式

后端：`SessionRouter → RoboticsSession`（组合 `AgenticSession` + ExperienceStore + HardwareProfile + GitWorkspaceManager + Team + Workflow + ContextPager）。

| 阶段 | 评价 |
|---|---|
| 入口配置 | `init()` 编排充分：恢复/新建 project state、**崩溃恢复**（stale TTL + 强制丢弃活跃 worktree）、worktree 对账、agentMode 恢复、Workflow loadWithRepair、心跳定时器、后台清理。 |
| 工具暴露/权限 | 显式注册 robotics 工具 + fs/bash/web/mcp/skill/memory/team/workflow/research；**主 agent web_fetch 限 8k**、sub-agent 用无预算 web_fetch override——降噪设计好。 |
| 主循环 | 复用 `AgenticSession`/`KernelLoop`；首轮 flash 分类 single/multi（默认 single，仅在用户确认后升 multi）。`autonomousMode` 关闭。 |
| sub-agent | 自有 `SubAgentBridge`（用 `this.sessionId`），`experiment_dispatch`/`paper_search`/`research_dispatch`；正确在「注册完所有工具后」`setToolRegistry`（否则 sub-agent 零工具）。 |
| compact | `promptProfile:'robotics'`，customInstructions/deterministicAnchors 为 thunk，在 `compact_start` 刷新 R4/R5 快照 + 强制经验候选重载——正确。 |
| dispose/resume | resume 经 `findBySession`/`findLatestByProjectDir` 绑定 store bucket；dispose 停心跳/watcher、cancelAll sub-agent、清 worktree、`extractKnowledgePostSession`。 |

模式特有问题（均已修复，详见 §0.1）：
- **[高] ✅ `RoboticsSession.dispose()` 没有调用 `this.inner.dispose()`**。对照 `MetaAgentSession.dispose()`（第 540 行调 `this._inner.dispose()`），robotics 路径从不释放内层 `AgenticSession`/`KernelSession`，于是消息缓冲、FileStateCache、工具闭包、以及通过 instrument 闭包被 pin 住的 `RuntimeContext`/`ProvenanceTracker`/`QueryAnalyzer FlashClient` 都不会被回收。长生命周期 host 反复开关 robotics 会话会持续泄漏。 **修复**：在 `extractKnowledgePostSession`（读 `this.inner.getMessages()`）**之后**调用 `this.inner.dispose()`。
- **[中] ✅ resume 同进程二次绑定会抛错**：`new SubAgentBridge(this.sessionId)`，而 `this.sessionId = config.resumeSessionId ?? randomUUID()`。`SubAgentBridge` 构造里若静态 `_bridgesBySessionId` 已存在同 id 会 `throw`。 **修复**：bridge 改在 `init()` 创建，先 `await SubAgentBridge.getBridge(this.sessionId)?.dispose()` 等待陈旧 bridge 销毁后再 new；dispose 内 bridge 调用加 `?.` 可选链。
- **[低] ✅** `getStatus` finalize 副作用（见 1.5）在 robotics 多 sub-agent 编排下更易触发。 **修复**：getStatus 改为纯读（见 §1.5）。

---

## 5. 修复优先级与落地状态

原始建议清单 + 落地状态（详见 §0.1 表格）：

1. **[高]** `RoboticsSession.dispose()` 末尾（知识抽取后）补 `this.inner.dispose()`。 — ✅ 已修
2. **[中]** auto 安全门（verify/drift）独立预算/并发预留；fail-open 可观测。 — ✅ 已修（`internal` 侧道 + `skipped` 警告）
3. **[中]** verify judge 快照探测统一；快照失败时禁用 judge 的 bash。 — ✅ 已修（`--is-inside-work-tree` + 无快照去 bash）
4. **[中]** isolated_write 重试前 `discard` 旧 worktree。 — ✅ 已修
5. **[中]** 把 `~`/`$HOME`/`../` 逃逸检测用于非 auto 的 bash。 — ✅ 已修（jail-active 全模式生效）
6. **[低]** `getStatus` 读写解耦；robotics 同进程二次 resume 的 bridge 复用。 — ✅ 已修；三层 `_submitInFlight` — ⏸ 评估后保留（见 §0.1）。

回归测试：非 auto bash 逃逸拦截 + `allowOutsideWorkspace` 逃生口（`PermissionPolicy.test`）、internal 任务绕过预算/队列上限（`SubAgentBridge.test`）、无快照时 judge 只读工具集（`VerifyJudge.test`）、drift 跳过标 `skipped`（`DriftAndLearn.test`）。

---

## 6. 已确认良好、无需改动的点

- `modes.ts` 单一事实源 + 编译期锁。
- auto 仅显式进入、denied 工具双层防御、jail 绝对覆盖 permissions.json。
- `KernelLoop` 的压缩 keep-set / 停滞 / 震荡 / fallback / 流错误恢复护栏。
- `AutoWorktreeCoordinator` 的崩溃恢复（merge 事务回滚 + 孤儿 worktree 对账）与「dispose 保留持久 worktree 供 resume」。
- 各 compact thunk 在 `compact_start` 拦截处刷新快照、同步求值的设计一致且正确。
