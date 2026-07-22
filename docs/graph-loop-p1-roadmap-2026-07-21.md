# Graph Loop P1 迭代路线：面向多领域长程 Loop

日期：2026-07-21
更新：2026-07-22（按“强 Agent 的持久化治理与协调内核”重新校准验收口径）
性质：P1 详细设计路线。上承 `docs/graph-loop-positioning-and-roadmap-2026-07-21.md`；基于 P0 完成后的工作区源码精读（`src/loop/graph/runtime/**`、`runner.ts`、`cli.ts`、`CapabilityRegistry.ts`、`WakeStore.ts` 及未提交 diff）。

## 零、P1 的产品目标

P1 不以“支持更多节点和流程形状”为成功标准，而以“强 Agent 可以在明确治理边界内连续工作数月”为标准。强 Agent 自己拥有开放内循环；Graph 只在 durable wait、Effect、审批、Lane handoff、预算和终态边界介入。

P1 必须同时交付五类可验证合同：

1. 热执行状态有界，不因历史增长拖慢当前 tick；
2. 外部副作用和事件接入有明确、可测试的 delivery 语义；
3. 监督 Agent 获得稳定的机器运维面；
4. 每个冻结图有 Reliability Profile，而不是共享笼统的“生产可用”标签；
5. 三个领域夹具持续证明 Kernel 没有侵入领域语义，也没有破坏恢复不变量。

## 一、P0 落地核对与前提刷新

本轮先核对了 P0 的实际落地，全部确认，且有三处超出原建议范围，直接改变 P1 的问题定义：

1. **H1 修复到位且形态正确。** `CommitCoordinator.reconcileWaitingJoins` 在每个 tick 对 waiting 的 Join 成员按 `executeJoin` 同一判据重算 barrier 完备性，leader 判定、event 名与 correlation 校验齐全；`GraphKernel.tick` 在 `resumeDue` 后调用。post-commit 通知窗口从"依赖信号送达"变为"每 tick 可自愈"。
2. **H2 核心修复到位。** runner 对非确定性错误耗尽重试后落 `paused`（带可操作的 statusReason 与 `loop resume` 提示），仅白名单确定性错误落 `failed`。但当前 wake attempts 仍在 claim 时统一递增；lease-lost / lock-timeout 尚未获得独立的瞬态计数策略，可作为 runner 稳定性小项并入 P1.1 chaos 验证。
3. **超出范围之一：`exhausted` 第三终态。** 预算/限额耗尽（lifetimeBudget、maxCostUsd、maxParks、serializable replay 上限、maxPendingTimers）与"失败"语义分离；且图可以**选择性路由 `exhausted` outcome** 做优雅收尾（decideTransition 找到路由则走图，找不到才直接进入 exhausted 终态）——这是正确的设计。Terminal 仲裁序更新为 failed → exhausted → paused → done，保守性保持。
4. **超出范围之二：连续型 loop 首次可表达。** `maxActivations` 弃用，拆为可选的 `maxTotalActivations`（生命周期上限）与 `maxLiveActivations`（在飞上限）；只声明后者即为**无生命周期上限的常驻反应式 loop**。配套 `unbounded-wait` lint 把"有界图无超时等待"识别出来。
5. **超出范围之三：新 lint 四条**（unbounded-wait、mixed-snapshot-routing、static-effect-idempotency、terminal-fanout-cancellation），把上一轮审计的多个"语义死路只能靠人"的项变成了机械检查。

三个顺手记录的小项（非阻塞）：`GraphStore.writeCommitProjectionLocked` 中 cancelled 投影写了两遍（幂等无害，删一行）；`exhausted` 目前不可 resume（`isFinalStatus` 单调拦截），这引出 P1 的一个设计决策（见 §七）；`ActivationRecord.replayCount` 注释仍把 lease expiry 归为不消耗 attempt，与当前 `releaseExpiredClaims → readyReason:'retry'` 不一致，应修正文档注释而不改变代码策略。

**前提刷新**：连续型 loop 可表达之后，长程运行的绑定约束发生转移。内核正确性已收口；现在最先撞墙的依次是——**存储有界性**（一个常驻 loop 的 checkpoint/journal/activation 集合线性增长）、**外部世界接口的可靠性**（Effect 幂等与事件 ingress 是多领域接入的真实门槛）、**运维面的可操作性**（强 agent 假设下，loop 的操作者本身往往是 agent，运维面必须机器可读）。P1 的五个工作流由此展开。

## 二、工作流 A：存储分代与回收（P1 的第一优先级）

### A0 问题的源码定位

