# Loop 内核审查修复方案（2026-07-11）

对应外部审查（codex）发现的 11 项问题。每项结论已逐条对照源码核实：9 项完全成立，
#2/#8/#10 的定性按核实结果修正（修正内容在各节"核实修正"中注明）。本文只定方案，
不含实现。

分期原则：P0 = 上线阻断；Phase 1 = 正确性（错账、错轮、错语义）；Phase 2 = 表达力
与规模化。同一 Phase 内按"触发概率 × 修复成本"排序。

---

## Phase 0 — 阻断项

### F1. writeScope 沙箱强制（审查 #1，P0）

**问题**：writeScope 只进 worker 提示词（`InnerOrchWorker.ts` scopeNote）；沙箱只有
`writeDenyPaths`（`Seats.ts` runWorkerSeat），SubAgent 默认 `shared_write`。
空 writeScope 时**连提示词级约束都没有**（`writeScope?.length ? … : ''`），worker
可写整个工作区。

**方案**：在 `runWorkerSeat` 把 writeScope 下译为沙箱配置，deny 优先级不变：

1. 一律设 `readonlyWorkspace: true`，改用白名单授权写入。
2. `writeAllowPaths` = `[draftsDir]` ∪ writeScope 推导出的**静态前缀目录**
   （glob `src/**/*.ts` → 允许前缀 `src/`；`*.md` → 工作区根，此时退化为 deny-only
   并在冻结时告警）。glob 的精确匹配继续留在提示词层，沙箱层做保守的前缀包含——
   宁可白名单略宽，不能没有。
3. 空 writeScope = 纯分析 loop：`writeAllowPaths` 只含 draftsDir，且补上提示词说明
   "本 loop 无仓库写入范围，只写 drafts/"（修掉空字符串分支）。
4. 现有 `writeDenyPaths`（ledger/events/inbox/wakes 等）保留，deny 覆盖 allow。

**涉及**：`Seats.ts`、`InnerOrchWorker.ts`、`CharterValidate.ts`（glob 前缀退化告警）。
**验收**：worker 在空 writeScope 下 bash 写工作区任意文件被沙箱拒绝；scope 内路径可写；
drafts 恒可写；全量测试不回归。
**工作量**：小（1 天内），前提是沙箱层已支持 `readonlyWorkspace + writeAllowPaths`
（`shared_readonly` 分支已在用，机制现成）。

---

## Phase 1 — 正确性

### F2. abort/超时误结算为失败轮（审查 #4，P1）

排最前：daemon 优雅重启是日常操作，每次都可能触发。

**问题**：`spawnAndWait` 遇 abort/超时返回 null 且不取消任务；kernel 不检查
`signal.aborted`，把 null 包装成 `ok:false` 走 `completeRound` → stale 自增、轮次
入账、调度下轮；非配合式 dispatcher 下还遗留后台任务。

**方案**：

1. `spawnAndWait`：abort/超时路径 best-effort 调 `dispatcher.cancelTask(taskId)`；
   返回值区分 `null(超时)` 与 `'aborted'`。
2. `runSeatLoop` 每个 seat 返回后检查 `signal.aborted`：已中止则短路上抛
   `RoundAbortedError`（不写任何账）。
3. `runRound` 捕获后走新路径：不 completeRound、不 schedule；wake `release(…,
   'pending')` 重新入队，实例状态回 `idle`。下次 daemon 起来重跑该轮（轮次未入账，
   重跑即重放，与 crash 恢复语义一致）。已花费的 seat 成本会丢账——在 wake 记录上
   附 `abortedCostUsd` 累计，重跑轮结算时并入，避免 lifetime usd 被绕过。
4. 轮开始前（MODE 之前）同样检查 aborted，直接不启动。

**涉及**：`seatSpawn.ts`、`LoopKernel.ts`、`runner.ts`。
**验收**：新增测试——seat 运行中 abort：无 RoundEntry、无 meter 变化、wake 回
pending、cancelTask 被调用；恢复后重跑同一轮号。
**工作量**：中（1–2 天）。

### F3. event wake 去重（审查 #2，P1）

