# Loop 机制全面代码评审 — 2026-07-10

**范围**：`meta-agent loop` 长周期运行时（`src/loop/**`，约 7,100 行 + 测试），即 charter / ledger / kernel（九步轮管线）/ wake / effects / lifecycle / migrate / distill / daemon / CLI，及其依赖的 `src/infra/persist`。会话级工具循环（`src/kernel/loop/KernelLoop.ts`）不在本次范围内。

**方法**：逐文件精读核心路径 + 崩溃时序推演 + 多进程交错推演；`npx vitest run src/loop` 全绿（18 文件 / 116 用例）。

## 总体评价

这是一套设计意图非常清晰、纪律性很强的实现：控制流全部在宿主代码（LLM 只出现在 seat 与 judge），charter 冻结 + 表达式 DSL 静态校验、账本单写者、EffectLedger 事件溯源 + conclude 先到先得、WakeStore 原子认领 + 合并、withFileLock 的 owner-token 与 rename 抢占等都做得相当到位，注释与设计文档的对应关系（D 系决策编号）是同类代码里少见的好。测试覆盖了验收、生命周期、waiting/harvest、v3 路由等关键场景。

主要风险集中在**多进程交错**与**崩溃窗口重放**两类：单进程单 daemon 下基本正确，但代码明示支持多进程（WakeStore 的 claim 语义、daemon 锁），而认领租约与座位墙钟的不匹配会破坏"每 loop 至多一轮在飞"的核心不变式。

---

## 高危（H）

### H1. 认领租约（10 min）远小于座位墙钟（默认 30 min，可配至数小时），且 `WakeStore.heartbeat()` 无任何调用方

- `WakeStore.ts:59` `DEFAULT_CLAIM_TTL_MS = 10 * 60_000`；`Seats.ts:205-215` 座位墙钟默认 `DEFAULT_SUB_AGENT_MAX_DURATION_MS = 30 min`，`wallclockMin` 可设 45–180。
- `heartbeat()`（`WakeStore.ts:178`）在 `src/` 中零调用（已 grep 证实），轮执行期间租约从不续期。
- 交错：daemon 在跑一个 30 min 的轮；用户另开终端执行 `meta-agent loop tick`（或共享目录的另一台主机跑 scheduler）→ `tickOnce` 开头的 `reconcileOrphans` 把已过期的 claim 归还 pending → `claimDue` 再次认领 → **同一 loop 两轮并发**：LLM 费用双花、`rounds.jsonl` 交错、`progress.json` 最后写者获胜、pending_round 互相踩踏。"at-most-one in-flight round per loop"（WakeStore 头注释）被击穿。
- **建议**：在 `spawnAndWait` 的轮询循环里周期性 `heartbeat(wakeId)`（把 wakeId 透传进 `RunRoundDeps`），或至少把 claimTtl 设为 `max(所有座位墙钟)+slack`。二者取一即可关闭该窗口。

### H2. daemon 跨主机锁直接抢占，放大 H1

`daemon.ts:99`：锁持有者 host 不等于本机时一律视为陈旧并 `rm`。共享文件系统上两台主机各起一个 daemon 会同时运行；叠加 H1 后并发双跑从"边缘情况"变成"常态"。建议：跨主机锁改为基于 mtime 心跳判活（daemon 周期 touch 锁文件），而不是"非本机即陈旧"。

---

## 中危（M）

### M1. pivot 轮的 inbox 被 pivoter 消费掉，worker 看不到人工反馈

`LoopKernel.ts:173-180`：pivot 轮先 `buildCapsule` 给 pivoter，再 `buildCapsule` 给 worker；而 `buildCapsule` 内部 `consumeInbox`（`CapsuleBuilder.ts:57-59`）会把 inbox 消息**移动**到 processed/。第二次构建时 inbox 已空 → pivot 轮里用户通过 `loop inbox` 投递的反馈只进 pivoter、**从不到达 worker**，且落盘的 capsule.json（第二次写）也丢失了这些消息的审计痕迹。
**建议**：一轮只消费一次 inbox，把消息作为参数传入两次构建（或 pivoter 用只读 peek）。

