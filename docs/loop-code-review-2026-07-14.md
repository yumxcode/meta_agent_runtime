# Loop 机制代码评审（2026-07-14）

评审范围：`src/loop/`（auto_orch v2 charter 驱动的长时程 loop runtime），重点是执行链
（WakeStore → runner → daemon → LoopKernel 九步轮管线 → Seats）与支撑子系统
（effects / ledger / wake / capsule / lifecycle / security）。共读源码约 20 个文件；
行号以当前工作区为准。

结论先行：**架构质量高，工程纪律好**——事件溯源的 effect 账本、first-wins conclude、
postState 可重建、原子写 + 带 owner token 的文件锁、wake 合并与 claim TTL、崩溃恢复
以 reconcile 而非快照实现，这些设计都正确且注释诚实。2026-07-11 外审的 F1（writeScope
沙箱）和 F2（abort 误结算）均已确认修复（`Seats.ts:157-188` 白名单沙箱、
`RoundAbortedError` + `abortedCostUsd` 链路）。本次发现的问题集中在**错误分类的兜底
路径、非结构化输出驱动控制流、以及若干未闭合的崩溃/竞态窗口**。

问题分级：P1 = 正确性/可用性缺陷，建议尽快修；P2 = 边界条件与竞态，条件触发；
P3 = 性能与可维护性。

---

## P1 — 正确性缺陷

### 1. 未分类异常 → wake 无限热重试，且每次重试都可能重复花费 LLM 成本

`runner.ts:150-204`：`runClaimedWake` 对四类已知错误
（EffectConfiguration/LedgerCorruption/CharterEnforcement/RoundExecutionUncertain）
fail-stop，其余一律 `release(wake.wakeId, 'pending')` 重新入队（`runner.ts:203`）。
但：

- `WakeRecord.attempts` 只在 `claimDue` 里自增（`WakeStore.ts:177`），**全代码库没有任何
  地方消费它**——没有最大尝试次数，也没有退避（release 后 `fireAt` 仍是过去时刻，下一个
  poll 立即重claim）。
- 一个确定性的未分类错误（dispatcher spawn 抛错、Seats 里未包裹的 bug、
  HostCoordinator `acquireRound` 持续失败等）会以 daemon poll 间隔（默认 2s）无限重跑。
  若错误发生在 worker seat 之后（如 completeRound 里抛错），**每次重试都完整重跑
  worker，真金白银地重复花费**，且轮次未入账，lifetime USD 预算无法拦截。

建议：消费 `attempts`——超过阈值（如 5）转 `failed` + `statusReason`；release 'pending'
时按 attempts 指数退避改写 `fireAt`。

### 2. 终止性判决（goal_satisfied）与观测值可被非结构化文本抓取驱动

代码对 `label:'wait'` 明确要求 `worker.structured`（`LoopKernel.ts:517`，注释解释了
"散文中引用的示例 JSON 会变成意外停机"），但同样的防御**没有覆盖后果更严重的路径**：

- `decideRoute`（`LoopKernel.ts:1112`）：`judge?.data['goal_satisfied'] === true` 直接
  finalize 整个 loop，不检查 `judge.structured`，也不要求 `judge.ok` 或
  `verdict === 'pass'`。
- `collectObservables`（`LoopKernel.ts:1253-1313`）与 `evaluateMetricObjective`
  （`LoopKernel.ts:1388`）同样从 `judge.data` 读值，不区分来源。

而 `extractData`（`Seats.ts:428-444`）在 return_result 缺失时会从 output/summary 的
**最后一个 JSON 代码块**兜底抓取（`structured:false`）。judge 的任务 prompt 本身就内嵌
了含 `"goal_satisfied":<bool>` 的示例 JSON（`Seats.ts:248`）——一个 judge 崩溃后 summary
里残留的示例/复述块，就可能被抓成 `goal_satisfied:true` 并**终止 loop 并写下
final_report**。这与 wait 路径已经识别并防住的是同一类风险，但爆炸半径更大。

