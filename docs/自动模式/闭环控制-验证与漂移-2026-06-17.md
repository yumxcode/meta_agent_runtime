# Auto 模式闭环控制：Verify · Drift/Learn · Checkpoint

> 2026-06-17 设计说明。背景是把 auto（无人值守）模式从"开环的 while-loop"补成博客 *Loop Engineering* 描述的闭环控制系统：模型即使犯错，也能被**发现、纠正、并重新收敛到目标**。

## 控制论映射

| 控制论角色 | Loop Engineering | 本仓实现 |
|---|---|---|
| 参考输入 Reference | Goal | `SessionRouter._autoGoal`（首轮用户输入，冻结，落盘 `AutoCheckpoint.goal`） |
| 控制器 Controller | Loop | `KernelLoop` 的 `while(true)` + 各类 guard |
| 状态观测器 Observer | Checkpoint | `AutoCheckpointStore`（done/pending/artifacts 落盘） |
| 反馈回路 Feedback | Verify | 完成门禁：独立 judge 子 agent（本次新增） |
| 中途校正 + 学习 | Checkpoint + Learn | Drift gate + 经验库（本次新增） |

三处新增彼此独立、都 **fail-open**（自身故障绝不卡死被保护的运行），且都只在 `autonomousMode` 下生效。

---

## 1. Verify —— 完成门禁（反馈回路）

**问题**：执行 agent 停止发起工具调用 = 它"认为完成了"。无人值守时不能盲信这个自判。

**机制**：在 `KernelLoop` 自然完成路径（`toolUseRequests.length === 0` → `done('success')`）前插入门禁：

1. 先在**主工作树**跑确定性检查（`tsc`/`test`/`build`/`lint`，退出码为客观事实）；
2. 用临时 `GIT_INDEX_FILE` 造一个含**未提交改动 + 未跟踪新文件**的快照 commit，`git worktree add --detach` 检出到一次性只读副本；
3. 起一个**隔离** judge 子 agent（只读工具 `read_file/grep/glob/bash`），输入 = 纯净 goal + 确定性证据 + 快照路径，要求**每条判定引用证据**、只输出 JSON 裁决；
4. `done:false` → 把未完成项注回、`continue`；最多 `MAX_VERIFY_ROUNDS = 5` 轮，用尽 → `done('verify_exhausted')`。

**关键设计**
- judge 隔离上下文，**看不到 executor 叙事**，只对照纯净 goal + 客观产物 → 打破自我确认偏差。
- 确定性检查在主树跑（有依赖），judge 的 bash 只在快照里做轻量取证 → 解决"快照无 node_modules"。
- 快照让 judge 的 bash 写入只落在一次性副本，损坏不了真实源码。

**文件**：`kernel/loop/VerifyGate.ts`（契约）、`core/auto/verify/{DeterministicEvidence,JudgeSnapshot,VerifyJudge}.ts`（实现）。

---

## 2. Drift / Learn —— 中途校正 + 经验沉淀

**问题**：长任务会跑偏；失败教训若不落盘，下次重复踩坑。

**触发（双层保险）**：`KernelLoop` 每轮末尾，满足任一即触发一次 drift 检查：
- **compaction 边界**（主触发）：`compactResult.wasCompacted` —— 天然的"积累够多、停下盘点"时刻；
- **轮数兜底**：`turnsSinceDrift >= DRIFT_TURN_INTERVAL`（=5）—— 防止短但已跑偏的运行无人管。

**drift 子 agent**（隔离）：输入 = 纯净 goal + **checkpoint**（非全量上下文，保独立 + 便宜）+ 既有经验。两个职责：
- **判偏移**：对照 goal 与进度快照判断方向是否正确；`drifted:true` → 注回一次性航向校正 prompt。
- **沉淀经验**：仅在有确凿证据时调 `experience_write`，**必须注明错误来源**（偏离表现 / verify 拒绝 / 执行失败+退出码）——此严格性是 rubric 软约束（刻意选择），防止烂生成。

**经验库（Learn 闭环）**：
- 复用 robotics `ExperienceStore`，指向 `.meta-agent/auto/experience`，domain=`general`（与 robotics 隔离）。
- **写**：`experience_write` 通过 `setSubAgentToolOverrides` **只给子 agent**，主 agent 不能直接写；auto 下**直写**（非 pending review）。
- **召回**：`MetaAgentSession` 每轮在 stable prompt 末尾追加 `renderRecentExperiences`（失败优先；本地 JSON，KV-cache 友好）。
- 闭环 = 失败时写入 → 行动前召回注入。

**文件**：`kernel/loop/DriftGate.ts`（契约）、`core/auto/learn/{AutoExperienceStore,DriftAgent}.ts`（实现）。

---

## 3. Checkpoint 修复（前置）

drift 依赖 checkpoint，所以先把观测器修对，而不是加 agent 去审计它。

`SessionRouter` 的每轮 checkpoint 写入此前**只写 `pendingTodos`**，`completedSteps`/`artifacts` 永远为空 —— resume preamble 的"已完成"段和 drift 的输入都瞎了。现已补写 `completedSteps`（已完成 todo，`updateAutoCheckpoint` 内 append-only union），让记录天生完整。

---

## 全链路 config 透传

`SessionRouter._createAgenticBackend`（auto 分支）构造 `verifyGate` / `driftGate` / `getExperienceRecallBlock`（dispatcher 与 goal 都**懒读** `_autoBridge`/`_autoGoal`，绕开"bridge 在 session 之后建、goal 首轮才定"的时序）
→ `MetaAgentConfig` → `MetaAgentSession`（spread + 注入召回）→ `AgenticSession` → `KernelConfig` → `KernelLoop`。

kernel 层只持有**回调契约**（`VerifyGate.ts` / `DriftGate.ts`），实现全在 `core/auto/*`，经 config 注入 —— 与 `onPermissionDenial` 同模式，不倒置分层。

---

## 终止原因新增

`LoopTerminationReason` 增 `'verify_exhausted'`（`KernelSession` 映射为 `error_during_execution` 子类型）。

## 已知取舍 / 可调旋钮

- **drift 5 轮兜底**：无 compaction 的会话里每 5 轮起一次 drift 子 agent，是成本项。调 `DRIFT_TURN_INTERVAL` 即可。
- **经验库双实例**：写工具与 drift 召回各持一个 `ExperienceStore`（同目录，文件级一致），未共享内存实例。
- **judge 隔离非硬隔离**：jail 根是 `projectDir`，快照在其下，judge 技术上仍能读 live 文件，靠 rubric 约束"只在快照内取证"。要硬隔离需给 judge 单独 jail 根。
- **experience 证据严格性是软约束**（rubric + 必填 `error_source` 字段兜底），非工具层硬校验 —— 按设计选择。

## 测试

- `core/auto/verify/__tests__/`：`parseVerdict`（裁决解析）、`JudgeSnapshot`（捕获未提交+未跟踪、清理、不污染 live 树）。
- `core/auto/learn/__tests__/`：`parseDriftVerdict`、经验写入/召回（失败优先）、checkpoint `completedSteps` union。
- 全量回归：436 passed。
