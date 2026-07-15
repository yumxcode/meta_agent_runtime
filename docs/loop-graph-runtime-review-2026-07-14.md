# Durable Graph Loop Runtime 代码评审（2026-07-14）

> **复核状态（2026-07-14）**：已逐项对照当前源码，并完成适用于 `durable-graph-v1` 的修复。下文保留 CC 原始评审作为问题发生时的证据；其中 #4 的 timeout 子项和 #9 在复核开始前已由此前改动修复，#17 的“`output.0` 能用”判断不成立。专项回归现为 37/37 通过。

## 复核结论与处置

| # | 复核判断 | 处置 |
|---|---|---|
| 1 | 正确 | Agent abort 改为无业务提交的 replay，不消耗 attempt；`cancellation_unconfirmed` 改为实例 fail-stop，并保留已知/预留费用。runner 现将 daemon signal 传入 Kernel。 |
| 2 | 正确 | 增加 replay / retry / fatal 执行结果；Agent 常规失败在 `maxAttempts` 内退避；runner 对未分类瞬态错误最多退避 5 次，确定性错误才 fail-stop。 |
| 3 | 正确，但“删除历史的 compaction”不宜与恢复优化混为一谈 | 增加 sequence counter、每 50 条事件 checkpoint、只 fold tail、按事件修 projection；heartbeat 不再写 journal。恢复开销已受 checkpoint 约束，但 append-only 历史文件仍保留，这是公开的 v1 存储边界。 |
| 4 | 一半正确 | 早到事件丢失属实，已增加持久 Event inbox 和消费 journal；`timeoutMs` 在复核前已经可运行，并补充早到/timeout 回归。收件箱 retention 尚未配置。 |
| 5 | 正确 | Freeze 校验现在要求 Agent/Function/Effect 的 success+failure、Timer 的 timer+failure、Event 的 event+failure（带 timeout 时还要求 timeout）；`always` 可统一覆盖。Distill prompt 同步约束。 |
| 6 | 正确 | fan-out 创建稳定 `forkGroupId`，Join 只观察同一 fork epoch；已成功的 Join 会阻止迟到分支再次 spawn，`Join(any)` 迟到回归已覆盖。 |
| 7 | 正确 | 外层 poll deadline 现在至少覆盖节点 `wallTimeMs + 60s`。 |
| 8 | 正确 | merge conflict 不再杀实例，而是把 Activation 留作 replay 并 pause；新增 `loop lane-repair <instanceId> <laneId>`，修复并 merge 后自动 resume。中途增量 merge 不是 v1 强保证。 |
| 9 | 原记录对早期代码正确，复核开始时已过时 | `maxPendingTimers` 已在 durable park 前检查；超限变成节点 failure 路由，不留下 failed+waiting 矛盾。内部 retry backoff 在 timer 配额满时降级为立即 ready。 |
| 10 | 正确 | Artifact 超限现在拒绝该 publication 并记录 rejection，不杀节点/实例；同 commit supersedes 会先从 active set 移除再计数。 |
| 11 | 部分正确 | Effect 强制 `timeoutMs`，deadline 覆盖完整 Activation 和所有 poll，receipt 保证不重复 submit。submit 前独立 intent ledger 仍未实现，v1 明确要求 provider 按稳定 idempotency key 去重。 |
| 12 | 不应机械恢复旧字段，但指出的不变量正确 | 已知 usage 跨 replay/park 累加；无法确认取消时按当前 segment USD budget 保守预留并 fail-stop。没有重新引入 graph 无法可靠推断的全局 `abortedCostUsd`。 |
| 13 | 正确 | 条件中的缺失引用按 false 处理并走 default；类型错误、非法 operator 等确定性错误仍 fail closed。 |
| 14 | 正确 | 无 ready、仅有 stale running 时，下一 graph wake 安排在最早 lease expiry，不再立即热循环。 |
| 15 | 实现正确、文档缺失 | 使用指南已明确 pause 在当前 tick/Activation 提交边界生效，不强杀已 claim 调用。 |
| 16 | 正确 | create 改为两段短事务；workspace identity 和 entrypoint Function 物化均在事务锁外，第二段事务重新检查并发创建。 |
| 17 | 原记录的“能用”判断不正确 | 受限表达式语法不接受数字 path segment，`$output.0` 实际不可解析。runtime 不再平铺数组索引，Distill/文档要求先用 Function 归约成命名标量。 |

### 新增回归证据