### M2. harvest 段崩溃重放窗口：整段（含 LLM 座位）重跑 + 账本重复入账

`LoopKernel.ts:453-465`：顺序为 `completeRound`（appendRound + writeProgress）→ `clearPendingRound` → `markHarvested`。在第一、二步之间 kill -9：恢复时 pending 仍在、effect 仍 concluded → `reconcileWaiting` 补 harvest wake → **整个 harvest 段重跑**：同一 round 号在 `rounds.jsonl` 出现两条、totalCostUsd 双计、findings 可能重复入账。注释声称 "reconcileWaiting heals every interleaving"，此交错未被覆盖（clear→markHarvested 之间的交错倒是显式处理了）。
**建议**：`harvestSegment` 入口加守卫——`progress.iteration >= pending.round` 时直接 `clearPendingRound + markHarvested` 并返回，不再跑座位。

### M3. 事件等待（event wait）的存活性依赖"总有进程在跑 tick"，且 daemon 的空闲判定与其头注释不符

- 事件等待期间**不存在任何 wake**（设计如此），而 `daemon.ts:75-83` 的空闲判定只看 wake（头注释说"no pending wake **and no instance is waiting**"，代码没有后半句）→ daemon 空闲退出后，外部系统投递 `events/<key>.json` 时无人 ingest，loop 无限期挂起，直到有人手动 tick。"layer C self-heal" 在本仓库中并无实现。
- `runner.ts:40` 的 `known` 集合来自 wake 记录（含 done/cancelled 的残留）：事件等待实例能被 ingest 仅仅因为 `prune()` 从未被调用（也已 grep 证实）。一旦将来启用 prune，事件 ingest 对 waiting 实例直接失效。
- **建议**：ingest 的实例枚举改为扫描 `.loop/*/instance.json` 中 status='waiting' 的实例；daemon 空闲判定把 waiting 实例计入（或明确文档化"事件到达需要外部触发一次 tick/scheduler"）。

### M4. `instance.json` 状态迁移无锁，CLI 与 daemon 之间存在丢失更新

`setInstanceStatus`（`InstanceStore.ts:113-125`）是无锁的读-改-写，且写的是**加载时的内存副本**。交错示例：CLI `loop pause` 读到 idle → daemon 恰好认领 wake 并置 running → pause 写入 paused_manual（覆盖 running）并取消 wake → 轮结束后 completeRound 置 idle 并**重新调度 wake** → 暂停被静默撤销。stop/migrate 有同类窗口。
**建议**：状态迁移包一层 `withFileLock(instanceJson)`，锁内重读并校验前置状态。

### M5. worker 沙箱 deny 清单漏掉 `events/`、`inbox/` 与 `.loop/wakes`

`Seats.ts:100-108` 只 deny 了 ledger/charter/instance.json/capsule/reports。worker 的 bash 可以：往本实例 `events/` 写文件**自我了结**自己声明的 event 等待（伪造外部结果）、往 `inbox/` 写文件在下一轮胶囊里**伪装人工反馈**（capsule 标注为"人工/外部反馈"）、以及改写 `<projectDir>/.loop/wakes` 与其它实例目录。D7"结构性保证"的口径下这是明确的豁口。
**建议**：deny 清单补 `eventsDir`、`inboxDir`、wakes 目录（drafts 保持可写）。

### M6. judge 座位崩溃时 findings 无审即入账（fail-open）

`LoopKernel.ts:707`：`pass = !judge || judge.data['verdict'] !== 'fail'`。judge 因 API 错误/超时返回 `ok:false, data:{}` 时 verdict 为 undefined → 按"通过"处理，drafts 直接进永久账本；且该轮 observables 全缺失（tripwire 求值 fallback false），质量门形同虚设。
**建议**：声明了 judge 座位却拿不到裁决时按 fail 处理（弃 draft），或触发一次 corrective 重试。

### M7. `migrateInstance` 缺省 WakeStore 根目录错误 + `record.projectDir` 语义错位