当前 `GraphStore.reconcileLocked` 的热集合是**全量**的：`checkpoint.json` 携带全部历史 activation 记录，每 50 个 journal 事件重写一次；`snapshot()` 每次构建全量 `Map`。对有界图（几十个 activation）无感，但对刚刚变得可表达的连续型 loop，这是 O(总迭代数) 的内存、O(总迭代数) 的 checkpoint 重写和线性增长的磁盘（journal 文件、commit-intents、effect-intents、events 均不修剪）。**先于磁盘撞墙的是 checkpoint 重写放大**：一个日迭代 100 次、跑 90 天的 loop，每次事务要序列化约 1 万条 activation。存储分代不是"运维优化"，是连续型 loop 能否成立的前置条件。

### A1 Activation 退休（hot/cold 分代）

设计：终态 activation（succeeded/failed/cancelled）在满足**保留不变量**后移出热集合，追加写入冷存 `graph/retired/<segment>.jsonl`，checkpoint 只保留热集合与保留标记。保留不变量逐条对照现有读取方：

- **commitKey 幂等**（`commit` 去重）：只需 `commitKeys` 索引（key→sequence），不需要 activation 记录本体。索引本身随 intent 文件清理同步修剪（见 A3）。
- **Join 迟到去重**（`commit` 中 "existing succeeded activation 同 node+forkGroup" 检查）：退休时为每个 (joinNode, forkGroupId) 留一条紧凑标记 `joinCompleted` 集合，替代全记录扫描。
- **`reconcileWaitingJoins` / `executeJoin` 的 candidates 扫描**：只涉及 ready/running/waiting，天然在热集合内，不受影响。
- **paused Terminal 恢复查找**（`resumePausedTerminal` 找最近 succeeded 且未 resumed 的 paused terminal）：paused 实例冻结退休，或对 paused-terminal activation 豁免退休。
- **审计/timeline**：`loop timeline` 与 `loop files` 透明读取冷存段。

退休时机：commit 事务内不做；由 tick 末尾的低频维护步（如每 N 次 tick 或热集合超过阈值时）在独立事务中执行，journal 记录 `activations_retired` 事件保证可重放。schema 升级为 `graph-checkpoint-3.0`，读取端兼容 2.0（首次维护时迁移）。

### A2 Journal 段归档与保留分层

`sequence <= checkpoint.lastSequence` 的 journal 文件按段（如每 500 个）打包为 `graph/journal-archive/<from>-<to>.tar.zst`。删除原文件前的安全序：新 checkpoint 落盘并被下一次 `reconcileLocked` 读通过 → 归档包写入并校验清单 → 删除段内散文件。`readJournalRangeLocked` 遇到缺段时回退读归档（仅 timeline/审计路径需要；正常执行路径永远在 checkpoint 之后）。"同一输入同一结果可审计"的承诺由归档保持，`loop archive` 导出时携带归档段。

必须明确三层保留语义：hot 是当前执行所需的有界状态；cold 是本地压缩审计段，仍会随事件数线性增长；external archive 是按租户 retention 外送的对象/WORM 存储。若要求永久保留完整 journal，就不能同时承诺本地总磁盘永久有界。P1 的容量指标改为 hot bytes、loose file count、snapshot latency、cold bytes/event 和 externalization lag。

### A3 事件 inbox 与 intent 保留

- pending 外部事件超过保留期（图级可选 `limits.eventRetentionMs`，默认 30 天）转 `expired` 状态并journal 记录——不是静默删除，`loop events`（新增命令，见 D）可查。已 consumed 事件随 journal 段归档。
- `commit-intents` 中 status 为 committed/discarded 且 journalSequence 已进入归档段的文件删除（恢复只依赖 prepared）；`effect-intents` 中 succeeded/failed 且对应 activation 已退休的删除。

### A4 `loop gc` 与 `loop disk` 扩展

现有 `gc` 只清终态 wake 与过期 archive。扩展为对**活跃实例**执行 A1-A3 的维护（`loop gc --instance <id> --apply`，daemon 每小时的 prune 钩子同点触发），`loop disk` 按分代报告（hot checkpoint / journal 散文件 / 归档 / 冷存 / intents / events），并输出增长速率估计。

### A5 验收

模拟时钟 soak（`now()` 注入已全线可用）：连续型 loop 跑模拟 90 天、≥5 万 activation，断言 (1) hot checkpoint 文件尺寸与 `snapshot()` 耗时有界且平稳；(2) loose journal、intent、activation projection 文件数有界，cold archive 的 bytes/event 低于目标值并可外送；(3) 中途任意点 kill-restart，恢复正确；(4) `loop timeline` 对本地或外部归档段仍可完整回放。不得再以“总磁盘次线性”描述完整审计历史。

## 三、工作流 B：Effect 契约与长时外部作业