- daemon/Agent 中断 replay、unconfirmed cancellation fail-stop 与费用保留；
- runner 瞬态错误退避且实例保持 active；
- Event timeout、早到 Event 持久化与后续消费；
- Join 并发 coalesce 与 `any` 迟到分支；
- long Activation timer continuation、预算累计、maxParks 与 heartbeat；
- Artifact `maxItems` gate；
- Effect 跨 poll 总 deadline 且 receipt 不重复 submit；
- entrypoint Function 不在 Graph transaction lock 中执行；
- journal 投影损坏后的 checkpoint/tail reconcile。

### 仍然明确保留的 v1 边界

1. Journal checkpoint 限制恢复计算量，但不删除 append-only 历史文件；
2. 外部 Event 收件箱没有 TTL/容量清理策略；
3. Effect submit 前无独立 intent ledger，provider 必须支持稳定 idempotency key；
4. Lane 冲突提供人工 repair，不承诺自动语义化解冲突或每节点增量 merge。

评审对象:`src/loop/graph/`(durable-graph-v1,约 2900 行新代码)及配套改写的
runner/daemon/cli/WakeStore。验证状态:`tsc --noEmit` 干净;`vitest src/loop`
68/68 通过(注意:旧架构 262 个测试随删除消失,行为级覆盖大幅收缩,见 §测试)。

## 总评

架构方向正确,三层拆分(Graph Node = 控制语义 / Execution Lane = 会话与工作副本
连续性 / CommitCoordinator = 共享提交)干净利落,正面解决了旧图方案"节点=Agent=
写者"的两个结构性错误。值得肯定的设计:commit intent + `activationId:continuationVersion`
commitKey 的幂等提交与崩溃重放(`GraphStore.prepareCommit`/`CommitCoordinator.commit`
重复 commitKey 直接返回历史事件);journal 先写、投影后写、gap 校验;capability
lock(function/reducer/effect/pack 全带 version+integrity,`GraphKernel` 打开时逐项
核验);LLM 只能编排注册能力、值表达式三型(literal/ref/call)无代码生成;路由完备性
校验相当扎实(`GraphValidate.ts:92-110`:同 from/on 组恰好一条 default、priority
唯一、terminal 无出边、join expects 存在性、全图可达性);Lane 单写者
(maxConcurrency 强制 1)+ terminal barrier;wake claim token 与 daemon 锁(含 PID
复用修复)从旧架构正确保留。

但可靠性成熟度相对旧架构明显回退。旧架构经三轮评审修出来的关键语义——abort 安全
重放、错误分类与退避、事件持久化、外层 poll 覆盖长 wallclock——在重写中丢了至少
四项。以下按严重程度列出。

---

## P1 — 必须在生产前补齐

### 1. abort 与 failure 合流:daemon 重启会把执行中的节点提交为业务失败

`NodeExecutors.ts:139-146`:`result.kind !== 'terminal'`(包括 `aborted`、
`timed_out`、`lost`、`cancellation_unconfirmed`)一律返回
`{ outcome:'failure' }`,随后 `finishActivation` 照常 prepareCommit + commit。
daemon 优雅关停(`daemon.ts:99-101` 等待 inFlight settle)期间,所有被信号取消的
agent 都会**以 failure outcome 提交并走 failure 路由**——一次例行重启就把图推上
失败分支(或触发 #5 的全图 failed)。旧架构的 `RoundAbortedError`(不入账、wake
回 pending、重放)语义完全消失。`cancellation_unconfirmed` 更危险:agent 可能还
活着、还在往 lane workspace 写,kernel 却已提交失败并可能重新调度该 lane(旧架构
对此专门 fail-stop)。

建议:executeAgent 对 aborted/cancellation_unconfirmed 返回新的
`{kind:'aborted'}`,kernel 不 commit、释放 activation 回 ready(lease 清除),
让下一个 tick 重放;unconfirmed 则 fail-stop 实例。

### 2. 任何 kernel 级异常 → 全图 failed,错误分类与重试机制整体缺失

两层 catch-all 都以"实例死亡"收场:`GraphKernel.tick`(128-133 行)把 executor
的 rejection 一律 `failActivation` → instance failed;`runner.runClaimedWake`
(119-122 行)把 tick 的任何 throw 一律 `setStatus('failed')` + cancelForLoop。
落进来的包括大量**瞬态**故障:GraphStore transaction 锁超时(60s,且 #3 会加剧
争用)、FS EACCES/EIO、host lease 心跳抖动。也包括应当只影响单个 activation 的
确定性问题(#9 maxPendingTimers、#8 lane merge conflict、#5 路由不全、#13 条件
引用缺失)。旧架构的错误分类学(RoundAborted 重放 / 确定性 fail-stop / 未分类
指数退避 + 5 次上限)没有等价物;wake 的 `attempts` 字段又一次只增不用。同时
kernel 对 agent 常规 failure **没有任何重试**——`maxAttempts`(NodeExecutors:70)
只在 lease 过期回收的重claim路径上递增生效,正常 failure 直接 commit,一次
API 500 就消耗一条 failure 边。