**核实修正**：并发双 `conclude` 属实且 `WaitOps.ts:49` 注释与代码不符；但 fold 对
第二条 conclude 是 no-op（账本不坏），`claimDue` 每 loop 每 sweep 只放一个，实际
后果是 harvest 完成后第二个 wake 触发一次**提前的新轮**（绕过 roundIntervalMs、
多花一轮），而非重复结算同轮。窗口=手动 `loop tick` 与 daemon 并发。

**方案**（双层，都便宜）：

1. **源头加锁**：`EffectLedger.conclude` 用 `withFileLock`（锁文件放实例目录）包住
   读-判-追加，使 first-wins 真正成立。
2. **内核兜底**：`runRound` 开头，若 `wake.kind === 'event'` 而 `pending_round`
   不存在或 effectKey 不匹配 → `release(…, 'cancelled')` 直接返回
   `route:'stale-wake'`，不进 freshRound。这使 WaitOps 那句注释成真。

**涉及**：`EffectLedger.ts`、`LoopKernel.ts`（runRound 前置检查）、`WaitOps.ts`（注释）。
**验收**：并发 conclude 测试断言恰一个 true；伪造多余 event wake 断言不产生新轮。
**工作量**：小（半天）。

### F4. 路径穿越（审查 #5，P1）

**方案**：

1. 新公共助手 `resolveInside(root, rel)`：resolve 后校验前缀在 root 内，越界抛错。
   `inlineEvidence`、`runSchemaGates` 换用（运行时第二道防线）。
2. `validateCharter` 对 `seat.inputs`、`gate.files`、`gate.evidence` 套用与
   writeScope 相同的静态规则（拒绝绝对路径与 `..`），冻结时就报错——distiller 的
   重试回路会自动修正。

**涉及**：`Seats.ts`、`LoopKernel.ts`、`CharterValidate.ts`、`infra/persist`（助手落点）。
**验收**：`../../etc/passwd` 类 inputs 冻结报错；手改冻结文件绕过 validator 后运行时
仍拒绝。
**工作量**：小（半天）。

### F5. progress 损坏防倒退（审查 #10，P1）

**核实修正**：损坏时有 `console.error` + `.corrupt` 备份，非全静默；`writeProgress`
原子写使进程崩溃不产生损坏文件。但 iteration 归零 → 轮次编号重复、预算复活的后果
链成立。

**方案**：`readProgress` 区分三态——文件不存在（新实例）→ 默认值；可读 → 原值；
损坏（`.corrupt` 备份发生）→ **从 rounds.jsonl 重建**：iteration = max(round)、
totalCostUsd = Σcost、meters/status = 末条 RoundEntry、bestMetric 从 rounds 回放；
rounds.jsonl 也不可读 → fail-stop（实例 `paused_attention`，报告注明账本损坏），
绝不静默从零跑。

**涉及**：`LedgerApi.ts`（`rebuildProgress()`）、`infra/persist`（corrupt 信号上抛）。
**验收**：损坏 progress.json 的实例下一轮编号连续、预算不复活；rounds 同时损坏时
loop 停住而非重跑。
**工作量**：中（1 天）。

### F6. budgets.perRound 死配置（审查 #9，P1）

**方案**：实现而非删除（distiller 已在教它，删除会破坏已有 charter）：

1. `runSeatLoop` 维护本轮 `costUsd` 累计；每次 spawn seat 前把
   `maxBudgetUsd = min(seat.budgetPerRound.usd, perRound.usd 剩余, lifetime.usd 剩余)`
   下传，剩余 ≤ 0 时不再 spawn，本轮按 worker 失败结算（stale 兜底）。
2. `perRound.turns` 语义定义为"本轮全部 seat turns 之和上限"，同样预算下传；
   不想支持就从类型和 distiller 里删掉 turns，别留半死字段。
3. lifetime usd 由此获得轮内下传，单轮超支上界从"一整轮"缩到"单个 seat 的缺省额度"。

**涉及**：`LoopKernel.ts`、`Seats.ts`、`Distiller.ts`（说明 perRound 语义）。
**验收**：perRound.usd 低于 worker 缺省额度时 seat 实际预算被压低；耗尽后 judge 不再
spawn；rounds.jsonl 成本不超 perRound。
**工作量**：中（1 天）。

### F7. P2 五小项（审查 #11）