建议：所有驱动控制流/路由/计量的 judge 字段（goal_satisfied、verdict、metric、
observables）仅在 `structured === true` 时采信；非结构化时按 judge error 处理
（现有 onError 策略正好接得住）。

### 3. prepareAndClaim 缺少按实例的错误隔离——单实例故障可放倒整个 daemon

`runner.ts:66-87`：prepareAndClaim 遍历所有实例做 ingestEvents/reconcileWaiting，
catch 只处理 `LedgerCorruptionError`，其余异常直接上抛。`daemon.ts:159` 对
prepareAndClaim 的调用没有 try——异常穿透 `for(;;)`，daemon 整体退出（且不是
`exitReason` 之一，是裸抛）。

触发面并不小：`ingestEvents` 对事件目录的 EACCES/EIO 明确选择上抛
（`WaitOps.ts:99-102` "operational faults must remain visible"）；`reconcileWaiting`
里 `advanceEffect` 的非 EffectConfiguration 异常同样穿透（`WaitOps.ts:224-230`）。
结果是**一个实例的一次 I/O 故障让同工作区所有 loop 停止调度**；若外层有自愈重启，
则变成热崩溃循环。

建议：prepareAndClaim 的 per-instance 循环体整体 try/catch，故障实例记录
statusReason（或跳过并计数），其余实例继续调度。

### 4. inbox 消费与轮次完成不是事务性的——abort/replay 会丢人工反馈

`buildCapsule` 在轮启动时就把 inbox 消息 move 到 `processed/`
（`CapsuleBuilder.ts:64-66, 116-141`；pivot 轮在 `LoopKernel.ts:346-362` 提前消费）。
若之后 seat 触发 `RoundAbortedError`（daemon 优雅重启是日常操作）或进程崩溃，wake
重新入队、轮次重放——**重放轮的 capsule 里 inbox 是空的**，人工反馈静默丢失（只能靠
人翻 processed/ 目录发现）。这削弱了"pause/resume/inbox 是一等干预通道"的承诺。

建议：inbox 文件改为"轮完成时归档"——capsule 构建时只读取并在 pending/RoundEntry 中
记录已读文件名，completeRound/submitSegment 成功后才 move 到 processed/。

### 5. `waiting` 状态且无 pending_round 的实例永远不会自愈

`stopInstance`（`Lifecycle.ts:216-217`）先 `clearPendingRound` 再 `stopLoopManually`。
两步之间崩溃 → 实例状态仍是 `waiting`、pending_round 已删、wakes 已被 cancelEffect/
cancelForLoop 清理。此后：

- `prepareAndClaim`（`runner.ts:76-78`）：`waiting && !hasLiveWake` → reconcileWaiting；
- 但 `reconcileWaiting` 的 no-pending 分支（`WaitOps.ts:273-280`）只结算 concluded
  effect，**既不改状态也不排 wake**；
- daemon 的 `hasWaiting`（`daemon.ts:185-186`）又因此永不 idle-exit——一个死实例让
  daemon 以 2s poll 空转到天荒地老。

再跑一次 `loop stop` 可以解开，但系统承诺的是"kill -9 is boring / 任何进程任何时刻可
修复三元组"。建议在 reconcileWaiting 的 else 分支补：`status === 'waiting' && !pending`
→ 置 idle + 排即时 timer wake（或至少写 statusReason 暴露异常）。

---

## P2 — 竞态与边界

### 6. pause 与已 claim wake 的竞态：`setInstanceStatus('running')` 无 expectFrom

`pauseInstance` 用 `expectFrom:['idle','waiting']` 保护了自己的写入
（`Lifecycle.ts:89-92`），但内核侧 `runRound` 的 `setInstanceStatus(instance,'running')`
（`LoopKernel.ts:306` 及 harvest 各处）是无条件覆盖。时序：runClaimedWake 通过
HALTED 检查（`runner.ts:114`）→ pause 提交（idle→paused_manual，取消 wakes）→ runRound
写 'running' 覆盖 paused_manual → 整轮照跑，轮末写回 idle。审计账本记着"已暂停"，
实际没停。窗口窄但真实存在。建议 'running' 写入带
`expectFrom:['idle','waiting']`，失败即按 stale wake 放弃。