### B1 Provider 一致性测试套件

Effect 的 exactly-once 最后一公里在 provider（`submit(input, idempotencyKey)` + 可选 `inspect(receipt)`）。新增可导出的 conformance harness（`runEffectProviderConformance(provider, fixtures)`），用例覆盖：同幂等键重复 submit 不产生第二次副作用；submit 成功但收据未落盘后的重放（模拟 `recordEffectReceipt` 前崩溃）；收据含非确定字段时首收据权威语义不被破坏；inspect 的 pending→succeeded/failed 状态机；输入变更时 `prepareEffectIntent` 的冲突拒绝。作为第三方 provider 的接入门槛写入文档，内置 provider 全部过套件。

### B2 长时作业的完成回调模式

现有 inspect 轮询（30s 封顶）适合分钟-小时级作业；天-周级作业应改为"Effect 提交 + Wait event 接收完成回调"的组合模式。**不加节点类型**——以文档确立标准形态：effect 节点输出 receipt → 下游 wait{event} 以 receipt 中的作业 ID 为 correlation → ingress 适配器（工作流 C）把外部完成通知投递为该事件。给一个完整参考图示例放入 `scenarios/`。

### B3 inspect 退避的 provider 提示

`inspect` 返回值增加可选 `retryAfterMs`；`executeEffect` 的轮询 park 优先采用 provider 提示，并由宿主配置最小/最大轮询间隔，最终不超过 `timeoutMs` 剩余量。当前源码使用 `Math.min(remaining, 30_000)`，实际是“最多等待 30 秒”，对天级任务仍会高频轮询；P1 不能继续把 30 秒作为上限。天/周级任务的首选仍是 B2 callback，`retryAfterMs` 只是兼容模式。

## 四、工作流 C：事件 ingress 参考实现

- **C1 参考 webhook 适配器**（`examples/ingress/`，不进内核）：HTTP 端点 → HMAC/签名校验 → 提取 `source`/`deliveryId`（如 GitHub 的 delivery header）→ payload 上限预检 → `kernel.deliverEvent` → 失败重投说明。内核侧已有的去重（`source+deliveryId` sha 幂等）、1MB 上限、timeout-first-wins 语义在文档中作为契约声明。
- **C2 事件运维命令**：`loop events <id> [--status pending|consumed|expired]` 列出 inbox；`loop event` 增加 `--replay <eventId>`（对崩溃窗口的 pending 事件手工触发重匹配，语义等同 redelivery）。
- **C3 关联约定文档**：每领域的 correlation 取值规范（作业 ID、PR 号、工单号），与 B2 的回调模式合并成一篇《外部世界接入指南》。

## 五、工作流 D：Agent 可操作的运维面（强 agent 假设的直接推论）

长程多领域 loop 的日常操作者将是监督 agent 而非人。运维面按"机器优先"改造：

- **D1 全命令 `--json` + 库 API**：`list/inspect/timeline/disk/events` 输出版本化结构化 JSON（含 statusReason、预算余量、下一 wake、热集合规模），同一 schema 也由库 API 暴露，避免监督 Agent 绑定人类文案。
- **D2 可恢复的预算治理**：预算达到 80% 时，`inspect --json` 必须能从持久状态推导 warning；若提供主动通知，使用持久 outbox，不能只依赖当前 fail-open 的 GraphProgress listener。可续期运营 quota 到顶进入 budget pause，保留 Activation；不可突破的安全上限才进入不可逆 `exhausted`。
- **D3 诊断卡片**：`loop inspect` 对 paused（H2 落的瞬态暂停）与 exhausted 实例输出"发生了什么/建议动作"的结构化块（原始错误、重试历史、可执行的 resume/gc/event 命令），把 07-19 以来审计报告里的人工排障知识固化为输出。

### D4 Loop Reliability Profile

Freeze/Create 生成并持久化版本化画像，至少包含：

- graph class：bounded / continuous；
- liveness：每个 Wait/Join 的 timeout、wall limit 或 intentional-unbounded 说明；
- concurrency：commit_latest / serializable 及相关 lint；
- effect：每个 provider 的 conformance 版本与最后通过时间；
- ingress：鉴权适配器、deliveryId、correlation、payload/retention 策略；
- workspace：path-enforced / operation-mode-cooperative / os-enforced；
- durability：process-crash-local-posix / fsync 等级；
- audit：hot/cold/external retention；
- evidence：通过的场景、soak、chaos 版本。

Reliability Profile 是事实清单而非评分。任一关键项 unknown 或 degraded 时，`inspect` 必须明确显示，不允许仍输出统一的“production ready”。

## 六、工作流 E：长程演练与领域场景包