- `Migrate.ts:154`：`new WakeStore(opts?.projectDir ?? paths.root)` → 缺省落到 `<实例目录>/.loop/wakes`，任何调度器都不会扫描到 → 库调用方（不走 CLI）re-arm 后 loop 永不苏醒。CLI 恰好传了正确参数，属于潜伏弹。
- `InstanceStore.ts:74`：`projectDir: paths.root` 把**实例目录**写进了文档声明为"Workspace"的字段；目前唯一消费者是 `stopLoopManually` 的 stub（从不调用），但这是等着未来踩的数据错误。

---

## 低危（L）

- **L1** `LoopKernel.ts:109-121`：self-timer 提前触发分支（注释明说是应对合并/coalescing）消费掉 wake 后返回 still-waiting，却**不在 `fireAt` 重新调度**——一旦真发生，park 无限期搁浅直到手动 resume。补一句 `wakeStore.schedule({kind:'timer', fireAt: pending.fireAt})`（coalescing 保证幂等）即可。
- **L2** `LoopKernel.ts:277-279`：worker 声明 `label:'wait'` 却没给 effectKey 时内核生成随机 key——外部系统无从得知该 key，等待永不结束。应改为 corrective 重试而非静默补 key。
- **L3** `Seats.ts:259-285`：`extractData` 会从 summary 的最后一个 JSON 块兜底解析——worker 叙述性文本里出现 `{"label":"wait"}` 之类样例会被误当结构化结果。建议兜底解析只认 `label` 值合法的对象。
- **L4** `LedgerApi.ts:76-80` 头注释称 "appendJsonl appends a single **fsync'd** line"，实际 `appendFile` 并不 fsync；`atomicWriteJson` rename 前也无 fsync。进程崩溃安全成立，掉电持久性达不到注释承诺，改注释或加 fsync。
- **L5** `CharterStore.save`：读 latest → version+1 → 写，无锁；并发保存同 id 会撞出同一版本号并互相覆盖 latest。低频操作，套 `withFileLock` 即可。
- **L6** `createInstance`：写 instance.json 与调度首个 wake 之间崩溃 → idle 且无 wake 的"冻结"实例；重跑 create 因幂等直接返回旧记录、不补 wake。可在 load/reconcile 时对"idle 且无 wake"的实例补一个 timer wake。
- **L7** 校验器遗漏：`budgets.lifetime.usd/deadlineMs` 无正数/合理性检查（rounds 有）；多个 judge gate 时 `judgeEvidence` 只取第一个（对象序）。
- **L8** 终止报告的 `rounds:` 用 `progress.iteration`，预算前置守卫路径（轮尚未入账）会少显示 1（纯观感）。
- **L9** `src/loop/reduce/*`（CodeNode 冻结/审查/沙箱运行器，约 900 行）当前无任何调用方——按注释是等 v2 custom reduction 接线的保留件，建议在跟踪项里挂名，避免无声腐化。
- **L10** `ingestEvents` 对不可解析事件文件"原地保留、无日志"——每轮反复重试且不可发现，建议至少打一条 console.error 或挪到 `events/bad/`。

---

## 值得肯定的设计（保持）

- 九步轮管线全部宿主代码、tripwire 全轮**单点求值**（ROUTE）+ 一次性 pivot 指令，v3 不变式在代码与注释里可互相印证。
- Expr DSL：白名单文法、无 eval、冻结期 AST 化 + 未声明标识符静态拒绝、运行期严格类型（无 truthiness）；`safeEval` 的 fallback 语义（仅 meter incWhen 在失败轮回退 true）有明确论证。
- 校验器质量很高：可终止性强制（finalize tripwire ∨ lifetime 预算）、pivot⇔pivoter 双向绑定、observable 只认 judge 来源并给出教学式报错。
- EffectLedger 事件溯源 + `conclude` 先到先得作为 probe/event 去重点；`WaitOps.reconcileWaiting` 对 {pending × effect × wake} 三元组的崩溃修复枚举清晰（M2 所述窗口除外）。
- `withFileLock` 的 owner-token 释放校验与 rename 式陈旧锁抢占、`readJsonFile` 的 .corrupt 隔离，是文件级并发里少见的细致实现。
- judge/finalizer 无工具、证据内嵌定界（"independence is a property of its inputs"），隔离性是结构性的而非口头的。

