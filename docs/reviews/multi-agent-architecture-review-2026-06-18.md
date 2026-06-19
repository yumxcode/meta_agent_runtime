# Meta-Agent 多智能体（multi-agent）架构审查

审查日期：2026-06-18 · **仅审查，未改动代码**
关注点：多智能体的协作原语、隔离边界、调度与背压、故障与预算控制、三套协作机制的一致性。
证据来源：`src/subagent/`、`src/coordination/`、`src/robotics/team/`、对应 agent 工具与既有架构文档。

---

## 0. 总览

代码里其实有**一个生成原语 + 三套协作形态**，它们各自解决不同问题，但共享度不高：

| 形态 | 位置 | 拓扑 | 通信 | LLM? | 用途 |
|---|---|---|---|---|---|
| **A. 层级委派** | `subagent/` | 父 → 子（隔离 session） | 类型化 status/result + 事件总线 | 是 | 通用子任务委派 |
| **B. 并行评估** | `coordination/` | 主控 → N 个 worker | 文件状态轮询 + capsule 注入 | **否**（确定性） | DOE/Pareto 设计点并行评估 |
| **C. 对等协作** | `robotics/team/` | 多个独立进程对等 | git 共享 `team.json`（乐观锁 + 抢占） | 各自是 | 多 lab 实例共享"实验记录本" |

三者都建立在 `SubAgentBridge`/`SubAgentRunner` 的隔离 session 原语之上（B、C 通过工具间接用，A 直接用）。

**核心判断**：A 这层设计成熟、健壮性细节扎实（断路器、预算账本、worktree 隔离、自动重试、abort 传播都到位），是整个多智能体体系的地基。主要架构债在**三套形态缺乏统一抽象**、**事件总线命名/作用域错位**，以及若干**单进程 / 单层级的隐含约束没有显式表达**。

严重度：**[高]** 结构性/正确性风险；**[中]** 局部耦合或约束未显式化；**[低]** 整洁度。

---

## 1. 生成原语：SubAgentBridge / SubAgentRunner（形态 A）

### 1.1 做得好的地方
- **隔离是真隔离**：子 agent 以空 `mutableMessages` 启动，父子只通过 `SubAgentRecord` 的 status/result 交换，不共享对话历史（`types.ts` §设计不变量 1–4）。这是正确的边界。
- **断路器在代码而非 prompt**：`maxTurns` / `maxBudgetUsd` / `maxDurationMs` 由 runner 强制执行，不依赖模型自觉。
- **预算账本严谨**：`reservedBudgetUsd` + `settledCostUsd` 的预留/结算两段式，spawn 时预留、终态时结算；内部安全门任务（`internal`）完全不计入共享上限并插队，保证门一定能起。这是经过推敲的设计。
- **背压不丢信息**：通知溢出时 `mergeOverflowNotifications` 合并成一行并保留累计计数，不静默丢弃子 agent 结果。
- **abort 传播正确**：处理了"已 abort 的 signal 不再触发 listener"这个易错点（`M5-fix`），父 turn 被打断时在途子 agent 会被取消。
- **自动模式监狱（autonomy jail）**：`_applyAutonomyJail` 强制 fail-closed 沙箱 + 工作区 jail，堵住了 `run_agent` 的逃逸口；`isolated_write` 失败时 fail-closed 抛错而非静默退回共享树（避免假隔离保证）。

### 1.2 [高] 静态 bridge Map 的内存泄漏靠约定兜底
`SubAgentBridge._bridgesBySessionId` 是 `static` 强引用，注释自己也标了 "⚠ Memory leak risk … callers MUST call destroy()"。一旦某条 session 路径漏掉 `finally { bridge.dispose() }`，bridge 连同 runner/timer/listener 会留到进程退出。

构造点有三处（`RoboticsSession`、`SessionRouter`、测试）。建议：要么用 `FinalizationRegistry`/弱引用兜底，要么把"创建即注册清理"收敛进一个工厂，避免每个调用点各自负责生命周期。当前是"正确但脆弱"。

### 1.3 [中] 多智能体被隐式限制为单层级，但没有显式表达
`SubAgentRunner` 构造内层 `MetaAgentSession` 时**不注入 bridge**，因此子 agent 实际上无法再 `spawn_sub_agent`/`run_agent`（工具需要 bridge）。这其实是个**好的安全默认**（避免无界递归 fan-out），但：
- 没有 `depth`/`maxDepth` 字段，也没有注释把它作为有意约束写下来——现在是"凑巧不能"，不是"设计上不能"。
- 一旦将来给子 agent 也注入 dispatcher，就会立刻获得无界递归能力且无任何深度/总量保护。