一次顺手清完，各 ≤ 半天：

1. **judge fail 空 messages**：仍触发一次纠偏重试，preface 用通用文案
   "评审未通过（judge 未给出具体纠偏项），请自查证据链后重做"；同时在 JUDGE_CONTRACT
   里把 messages 从"若 fail 给出"改为"fail 时必填"。
2. **validator**：声明了 `from:'judge'` observable 但无 `seats.judge` → 冻结报错
   （与 judge gate 的既有检查同型）。
3. **lineage_round 死值**：从 `SeatContext` 类型删除；`normalizeCharter` 把存量
   `lineage_round` 迁移为 `isolated`（与现行为一致），validator 给迁移提示。
4. **wake 清理**：daemon 每次进入 idle 检测时调 `prune(7d)`；`tickOnce` 不动
   （CLI 单发不该做 housekeeping）。
5. **JSONL 规模**：见 F11（Phase 2），此处只加一条 `readJsonl` 的 lastK 尾读优化
   （按块倒读文件尾，避免全量 parse）——readView 的 lastK 调用方即刻受益。

---

## Phase 2 — 表达力与规模化

### F8. 指标方向与通用词汇（审查 #7，P1）

**核实修正**："不能表达最小化"过强——metric_delta 语义由 rubric 定义可绕；真正
错的是 bestMetric 恒取 max 与 JUDGE_CONTRACT 未定义 delta 方向。

**方案**（最小改动，不做大泛化）：

1. charter 新增 `metric: { direction: 'max' | 'min' }`（默认 max）。bestMetric
   比较、报告渲染按方向取优。
2. JUDGE_CONTRACT 措辞钉死："metric_delta > 0 恒表示**改善**（方向由验收目标定义）"
   ——让最小化场景在契约层就自洽，不依赖 rubric 作者自觉。
3. 多目标：明确写进 Distiller prompt 的建模指引——由 judge rubric 合成单一
   metric（加权/瓶颈项），不在内核引入向量指标。
4. 发布流水线/运维/合规类场景**不在本期目标**：记 roadmap，核心缺口是
   审批人踪迹、时间窗语义（cron 式 SLA）与非 findings 型产物账本。

**涉及**：`CharterTypes.ts`、`CharterValidate.ts`、`LoopKernel.ts`、`Seats.ts`、
`Distiller.ts`。
**工作量**：小（1 天）。

### F9. schema gate 做实（审查 #6，P1）

**方案**：给 `GateSpec` 的 schema 门加最小结构校验（不引 ajv 依赖）：

```
{"kind":"schema","files":["drafts/findings_draft.json"],
 "spec":{"type":"array","itemRequired":{"claim":"string","evidence":"string"}}}
```

支持四种断言就够覆盖现有用途：顶层 type（object/array）、required 键及其
typeof、数组元素 required、非空。无 `spec` 时保持现行为（仅 parse），validator
提示"未提供 spec 的 schema 门只校验 JSON 可解析"。Distiller prompt 同步：产出
契约类校验优先用 spec 化 schema 门（对 drafts），而非 judge rubric 里写格式检查。

**涉及**：`CharterTypes.ts`、`CharterValidate.ts`、`LoopKernel.ts`（runSchemaGates）、
`Distiller.ts`。
**工作量**：中（1 天）。

### F10. 调度并行化（审查 #3，P1）

**方案**（两步走）：

1. **短期（收益 80%）**：`tickOnce` 拆两相——ingest/claim（快，保持串行）与
   dispatch（慢）。dispatch 改为并发启动 `runRound` 并**不在本 tick 等待**：
   runner 维护 in-flight map（loopId → promise），daemon 循环每轮先收割已完成的
   promise，再做 ingest/claim。per-loop 串行由 claimDue 的"每 loop 单 claim"既有
   保证，无需新锁。idle 判定加"in-flight 为空"。dispatcher 并发容量成为新瓶颈，
   沿用其既有队列语义即可。
2. **中期**：dispatch 换成 child-process tick worker（设计文档原方案），得到故障
   隔离（单轮 OOM/崩溃不拖倒 daemon）。仅当 loop 数量或 seat 崩溃率证明需要时再做。