建议:恢复三分类(可重放/确定性/未分类退避),runner 层对未分类错误用
release('pending', backoff) 而非 cancel;agent failure 在 maxAttempts 内由 kernel
重新置 ready。

### 3. Journal 无 compaction 且每操作全量重放 + 全量投影重写,O(N²) 并加剧锁争用

- `appendEventLocked`(GraphStore:331-339)每次 append 先读**整个** journal 目录
  求下一个 sequence;
- `reconcileLocked`(380-429)在每个 `snapshot()/claimReady/heartbeat/park/
  resumeDue/commit` 上全量重放,并且 `writeProjectionsLocked`(431-436)把**所有**
  activation 与 artifact 投影文件全部重写一遍;
- `GraphKernel.tick` 单次至少调 `snapshot()` 5 次,每个 claim 执行前再来一次
  (117-119 行);
- 活动 lease 的 `heartbeat()`(223-234)每 60s 还向 journal 追加一个
  `activation_claimed` 事件——长时 agent 每小时贡献 60 个事件,每个又触发全量
  投影重写。

一个几百 activation 的图会进入二次方 I/O 膨胀,而这一切都在同一把
`.transaction` 文件锁临界区里,锁超时(60s)直接触发 #2 的全图 failed。
建议:sequence 计数器文件 + 尾部游标缓存(参考旧 EffectLedger 的增量 fold)、
投影只写变更项、heartbeat 不进 journal(lease 是可重建的调度状态,写 activation
投影文件即可)、加 checkpoint/compaction。

### 4. 事件无持久化,早到即丢;`wait.event.timeoutMs` 是死代码

`signalEvent` → `resumeDue`(CommitCoordinator:205-234)只匹配**当前正在
waiting** 的 activation;外部系统在图尚未 park 到 wait 节点前发出的事件被静默
丢弃(CLI 返回 "resumed 0" 后事件即蒸发)。旧架构的 events/ 目录 + first-wins
conclude 正是为这个竞态设计的,本次重写没有等价物。同时 `executeWait`
(NodeExecutors:195-207)对 event 等待从不安排超时——`WaitNodeSpec.wait.timeoutMs`
被 validator 校验(GraphValidate:211)却被运行时完全忽略:事件永不到达时
activation 永久 waiting,实例状态 waiting 又使 daemon 永不 idle-exit。
建议:事件入持久收件箱(消费时匹配 correlation,未匹配保留),event wait 带
timeoutMs 时同时登记 wakeAt,超时以 `outcome:'timeout'` 路由。

### 5. failure outcome 的路由完备性没有被校验

validator 只要求"非 terminal 节点有出边"(GraphValidate:95),不要求覆盖
`failure`。agent/function/effect 三类节点都会产生 failure outcome;没有
`on:'failure'` 也没有 `on:'always'` 边的节点,第一次失败就让
`decideTransition` throw "no transition"(TransitionEngine:34)→ 经 #2 全图
failed。Distiller 系统提示词(GraphDistiller:71-89)也没有要求生成 failure 边,
所以蒸馏出的图默认踩中。建议:freeze 时对每个可产生 failure 的节点强制要求
failure/always 路由(或提供图级 onNodeFailure 缺省策略)。

---

## P2

6. **join 'any' 迟到分支会二次触发**:commit 时只取消当时已存在的同节点 peer
   (CommitCoordinator:110-114);join 触发后才由其他分支 spawn 出来的 join
   activation 没有任何阻拦,`arrived.size > 0` 再次成立,join 输出第二次流入
   下游。需要在 spawn 或 executeJoin 处识别"本 continuationEpoch 已触发"。
7. **`budget.wallTimeMs` > ~31min 的 agent 会被外层 poll 抛弃**:executeAgent 把
   wallTimeMs 传给 `maxDurationMs`,但没有相应抬高 `spawnOptions.maxWaitMs`
   (seatSpawn 默认 DEFAULT+60s)。这是旧 `Seats.ts` 里修过并写了注释的 bug 的
   原样回归("The OUTER poll must outlast the seat's own wall-clock")。