建议在 `SubAgentRecord` 加 `depth` 并在 spawn 处显式 `if (depth >= MAX) throw`，把隐式约束变成显式不变量。

### 1.4 [中] `run_agent` 的"同步"是轮询 + 墙钟封顶模拟的
`run_agent` 用 `useEventDriven=false` + `pollIntervalMs:500` + `MAX_WAIT_MS = maxTurns*2min` 来"阻塞等待"。功能上没问题，但同步语义建立在异步基础设施 + 轮询之上，`MAX_WAIT_MS` 与子 agent 自身 `maxDurationMs` 是两套独立超时，可能不一致（外层等待超时但内层仍在跑）。建议让同步路径直接 await runner 的完成 Promise，而不是轮询磁盘记录。

---

## 2. 事件总线：命名与作用域错位

### 2.1 [高] `CampaignEventBus` 实际是 subagent 的总线
它位于 `src/subagent/CampaignEventBus.ts`，承载 `subagent:completed/failed/checkpoint` 以及 `phase:transitioned`。但名字叫 "Campaign"，让人以为属于 `coordination/` 的 campaign 子系统。实际 campaign（形态 B）走的是 `CampaignStateStore` 文件轮询，根本不用这个总线。这是命名债，会持续误导读者判断模块归属。建议改名 `AgentEventBus` 或 `RuntimeEventBus` 并移出 subagent 专属目录（它是跨切面单例）。

### 2.2 [中] 单进程是硬约束，且被三套形态共同依赖
总线是进程内 `EventEmitter` 单例（文件注释已声明 "single-process only"）。这意味着形态 A 的父子通知**不能跨进程**。而形态 C（robotics team）恰恰是**多进程对等**模型——它绕过总线、用 git 文件协调，正说明总线的单进程局限。两套机制各自为政：进程内用 EventEmitter，跨进程用 git 轮询，中间没有统一的"消息层"抽象。短期可接受，但若要做 §7.2 提到的 daemon 模式，需要把总线抽象成接口（内存实现 + IPC 实现）。

### 2.3 [低] `setMaxListeners(100)` 是魔法数兜底
说明总线上挂的监听者数量未被结构性控制（每个 bridge + 每个 runner + loop controller 都挂）。配合 1.2 的泄漏风险，监听者只增不减时这个上限本身也会成为隐患。listener 的注册/注销应与 bridge 生命周期严格配对（`_onCompleted/_onFailed` 已 off，但需确保所有路径都走到 destroy）。

---

## 3. 并行评估子系统（形态 B：coordination/）

### 3.1 做得好的地方
- **Monitor 零 LLM、确定性**：`CampaignMonitor` 纯轮询 + `ParetoAnalyzer`，后台跑、可并发监控多个 campaign、`watchAsync` 幂等。把"协调"与"推理"彻底分离是对的。
- **故障隔离**：`WorkerCoordinator` 单点失败不中断整批；task ID 由 `workerId+index+hash` 稳定派生，幂等重试安全。
- **上下文成本 O(1)**：结果经 `CapsuleBuilder` 压成 <500 token 的 capsule，经 `MetaAgentContextStore` 注入下一轮 session，与 campaign 规模无关。这是很好的 context 工程。

### 3.2 [中] 两套并发限流各写各的
`WorkerCoordinator` 用自己手写的信号量（默认 4），`SubAgentBridge` 用自己的队列调度（默认 4 / auto 3）。两套限流互不知情：当 campaign 的 worker 内部又去 spawn 子 agent 时，真实并发是两者乘积，没有全局并发预算。对 CPU/网络/provider 限流来说，缺一个统一的并发与配额中枢。

### 3.3 [中] 24h 轮询上限 + 5s 间隔的长尾成本
`MAX_POLL_DURATION_MS = 24h`、`POLL_INTERVAL_MS = 5s`。长 campaign 下这是大量空转轮询。形态 A 已经有事件总线，形态 B 却仍纯轮询——如果 worker 走的是 subagent 原语，本可以复用 `subagent:completed` 事件改成事件驱动，省掉轮询。

---

## 4. 对等协作子系统（形态 C：robotics/team/）

