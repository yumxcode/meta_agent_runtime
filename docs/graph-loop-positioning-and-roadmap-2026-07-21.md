# Graph Loop 定位与下一阶段演进重点

日期：2026-07-21
更新：2026-07-22（补充“强 Agent 的持久化治理与协调内核”目标架构及可执行优化项）
性质：设计备忘（positioning + roadmap）。上承 `docs/reviews/graph-loop-audit-2026-07-19.md`、`docs/reviews/graph-loop-audit-and-remediation-2026-07-20.md`、`docs/reviews/graph-loop-audit-2026-07-21.md`（复审）。本文回答两个问题——这套机制的领域通用性边界在哪；LLM 持续变强之后它的长期价值是什么——并据此给出下一阶段的投入清单与明确的不投入清单。

## 零、北极星与目标架构

Graph Loop 的长期定位明确为：**强 Agent 的持久化治理与协调内核（Durable Governance & Coordination Kernel）**。它不是通用 Workflow DSL，不负责描述 Agent 内部的每个工作步骤；也不是帮助弱模型完成任务的脚手架，不以增加角色、节点和修复轮次来弥补模型能力。

目标结构是“内外双环”：

```text
强 Agent 内循环（开放、动态、随模型能力增强）
  自主规划 / 搜索 / 工具调用 / 子 Agent 并行 / 验证 / 上下文管理
                         │ 只在治理边界提交结构化事实
                         ▼
Graph Kernel 外循环（小而稳定、模型无关）
  journal / lease / wait-event / effect receipt / budget / lane / approval / terminal
```

Graph 节点边界只允许由以下事实之一成立：跨进程持久等待；不可逆 Effect；人工或监督 Agent 审批；Lane/权限所有权切换；独立预算或失败隔离；需要审计的确定性决策；业务终态。**仅有 prompt、角色名、工作阶段或模型内部计划不同，不构成拆节点理由。**

这一定义与当前源码结构一致：`GraphTypes.ts` 的 Agent/Function/Effect/Wait/Join/Terminal 是治理原语；`TransitionEngine.ts` 只根据 JSON 事实做确定性路由；`GraphKernel.ts`、`CommitCoordinator.ts`、`GraphStore.ts` 负责恢复、提交、等待与终态，而领域判断留在 Agent 和 provider。

目标架构分四个稳定平面：

1. **Execution Contract**：冻结图、结构化 State、确定性 Transition、Wait、Terminal、恢复协议。
2. **Trust & Ownership**：Lane 单写者、Workspace 路径、工具/能力锁、预算和审批。
3. **External I/O Contract**：Effect 幂等键/收据、事件 delivery/correlation、长作业回调。
4. **Evidence & Operations**：journal、timeline、可靠性画像、诊断、归档、升级与 handoff。

领域能力不通过新增 Kernel 节点实现，而通过 **Domain Capability Pack** 组合：原始事实 schema、纯 Function/Reducer、Effect provider、Ingress/correlation 约定、Lane/Workspace 模板以及场景 soak/chaos 夹具。这里的 Domain Capability Pack 是围绕现有 `GraphCapabilityPackV1` 的发布约定，不要求把 ingress、模板或测试塞进 Kernel pack API；只有 Function/Reducer/Effect 注册和 advisory scenario guidance 进入现有可执行包，其余作为同版本伴随资产发布。

## 一、定位判断

### 1.1 领域通用性的真实来源

durable-graph-v2 的通用性不来自节点类型丰富，而来自一个刻意的分层：Kernel 只表达必须确定执行的少量事实（持久状态、权限边界、等待点、确定性分支、终态），领域语义全部推给厚 Agent 节点与 Effect provider。因此判断"某领域 loop 能否落在这套机制上"，标准是三个归约问题，而不是"缺不缺某种节点"：

第一，该领域的控制决策能否归约为对 JSON 事实的确定性路由。科研迭代、代码维护、运维巡检、内容生产、工单处理均可；X1 实跑确认了正确姿势——路由用 Agent 产出的原始事实（`new_findings_count`、`trend`），不用预计算布尔值。归约不了的判断本就该留在厚 Agent 内部，不是图的失败。

第二，领域资源能否装进 Lane/Workspace/Effect 三个所有权模型。文件形态资源完全合身；外部系统走 Effect，但要明确：内核只保证"至少一次提交 + 首个持久收据权威"，exactly-once 的最后一公里是 provider 的幂等契约。跨领域可靠性的上限由各领域 Effect provider 的质量决定，这是通用性承诺必须带的星号。

第三，领域的并发形态是否匹配"静态拓扑 + 单写者 Lane"。这是最实的边界：运行期才知道 N 的动态 fan-out 不可表达，Lane 严格串行。多数决策型 loop 不受影响（厚 Agent 内部自行并行即可），但数据密集型领域（ETL、大规模爬取、批量评测）不是这套图的甜区，不应硬塞。