### 7. 成本账在若干路径上有漏

- stale wake 携带的 `abortedCostUsd` 在 route='stale-wake' 时随 `release('cancelled')`
  丢弃（`runner.ts:148`，`LoopKernel.ts:186-197` 返回 costUsd:0）；
- harvest 的 replay guard 路径（`LoopKernel.ts:843-864`）同样不折算 carriedCostUsd；
- 链式等待窗口：`harvestSegment` 先 `markHarvested(旧effect)` 再 `submitSegment` 写新
  pending（`LoopKernel.ts:902-931`）——两步间崩溃，reconcile 会把旧 pending 判为
  "harvested 遗留"而丢弃重放（`WaitOps.ts:267-272`），该 pending 里累计的
  `costUsdSoFar` 从 lifetime 账上消失。

单笔金额小，但设计文档明确"abort/restart cannot reset the lifetime USD ledger"
（`WakeStore.ts:49-51`），这些路径违背了该不变量。链式等待可将 markHarvested 挪到新
pending 写盘之后（harvest 侧的 replay guard 已能容忍 concluded 旧 effect）。

### 8. EffectAdapterRegistry 的 admission 是进程级永久棘轮

`EffectAdapter.ts:103-110`：任一 binding 请求更紧的 `maxConcurrentCalls`/
`minIntervalMs`，会**永久收紧该 adapter 在整个进程内的共享 state**——跨 loop、跨
workspace，且该 loop 结束后也不恢复。加上 `DEFAULT_REGISTRY` 是模块级单例
（`EffectAdapter.ts:205-209`），一个配置了 `maxConcurrentCalls:1` 的 charter 会把
同进程所有使用该 adapter 的 loop 限成串行。注释称 "monotonically tighten" 是有意的，
但"永不放松 + 跨租户"更像实现省事而非策略。建议 per-call 计算有效限额
（min(host, binding)），不回写共享 state。

### 9. 同主机 daemon 锁的 PID 复用死锁

`daemon.ts:222-224`：同主机场景只看 `isAlive(pid)`，PID 被无关进程复用时锁永远
不可回收（跨主机路径反而有 mtime freshness 兜底）。建议同主机也叠加 freshness 判断：
pid 活着**且**锁新鲜才算被持有。

### 10. 认证事件无 nonce 重放登记

`verifyEffectEvent`（`EventAuth.ts:100-144`）校验签名、scope、过期，但不记录已消费
nonce。同一 effectKey 若被 worker 复用于新一次等待（effectKey 是 worker 选的），
过期窗口内的旧签名事件文件可重放来了结新等待。`conclude` 的 first-wins 只防同一
effect 内的重复。低概率，但既然做了 nonce 字段，建议在 processed 侧留 nonce 索引或
把 effect 的 submittedAt 纳入签名负载。

### 11. self-timer 的 waitDeadlineAt 以轮开始时间为基，长事件等待后立即触顶

`submitSegment`（`LoopKernel.ts:772-774`）：`waitDeadlineAt = startedAt +
maxRoundElapsedMs`（默认 24h）。一个先做了多天 event 等待、harvest 后想 self-timer
park 的轮，deadline 早已过期 → fireAt 被钳到过去 → 立即唤醒并进入"最终收割、禁止再
timer"。语义上 maxRoundElapsedMs 想限的是"自计时链的墙钟"，不是"整轮寿命含事件等待"。
建议以首次 self-timer park 时刻为基。

---

## P3 — 性能与可维护性

### 12. EffectLedger 每次操作全量重放 JSONL

`EffectLedger.fold()`（`EffectLedger.ts:203`）在每个 `get/conclude/pending/...` 上
重读并重放整个 effects.jsonl，且这些操作都在 withFileLock 临界区内。单轮内核路径会
调用十余次；长寿 loop 的 effects 文件线性增长后是 O(N²) 趋势。当前规模无碍，但账本
是 append-only 的，加一个 (mtime,size) 快照缓存即可。

### 13. 调度热路径的 O(N) 文件扫描