### 4.1 做得好的地方
- **单一事实源 + 派生视图**：`team.json` 是唯一真相，`board.md/log.md/goals.md/README.md` 每次写时从它重生成。读写职责清晰。
- **乐观并发 + 显式抢占**：写前用 `updatedAt` 快照重校验，冲突即抛由调用方重试；`task.ownerUnit` 当锁，`steal()` 作为留痕的逃生口。对"多人/多 agent 抢同一任务"建模合理。
- **协调器从 god-object 中抽离**：`RoboticsTeamCoordinator` 把"改 store → 失效 prompt section → 刷新 watcher"的编排从 `RoboticsSession`（曾 1766 行）里拆出，只借一个 `invalidate` 回调，解耦得当（见既有 architecture-review §3.1）。

### 4.2 [中] git 作为 IPC 的固有局限未被风险化
团队协调建立在 `git fetch/push` + 文件锁之上（`withFileLock`、10 分钟 fetch 冷却、5 分钟 watcher 间隔）。这意味着：
- **最终一致性**：两个 unit 在冷却窗口内都 `take` 同一任务，要到下次 sync 才发现冲突；`ownerUnit` 乐观锁只在单仓本地强一致，跨进程靠 git 收敛。
- **可观测性弱**：抢占/冲突的审计靠 `attempts[]` 追加，但没有跨 unit 的实时仲裁。
对实验室"咖啡时间内同步"的场景够用（注释也是这么定位的），但应在文档里把"这是最终一致、非强一致协调"显式写清，避免被当成可靠分布式锁使用。

---

## 5. 跨形态的统一性问题

### 5.1 [高] 三套"多智能体协作"没有共同抽象
- 形态 A：事件驱动 + 类型化 result。
- 形态 B：文件轮询 + capsule。
- 形态 C：git 文件 + 乐观锁。

三者都是"派活给 N 个隔离执行单元、收集结果、注入回上下文"，但**通信层、调度层、结果回注层各写三遍**。新增一种协作模式（比如"主从流水线"）没有可复用骨架，只能再造一套。这与既有架构审查发现的"两套互相矛盾的模式扩展机制"是同源问题——缺一个 `Coordinator` 抽象接口（`dispatch / collect / inject`），让三套形态成为它的不同实现。

### 5.2 [中] agent 面工具语义重叠，选择负担推给模型
`spawn_sub_agent`（异步）、`run_agent`（同步）、`research_dispatch`（同步 + 磁盘 handle）、`experiment_dispatch` 四个工具底层都是同一个 dispatcher，差异在同步性与结果落盘策略。prompt 里靠 "WHEN TO USE / WHEN NOT" 区分，但边界细（"<3 turns inline"、"<10 turns run_agent"、">5min spawn"）。模型容易选错。可考虑收敛成一个 `delegate` 工具 + `mode: sync|async`、`deliverable: inline|disk` 参数，减少表面积。

---

## 6. 建议优先级

**先做（高）**
1. 把 `CampaignEventBus` 改名并移出 subagent 目录（命名债，低成本高收益）。
2. 给 `SubAgentRecord` 加 `depth` 显式深度上限，把"单层级"从凑巧变成不变量。
3. 收敛 bridge 生命周期到工厂 + 兜底清理，消除静态 Map 泄漏的约定依赖。

**再做（中）**
4. 抽 `ICoordinator { dispatch; collect; inject }` 接口，让 A/B/C 三形态成为实现，先不强求统一实现、但统一契约。
5. 引入全局并发/配额中枢，让 bridge 调度器与 WorkerCoordinator 信号量共享预算。
6. 形态 B 的轮询在 worker 走 subagent 原语时改用事件总线。
7. 收敛 4 个委派工具为 1 个带参数的工具。

**文档化（低）**
8. 把"单进程总线""git 最终一致协调"两条硬约束写进 `docs/architecture/meta-agent-architecture.md`，避免误用。

---

## 7. 结论

地基（形态 A 的隔离 session 原语）质量高，健壮性细节（断路器、预算、abort、jail、背压）超出多数同类实现。真正的债是**横向统一性**：三套协作形态各自演化、共享一个被误名的进程内事件总线，且若干关键约束（单层级、单进程、最终一致）是隐式的。这些都不是 bug，而是"会随规模放大的结构张力"——在加入第四种协作模式或 daemon/多进程部署之前收敛，成本最低。