稳定可靠性结论（详见 07-21 复审及当前工作区）：commit 协议闭合；H1 已由每 tick 的 `reconcileWaitingJoins` 修复，H2 已由未知错误耗尽后落 `paused` 修复。控制协议在本地持久化部署边界内已经具备生产级骨架；下一道门槛不再是新增控制原语，而是存储分代、provider/ingress 契约和机器运维面。Join 仍建议配置 timeoutMs/maxWallTimeMs 作为领域语义死路的保险，但不再依赖它修复 post-commit 信号丢失。

### 1.2 LLM 变强之后，什么贬值、什么不贬值

会贬值的：细粒度多节点任务分解（未来一个厚节点顶今天五个）；Distill 的编排复杂度（多轮修复预算随模型变强缩水）；部分防呆护栏。

不贬值的是四类基础设施属性——它们的共性是与智能水平零相关：

1. **持久性是物理问题。** 模型再强也活在进程里；30 天的 loop 需要 journal、lease、durable wake。等待的经济学更是如此：等 30 天后的事件不该占一个进程和一个 context window，hard park 让睡眠接近零成本——模型越强、接的长任务越多，此价值越大。
2. **信任边界随能力增强而更重要。** maxCostUsd、Lane 单写者、`.git/hooks` 保护是治理设施；更强的 Agent 意味着更大行动半径，需要更硬的爆炸半径控制。
3. **可审计的确定性是组织问题。** 同一输入与事件序列得到同一结果、路由落在声明过的事实上、journal 可回放——是事后回答"为什么走了这条边"的唯一方式；"模型判断的"不构成审计答案。
4. **多 Agent 并发协调是系统问题。** 单体变强不改变"两个 Agent 不能同写一个文件"；未来更可能是多个强 Agent 协作，协调内核价值上升。

类比：人类是最强的长时程 Agent，公司仍靠账本、合同、审批流、检查点运转。这套 loop kernel 是给 Agent 的**制度层**，不是拐杖。07-20 定下的四条约束（不加节点类型、不做第二套 DSL、不逼 Agent 压缩工作过程、不为可证明性拆厚 Agent）正是对"LLM 会变强"下的注。终局形态：图收缩为"少数厚 Agent + 等待点 + 预算 + 终态"的极简合同；Distill 从编译器退化为合同起草助手；Kernel 成为长存资产。

### 1.3 可靠性承诺必须分层

“Graph Loop 稳定可靠”不能作为无条件总承诺，应拆成四层：

- **控制协议可靠**：Kernel 对 journal/intent/lease/continuation/terminal 的提交与恢复负责；P0 后此层基本闭合。
- **外部交互可靠**：Kernel 保证 Effect intent 先持久化和同幂等键至少一次提交；业务 exactly-once 由 provider conformance 决定。Event 的生产可靠性还依赖 ingress 鉴权、限流和 deliveryId。
- **部署介质可靠**：当前 `atomicWriteJson` 是 write-then-rename，没有掉电级 fsync；默认承诺应限定为本地 POSIX 文件系统上的进程崩溃恢复，不宣称分布式共识或掉电零丢失。
- **领域结果可靠**：Kernel 只能约束输出 schema、行动边界和控制闭环，不能保证 Agent 的研究、代码或业务判断正确；该层由 Domain Pack、验收器与人工/监督 Agent 共同承担。

为避免笼统承诺，下一阶段为每个冻结图生成机器可读的 **Loop Reliability Profile**：bounded/continuous、wait 活性兜底、state consistency、Effect conformance、event delivery 语义、workspace enforcement 等级、durability 等级、audit retention、已通过的 soak/chaos 版本。`loop inspect --json` 应直接暴露该画像。

## 二、下一阶段演进重点

按优先级分四档。原则只有一条：**加固不贬值的（Kernel 不变量、权限媒介、长周期运行能力），冻结会贬值的（图 DSL、Distill 结构），任何"让图承载更多领域结构"的提案默认拒绝。**

### P0 内核正确性基线（核心项已落地）

1. **H1 已完成：Join 确定性对账。** `GraphKernel.tick` 在 `resumeDue(now)` 后调用 `reconcileWaitingJoins`，对 waiting Join 按与 `executeJoin` 相同的 barrier、leader、event/correlation 判据重算；回归测试覆盖 post-commit resume 信号丢失后仍收敛到 done。
2. **H2 核心已完成：未知错误 fallback 改 paused。** runner 耗尽 5 次重试后落 `paused`，`failed` 只留给 `isDeterministicGraphError` 白名单。剩余优化是把 lease-lost / lock-timeout 与普通 unknown failure 分开计数，避免一次持续锁抖动过快耗尽同一 wake 的 attempts。
3. **静态活性保护已完成。** `unbounded-wait` 对“有 total cap、无 graph wall limit”的 event Wait/Join 无 timeout 给 warning；持续图允许有意无限等待。剩余非阻塞清理是修正 `ActivationRecord.replayCount` 关于 lease expiry 的注释。

### P1 长周期运行能力（下一阶段主线：让"跑数月"从理论变成运维现实）