- **E1 Soak/chaos harness**：A5 的 90 天模拟时钟 soak 泛化为可复用 harness；chaos 注入点包括事务锁超时（复验 H1 对账）、tick 中途 kill、wake 丢失（复验 prepareAndClaim 重建）、事件重投。进 CI 的缩短版（模拟 7 天）每日跑。
- **E2 三个领域参考 loop**（`scenarios/`，作为通用性主张的回归夹具）：
  1. **常驻运维监控**（连续型：`maxLiveActivations` 无 total 上限，event 驱动 + 周期巡检 + exhausted 优雅收尾路由）；
  2. **研究迭代**（有界收敛型：X1 真值表模式泛化版，三态 trend 路由）；
  3. **长训练监督**（分段型：Agent hard-park + Effect 长作业回调 + 人工介入 paused terminal）。
  每个夹具带 soak 断言，三类合起来覆盖 8 类场景矩阵的全部机制。

### E3 Domain Capability Pack 合同

三个参考 loop 同时给出可复制的领域包布局：原始事实 output schema、Function/Reducer、Effect provider、Ingress/correlation、Lane/Workspace 模板和测试证据。它是围绕现有 `GraphCapabilityPackV1` 的发布约定：可执行包继续只注册 Function/Reducer/Effect 和 advisory scenario guidance，Ingress、模板、conformance 与 soak 证据作为同版本伴随资产，不扩 Kernel pack ABI。领域扩展的评审问题变为“这个 pack 是否满足 Kernel 合同”，而不是“Kernel 是否还缺一个领域节点”。以后新增领域至少复用一个现有控制形状；若必须修改 Graph ABI，需要独立架构评审证明该需求无法放进厚 Agent、Effect 或外部批处理系统。

## 七、需要拍板的设计决策（P1 期间决定，不阻塞开工）

1. **软预算暂停与 `exhausted` 的边界。** 当前 `GraphStore.setStatus(exhausted)` 和 commit exhaustion 会取消 live Activation，单加 `budget_extension` 无法安全复活原工作。建议：运营型 quota 到顶进入可恢复的 budget pause；扩额以 journal `budget_extension` 授权后 resume。安全硬上限仍进入不可逆 `exhausted`，或者由图显式路由 exhausted 做优雅收尾。若坚持恢复 exhausted，就必须设计 Activation suspension/resurrection 协议，复杂度和审计风险明显高于 budget pause，默认不选。
2. **checkpoint 3.0 的迁移窗口**：是否支持 2.0 只读回退（建议：读兼容一个版本，写只出 3.0）。
3. **事件保留期的归属**：图级 `limits.eventRetentionMs` vs 宿主级配置（建议图级可选、宿主给默认，与其余 limits 一致）。
4. **可靠性画像的签发时机**：建议 Freeze 生成静态部分，Create/Runtime 补充 provider、ingress、sandbox、durability 和 evidence；两部分都有 schema version 和生成时间。

不进入 P1 实现、但要完成设计定稿的一项：**受控升级/handoff**。单实例继续绑定 frozen graphHash；未来采用 checkpoint/export → 纯迁移函数 → 新 graph/version instance → 审批切换，不允许强 Agent 在原实例中任意改拓扑或 capability lock。

## 八、迭代排期与验收口径

| 迭代 | 内容 | 退出标准 |
|---|---|---|
| P1.1（存储） | A1-A5 + E1 harness 骨架；顺手清理 §一的两处小项 | 90 天模拟 soak 通过：hot checkpoint/快照耗时与 loose files 有界、cold bytes/event 达标并可外送、任意点崩溃恢复正确、timeline 可回放归档段 |
| P1.2（外部世界） | B1-B3、C1-C3、E3 pack 合同 | 内置 provider 全过 conformance；参考 ingress 对重投/签名失败/超限 payload 行为符合契约；B2 参考图在 soak 中完成一次天级模拟回调闭环 |
| P1.3（运维面与场景包） | D1-D4、E2、§七决策落地 | 三个领域夹具进 CI 每日 soak；监督 agent 仅凭版本化 JSON + Reliability Profile 完成 pause→诊断→扩额授权→resume；降级项可被机器识别 |

P1 总验收（对齐 positioning 文档的口径并升级）：一个**无生命周期上限的连续型 loop** 在模拟 90 天内热状态有界、冷审计可外送、崩溃可恢复、预算可预警且软耗尽可治理；第三方 Effect provider 凭 conformance 套件自助接入；三个领域夹具证明 8 类控制场景在真实图上闭环；每个实例能给出机器可读的可靠性边界。达成后，“多领域长程 loop”成为有证据的控制协议承诺，但仍不等同于对 Agent 领域判断正确性的保证。