- WakeStore 每个操作在全局 `.lock` 下 `listUnlocked()` 读全部 wake 文件
  （`WakeStore.ts:101,161`）；
- daemon 每 2s 对**所有**实例跑 ingestEvents（含无条件 mkdir processed/）+
  waiting 实例的 reconcileWaiting（`runner.ts:66-87`）；
- `runClaimedWake` 与 `runRound` 各起一个 60s 心跳 interval 双重心跳同一 wake
  （`runner.ts:101-104`、`LoopKernel.ts:172-175`），无害但冗余。

### 14. 代码组织

- `LoopKernel.ts` 1656 行；`runSeatLoop`（`LoopKernel.ts:469-734`）265 行、五层嵌套、
  四种一次性 retry 标志 + producer gate 集合 + wait 合同校验混在一个 `for(;;)` 里，
  是全模块最难审计的函数。wait-request 校验（~120 行）可整体提为纯函数。
- `runner.ts:150-204` 四个错误分支结构完全相同（load → setStatus failed → cancel
  wakes → return），可收敛为一个 `failStop(instance, reason)`。
- `src/loop/reduce/` 与 `src/core/auto_orch/` 存在 CodeNodeAuthor/Runner/Store 三件套
  双份拷贝；v1 退役计划若已定，建议尽快删除单侧。

### 15. 小项

- inbox 不可读文件静默留置、每轮重试（`CapsuleBuilder.ts:136-138`），与 events 的
  loud `.bad` 隔离哲学不一致，坏文件会永久沉默地卡在收件箱。
- `lastJsonBlock` 抓到的 `label:'error'` 会翻转 `ok`（`Seats.ts:414`）——free-text
  兜底影响 ok 判定，与 #2 同源，顺手一起收紧。
- `withFileLock` 默认 10s 超时：WakeStore 全局锁在慢盘 + 多 wake 时可能超时抛错，
  走 #1 的热重试路径，两个问题会互相放大。

---

## 值得肯定的设计

- **控制流全在宿主代码**：九步管线中 LLM 只出现在 SEAT 与 GATE 的 judge 半边，路由是
  冻结 charter 上的表达式求值，每轮留一条可审计 RoundEntry——这是整个系统最重要的
  不变量，且实现与注释一致。
- **崩溃恢复以重建代替快照**：{pending_round × effect × wake} 三元组的 reconcile
  （`WaitOps.ts:186-282`）覆盖了绝大多数 kill -9 交错；harvest replay guard
  （`LoopKernel.ts:843`）+ progress 从 postState 重建（`LedgerApi.ts:147-176`）
  闭合了账本侧。
- **锁纪律**：owner token + rename 抢占 stale 锁（`persist/index.ts:167-226`、
  `daemon.ts:232-239`）正确处理了双删竞态；`expectFrom` 磁盘校验关掉了 CLI-vs-daemon
  的盲写竞态（#6 是唯一漏网处）。
- **安全边界成体系**：worker 沙箱白名单 + 对 ledger/events/inbox/wakes 的显式 deny
  （`Seats.ts:171-188`），writeScope 的符号链接逃逸检查（`PathSafety.ts`），事件签名
  密钥放在 worker 不可见的 home 目录（`EventAuth.ts:169-173`）。
- **测试面广**：29 个测试文件覆盖 acceptance/lifecycle/waiting/scheduler/effects/
  capsule/charter/security，且测试名对应崩溃窗口（judgeContract、selfTimer、
  reviewFixes）。建议为本文 #1（热重试）、#4（inbox 丢失）、#5（waiting 无 pending）
  各补一个回归用例——这三个都容易用现有 test harness 模拟。

## 建议修复顺序

1. #2（structured 采信收紧）——改动最小、防的是"误终止"这一最贵事故。
2. #1 + #3（重试上限/退避 + per-instance 隔离）——两者共同决定 daemon 的生存性。
3. #5 + #4（自愈补洞 + inbox 事务化）——兑现"kill -9 is boring"的承诺。
4. P2 各项按触发概率排：#8（多 loop 部署即触发）> #6/#7 > #9/#10/#11。