## 建议修复顺序

1. H1（heartbeat 接线或 TTL 对齐）——一行架构决策消掉最贵的双跑风险；顺手 H2。
2. M1（inbox 单次消费）与 M6（judge fail-closed）——直接影响结果正确性，改动小。
3. M2 harvest 重放守卫、L1/L2 等待搁浅两处——补齐崩溃/等待故事的最后几个洞。
4. M5 沙箱 deny 清单、M4 状态迁移加锁、M7 路径修正。
5. 其余 L 项随手清理。

---
*评审基线：工作区当前代码（v0.6.0）；`npx vitest run src/loop` 18 files / 116 tests 全部通过。*

## 修复状态（2026-07-10 同日修复）

全部发现已修复并通过全量验证（vitest 145 files / 1082 tests 全绿，tsc --noEmit 干净）：

- **H1** `LoopKernel.runRound` 内以 60s 间隔对 wake claim 调用 `heartbeat()`（unref 定时器，finally 清理），租约在整轮期间保持新鲜。
- **H2** `daemon.acquireLock` 跨主机改为按锁文件 mtime 判活（5 min 阈值）；daemon 每次循环 `refreshLock`（utimes）刷新 mtime，覆盖长轮的 drain 路径。
- **M1** `consumeInbox` 从 CapsuleBuilder 导出；pivot 轮由内核消费一次并传入两次 `buildCapsule`（`BuildCapsuleInput.inboxMessages`）。
- **M2** `harvestSegment` 入口重放守卫：`progress.iteration >= pending.round` 时清 pending + markHarvested + 恢复调度，绝不重跑座位。
- **M3** `tickOnce` 改为从磁盘枚举实例（新增 `listInstanceRecords`），waiting 实例无 wake 时跑 `reconcileWaiting`；daemon 空闲判定把 waiting 实例计入保活。
- **M4** `setInstanceStatus` 套 `withFileLock` + `expectFrom`（锁内按磁盘状态校验）；pause/resume 接线；`lastEscalation` 支持原子设置/清除。
- **M5** worker 沙箱 deny 清单补 `eventsDir`、`inboxDir`、`<workspace>/.loop/wakes`。
- **M6** judge 崩溃（ok=false）轮内重试一次；`admitDrafts` 改 fail-closed（`judge.ok && verdict!=='fail'` 才入账）。
- **M7** migrate 缺省 WakeStore 根目录回退到 `dirname(dirname(paths.root))`（工作区）；`record.projectDir` 改写工作区路径（与字段文档一致）。
- **L1** self-timer 提前触发分支在 `pending.fireAt` 重新调度 timer wake。
- **L2** 无 effectKey 的 event wait：一次纠偏重试，仍缺则该轮判败；不再生成外部不可知的随机 key。
- **L3** `SeatResult.structured` 标记数据来源；`label:'wait'` 只认结构化 return_result，不认自由文本兜底解析。
- **L4** LedgerApi 头注释改为如实描述（单次 write、无 fsync、掉电容忍由 readJsonl 跳行承担）。
- **L5** `CharterStore.save` 的版本分配套 `withFileLock(latest.json)`。
- **L6** `tickOnce` 对 idle 且无 wake 的实例补 timer wake（自愈 create/completeRound 崩溃窗口）。
- **L7** 校验器：`budgets.lifetime.usd/deadlineMs` 正数校验；多个 judge gate 直接报错。
- **L8** `terminate` 未入账路径把 `progress.iteration` 对齐到终止轮号（与 rounds.jsonl 一致）。
- **L9** `reduce/index.ts` 头部加 TRACKING 注记（无调用方，随 v2 custom reduction 里程碑决定去留）。
- **L10** 不可解析事件文件隔离为 `.bad` 并 console.error，不再无声无限重试。

新增回归测试：`src/loop/__tests__/reviewFixes.test.ts`（M1/M2/M4/M6/M7/L1/L2，7 用例）。