**涉及**：`runner.ts`、`daemon.ts`。
**验收**：两个 loop，其一 seat 挂 30 分钟，另一个的 timer wake 在下个 poll 周期内
被 claim 并完成；abort 时 in-flight 轮走 F2 的重放路径。
**工作量**：中（2–3 天，并发测试为主）。

### F11. 账本规模退化（审查 #11.5，P2）

**方案**：

1. `readJsonl` 尾读（F7.5 已做）覆盖 capsule/readView 热路径。
2. effects fold 快照：`effects.jsonl` 超阈值（如 1000 行）时把 fold 结果写
   `effects.snapshot.json` 并截断已 harvested/failed 的历史（append-only 原则
   只对活跃 effect 保留）。
3. findings 计数缓存在 progress（已有 totalFindings），`readView` 的
   `findingsCount` 改读 progress，消除全量读。
4. wake 目录规模由 F7.4 的 prune 解决。

**工作量**：中（1–2 天）。触发条件：单实例运行月级、findings 数千条时才有感知，
可最后做。

### F12. probe 决策收尾（审查 #8，P1 → 定性为设计决策）

**核实修正**：probe 移除是有意设计（等待判断全部归 worker），不是遗漏；但审查指出
的两个代价真实存在。

**方案**（维持 worker 驱动设计，补两个洞）：

1. **event 等待保底**：event 等待当前无超时、事件丢失即永久 park。给
   `pending_round`（kind=effect）加 `maxWaitMs`（worker 在 wait 声明里可选带，
   内核缺省 7 天）；`reconcileWaiting` 发现超期 → escalate（attention_report 注明
   "外部事件未到达"）。不自动重试——事件丢没丢只有人知道。
2. **死代码清理**：`runner.ts`/`daemon.ts` 的 probe 残留字段（`outcomes.probe`、
   `probesRun`）、`EffectLedger` 的 probes 数组与 `recordProbe`/`recordResubmit`、
   `ProbeAdapters.ts` 空文件，一并 `git rm`/删除。语义上"内核没有 probe"就让代码里
   也没有。

**涉及**：`types.ts`（PendingRound）、`WaitOps.ts`、`runner.ts`、`daemon.ts`、
`EffectLedger.ts`。
**工作量**：小–中（1 天）。

---

## 测试补充清单（对应审查"测试全绿不能消除风险"）

| 缺口 | 新增测试 |
|---|---|
| writeScope 强制 | 空/非空 scope 下 worker 越界写被沙箱拒绝（F1） |
| abort 重放 | seat 中途 abort → 无入账、wake 回队、重跑同轮号（F2） |
| conclude 竞态 | 并发 conclude 恰一 true；多余 event wake 不起新轮（F3） |
| 路径穿越 | 恶意 inputs 冻结报错 + 运行时拒绝（F4） |
| 账本损坏 | progress 损坏后重建/fail-stop（F5） |
| 轮级预算 | perRound.usd 下传与耗尽短路（F6） |
| 并行调度 | 长 seat 不阻塞他 loop；in-flight 与 idle 判定（F10） |
| 历史规模 | 万行 JSONL 下 readView 时间上界（F11，基准测试） |

## 执行顺序汇总

| 序 | 项 | 级 | 工作量 |
|---|---|---|---|
| 1 | F1 writeScope 沙箱 | P0 | 1d |
| 2 | F2 abort 语义 | P1 | 1–2d |
| 3 | F3 event 去重 | P1 | 0.5d |
| 4 | F4 路径穿越 | P1 | 0.5d |
| 5 | F5 progress 重建 | P1 | 1d |
| 6 | F6 perRound 预算 | P1 | 1d |
| 7 | F7 五小项 | P2 | 2d |
| 8 | F8 指标方向 | P1 | 1d |
| 9 | F9 schema gate | P1 | 1d |
| 10 | F10 并行调度 | P1 | 2–3d |
| 11 | F12 probe 收尾 | P1 | 1d |
| 12 | F11 账本规模 | P2 | 1–2d |

Phase 0+1 合计约 5–6 天，完成后"研究型主链路"从"基本闭环"升级为"错账/错轮/越权
三类风险有测试背书"；Phase 2 决定它离"通用长周期运行时"还有多远。Campaign 维持
排除。