4. **存储回收：`loop gc`。** checkpoint 之前的 journal 段归档压缩（保留可导出 tar 以维持审计承诺）；终态实例的事件与 wake 清理；永不匹配的 pending 外部事件按保留期过期。这是月级实例线性磁盘增长的唯一解，也是"制度层"叙事（可审计）能否长期成立的前提。
5. **Effect provider 幂等契约测试套件。** 既然 exactly-once 的最后一公里下沉给 provider，就给 provider 作者一套一致性测试（重复 submit 同幂等键、崩溃后重放、非确定收据字段），作为接入门槛。跨领域可靠性的星号由此变成可验收条款。
6. **事件 ingress 参考实现。** 生产 webhook 接入的鉴权、限流、payload 上限、deliveryId 规范化留在接入层是对的，但应给一个参考适配器（如 github webhook → `deliverEvent`），把"接入层自己负责"从一句话变成可复制的样板。
7. **Loop Reliability Profile。** Freeze/Create 生成可靠性画像，CLI/库 API 以稳定 JSON schema 输出；未通过 provider conformance、无活性兜底或只具语义级 workspace mode 的图必须明确降级标识，而不是共享一个“production ready”标签。
8. **领域场景包成为发布门。** 研究迭代、常驻运维、长外部作业三类参考 loop 不只用于示例，还要分别绑定 kill-restart、wake 丢失、事件重投、Effect 重放和预算耗尽测试。以后 Kernel 改动必须证明没有破坏这三类控制合同。

存储验收必须区分热层和冷层：hot checkpoint、snapshot 延迟和散文件数量可以有界；若完整审计永久保留，cold archive 总量必然随事件数线性增长，只能压缩或外送对象/WORM 存储。路线不再同时承诺“完整历史永久保留”和“本地总磁盘永久有界”。

### P2 信任边界加固（跟随 Agent 能力增强的节奏，按需推进）

9. **workspace 写模式的 OS 级媒介。** `append_only/atomic_replace` 对任意 bash 仍是语义合同；当需要把它提升为对抗性边界时，在 seatbelt/bwrap 层加操作级控制，而不是扩 Graph 字段或做 shell 文本解析（07-20 已有此结论，此处确认为 P2 方向）。Reliability Profile 必须区分 cooperative 与 os_enforced。
10. **软预算暂停与硬保险丝分离。** 可续期的运营 quota 进入保留 Activation 的 budget pause；不可突破的安全上限才进入不可逆 `exhausted`。预算扩展是 journal 化授权记录，不允许静默改 frozen spec。当前 `exhausted` 会取消 live Activation，因此不能仅增加一条 extension 记录后原地复活。
11. **预算与审计的操作面。** 实例级成本/turns 的运行中可观测、超预算前的预警和诊断。关键治理预警不能只依赖 fail-open 的 GraphProgress listener：至少可从持久状态推导；若要主动通知，使用持久 outbox。
12. **受控升级与 handoff。** 月级实例会遇到模型、prompt、Capability 和 Graph 版本变化。单实例继续保持 graphHash 冻结；升级走 checkpoint/export → 显式 state migration → 新实例 → 审批切换，不做运行中任意改图。

### 有条件项（出现真实需求才做，默认不做）

- **`wait.at` 绝对时间等待。** 仅当出现真实跨时区日历需求；实现为一个小型持久能力，不引入 cron DSL。
- **动态 fan-out。** 数据密集型场景若成为真实业务，优先考虑"厚 Agent 内部并行 + Effect 外包给批处理系统"，而非扩图。若最终必须做，形态应是单一受限原语（如 map-over-state-array + 既有 join），且需重新评估 Lane 所有权模型——在此之前不设计。
- **掉电级 fsync。** 按部署形态的真实数据丢失容忍度决定。
- **受控图升级。** 只有月级实例确实需要不停机迁移时实现；默认以新实例 handoff 满足，不引入可变拓扑。

### 明确不做项（对会贬值的资产不加仓）

- 不新增节点类型；不做第二套 Graph/Blueprint DSL；不做计划结构字段。
- 不为静态可证明性拆分厚 Agent；`same-lane-agent-split` 保持 warning + 语义核验，不升级为硬禁止。
- Distill 保持当前六层准入 + 局部修复闭环，不再增加角色或轮次；随模型变强允许其萎缩。
- 不在 Kernel 内做领域语义（重试策略模板、领域事件类型等），一律留给厚 Agent 与 capability pack。
- 不把模型内部计划、完整思维过程或逐工具调用同步进 Graph State；只提交治理所需的最小结构化事实和收据。

## 三、验收口径

下一阶段结束时应能回答"是"的问题：任一使用 join 的图在注入 resumeDue 失败与进程崩溃后仍收敛到终态；任一实例在连续基础设施抖动后处于可 resume 的 paused 而非 failed；一个跑满 90 天的模拟实例 hot checkpoint、快照耗时与散文件数量有界，cold journal 可导出审计并按 retention 外送/清理；一个第三方 Effect provider 能通过幂等契约测试后接入；一个监督 Agent 仅凭稳定 JSON API 和 Reliability Profile 能解释当前风险并完成 pause/diagnose/resume。达成后，才能在画像声明的边界内承诺“控制协议可靠、长程运行稳定”，而不是对所有领域结果做无条件保证。