8. **Lane merge 只发生在 terminal,conflicted 无修复路径**:`mergeAll` 仅在
   terminal commit 前调用(GraphKernel:195-198),冲突即 throw → 实例 failed、
   工作滞留 worktree、lane 永久 conflicted(此后 bind 直接 throw),没有任何
   CLI/自动修复动作。至少需要 `graph lane repair`,以及考虑分支中途的增量 merge。
9. **maxPendingTimers 检查在 park 之后**(GraphKernel:175-183):超限时 activation
   已 durable park,却 throw → 实例 failed,留下"failed 实例 + waiting activation"
   的矛盾状态。检查应在 park 前,超限降级为 activation failure。
10. **Artifact maxItems 超限 = 杀实例**:CommitCoordinator:148-151 在 push 之后
    检查并 throw(经 #2 变全图 failed),应改为拒绝该 publication(gate 语义);
    另外计数用的是 pre-commit snapshot,同一 commit 内 supersedes 的旧件仍被计入。
11. **effect 轮询无总 deadline、提交无先行意图**:pending 时以 ≤30s 间隔无限
    poll(NodeExecutors:184-189),没有 maxWait;submit 在无任何持久化意图的
    情况下直接调 provider(崩溃后靠 `instanceId:activationId` 幂等键重放)——
    计划文档已声明这是 v1 边界,但相对旧 EffectLedger(submit 先落账)是弱化,
    建议至少给 effect 节点强制 timeoutMs。
12. **abortedCostUsd 机制被整体删除**(WakeStore diff):被取消/丢失的 agent 花费
    只有当 dispatcher 还能返回 record 时才入账;record 为 null(lost)时 cost=0。
    "abort/restart 不能重置 lifetime USD 账"的旧不变量不再成立。

## P3

13. 条件求值对缺失引用直接 throw(evaluateCondition → Expr):`when` 引用了 agent
    输出中不存在的字段时,后果是全图 failed 而非落到 default 边;旧架构的
    onAbsent/onError 策略无等价物。建议 eval 异常按"条件不匹配"处理并告警。
14. terminal barrier 与 stale 'running'(崩溃残留,lease 未到期)并存时,tick 什么
    都不 claim 却每次都 schedule 立即 wake(GraphKernel:139-146)→ 2s 空转热循环,
    最长持续到 lease TTL(10min)。
15. `pause` 只写状态(cli.ts:145-148),已 claim 的进行中 tick 不感知,当前波次
    照常执行完;setStatus 对 done/failed 免疫但 active tick 的 syncDerivedStatus
    会把 paused 改回 active?——检查:syncDerivedStatus 对 paused 跳过(GraphKernel:219),
    但 tick 末尾 `instance.status === 'active'` 才 schedule,pause 后不再排 wake,
    行为正确;建议仅在文档写明"pause 在当前 tick 边界生效"。
16. `GraphStore.create` 中 `evaluateBindings` 调用发生在 `withTransaction` 内,
    entrypoint inputs 若含 `call` 会在锁内执行任意注册函数——函数应是纯的,但锁内
    跑用户能力代码仍不必要。
17. `flattenPrimitives` 把数组下标平铺成 `output.0` 之类的 ref 键——能用但未在
    Distiller 提示词中说明,LLM 大概率写不出;要么支持要么禁止。

## 测试与覆盖

68/68 通过,但相对旧架构 262 个测试,行为级覆盖大幅收缩:crash 恢复只有
GraphStore/commit-intent 的单元级用例;缺 join(尤其 any 迟到分支)、abort 中断、
事件竞态(早到/重复)、lane 冲突、maxPendingTimers/maxItems 边界、daemon 集成
(idle-exit、并发 graph)等场景。修复 P1 各项时应同步补上对应回归用例——旧
`reviewFixes*.test.ts` 里的场景(热重试上限、abort 不入账、waiting 自愈)大多仍
适用于新架构,值得按图语义移植。

## 结论

骨架和抽象是对的,冻结/校验/幂等提交三件事做得比旧架构更干净;但这次重写把
旧架构三轮评审累积的可靠性语义丢回去了大半。建议合入前至少完成 P1-1/2/5
(abort 语义、错误分类、failure 路由校验)——这三项决定"daemon 重启是不是无害
操作",是这个系统一贯的核心承诺;P1-3/4 随后,其中 #3 在图规模变大前不会爆炸,
#4 在接入第一个真实外部事件源前必须解决。
