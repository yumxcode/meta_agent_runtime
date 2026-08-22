# meta-agent 迭代计划（2026 H2 – 2027 H1）

> 初版：2026-08-21 · 一次修订：2026-08-22 · **本版：2026-08-22（二次修订 · A3 落地细化）**
> 输入依据：[meta-agent vs codex 对比评审](./meta-agent-vs-codex-2026-08.md)、[auto verify/drift 审查](./auto-verify-drift-审查-2026-08.md)
> 版本基线：`@meta-agent/runtime@0.9.1`（A1、A2 已交付）

---

## 修订说明（2026-08-22 · 二次修订）

**A3 整体重写。** 一次修订把 A3 定义为"先补齐 robotics 的自监督缺口，再做 auto↔graph 的定向收敛"。这个判断建立在一个错误的前提上。

**错在哪里：robotics 是交互式模式。** 它的判定者是人——人在每个阶段 gate 上验收，人在每一轮里看着。drift（跑偏了喊停）和 verify（说完成了要复核）是为**无人值守**设计的替身判定者：因为没人看着，才需要机器代替人喊停。给一个人在环内的模式装机器关卡，不是补缺口，是加冗余，甚至是干扰——人已经判过一次，机器再判一次，只会制造需要人去裁决的第三方意见。

一次修订之所以会得出那个结论，是因为把两件正交的事混成了一件：

| 属性 | 是什么 | 谁需要 |
| --- | --- | --- |
| **判定者** | 谁判断"跑偏了"和"做完了" | 因模式而异：交互式是人，无人值守是机器 |
| **轨迹记录** | 发生过什么被记成了什么 | **全体模式，无一例外** |

把"robotics 没有 verify/drift"读成"robotics 有缺口"，是拿无人值守模式的判定者形态去要求交互式模式。robotics 真正缺的东西，和 auto、graph、乃至默认交互模式缺的是同一样：**一条能说清楚到底发生了什么的轨迹。**

**新的 A3 因此只做一件事：建立 meta-agent 的标准 agent 轨迹。** 所有模式写入同一种 append-only 契约；对话恢复、查询索引、历史遥测和知识抽取从它投影，模式执行状态则保留各自必要的 reducer / journal。参照系是 codex 的 `rollout` / `history` / `thread-store` 分层——它对轨迹记录的投入本身说明：**轨迹不是无人值守的配套设施，是 agent 运行时的地基。**

自监督怎么装、装给谁，是模式层的问题，从 A3 移出（见 A3.9 与 §4）。

---

## 修订说明（2026-08-22 · 一次修订，保留为历史）

本次修订有两个触发点，都改变了 A3 的核心论点：

**一、campaign 退回 idea 阶段。** 初版把 A3 的主要工作定义为"campaign → graph capability pack"。campaign 不再是本阶段目标后，那部分工作整体移出计划。

**二、重新核对代码后，初版关于"三套并行编排"的描述不准确。** 逐条核实的结果：

| 初版说法 | 实际情况 |
| --- | --- |
| auto / graph / campaign 三套并行长周期编排 | 数量对，但成员不对：campaign 出局后，真正并行的是 **auto**、**loop graph**、**robotics workflow**，三者形态差异远大于初版描述 |
| "graph 至少复用了 subagent dispatcher，是三者中耦合最健康的" | 属实，但**仅限 dispatcher**。`RoleCatalog` 的 `buildHandler`（为 graph 节点准备的 verify/drift/reviewer 处理器）**从未被调用**——`grep` 全仓只有 `buildVerifyGate`/`buildDriftGate` 被 `AgenticBackendFactory` 用到。初版说"收敛已经开始"是错的 |
| robotics 未在编排讨论中出现 | robotics 直接包 `AgenticSession`（跳过 `MetaAgentSession`），**没有 verify/drift 关卡、没有 durable checkpoint**，另有一套 `WorkflowLoader` 阶段/gate 机制 |

修订后的 A3 因此从"三合一大重构"改为"**先补齐 robotics 的自监督缺口，再做 auto↔graph 的定向收敛**"——范围更小，收益更明确，风险更低。

> 上述结论已被二次修订推翻（robotics 是交互式模式，不需要机器判定者）。此段保留，是因为其中三条**代码事实核实**仍然成立且仍是新 A3 的依据：robotics 直接包 `AgenticSession`、graph 不用 roles、`RoleCatalog.buildHandler` 是死代码。被推翻的是从这些事实推出的结论，不是事实本身。

---

## 0. 计划的基本原则

**目标不是追平 codex。** 对比的用途只有一个：**codex 已经工业化的部分，暴露了我们底座上哪些是"缺失"而不是"取舍"。**

两条并行线，外加一条同等重要的**不做清单**（§5）：

| 线 | 目标 | 判据 | 资源占比 |
| --- | --- | --- | --- |
| **A. 底座补强** | 把通用运行时补到"不再成为瓶颈" | 够用即停，**明确不追求超越** | ~60% |
| **B. 护城河深化** | 把 codex 空白的部分拉得更开 | 没有参照物，由领域效果判定 | ~40% |

### 0.1 本阶段的模式范围

模式有两条**正交**的属性。一次修订把它们混成了一条，是 A3 需要重写的根本原因。

| 模式 | 判定者 | 需要机器自监督（drift/verify） | 需要标准轨迹 |
| --- | --- | --- | --- |
| interactive / 默认 | **人**（每轮） | 否 | **是** |
| `robotics` | **人**（每轮 + 阶段 gate 验收） | **否**——人在环内，机器关卡是冗余 | **是** |
| `auto` | **机器**（verify / drift 子代理） | 是 | **是** |
| `simple_auto` | 无（单次运行，不承诺） | 刻意没有 | **是** |
| `loop graph` | **图的拓扑**（确定性执行） | 模式层未定，见 §4 | **是** |
| `agentic` | 通用基座，其余模式的底层 | — | 隐含在全部工作中 |
| `campaign` | **idea 阶段** | 移出本计划 | 移出本计划 |

**轨迹记录是全体共有的；自监督是模式各自的事。**

判定者的形态由模式定位决定，没有统一答案——交互式模式的人已经在判，无人值守模式必须找个替身来判，确定性图模式的判定其实写在拓扑里。但"发生过什么"这件事对所有模式是同一个问题，也应该只有一份答案。A3 只做后者。

> 顺带纠正一次修订的措辞：`simple_auto` 表述为"无 checkpoint/drift/verify"暗示它是残缺版。它的定位是**不承诺长周期**——不承诺就不需要判定者。这不是缺，是范围。

campaign 相关的一切（DOE、Pareto、多保真度、`CampaignMonitor`）在本文档中只作为**历史背景**出现，不再有任务项。

---

## 第一部分：底座补强

### A0. 判定标准

一项能力进入底座补强清单，必须同时满足：

1. **它是瓶颈**——当前正在阻塞真实使用，而非"将来可能有用"；
2. **它是通用能力**——做出来不产生差异化，只是消除负分；
3. **它有成熟参照解**——不需要我们做设计探索。

---

### ✅ A1｜Q1：解除三个硬天花板 —— 已交付（v0.9.0）

| 项 | 交付物 |
| --- | --- |
| A1.1 持久 shell 会话 | `ShellSessionStore` + `exec_session`/`write_stdin`/`close_session`；守卫栈与一次性 `bash` 逐条对齐；按 `agentId` 隔离；管道非 PTY（代价写进工具描述） |
| A1.2 原子补丁 + 轮级 diff | `apply_patch`（校验全部 → 内存计算 → 落盘 → 失败回滚）；自研 Myers diff 无新依赖；`TurnDiffTracker` 惰性捕获基线 |
| A1.3 工具懒加载 | `namespace` + `deferLoading` + `tool_search`；kernel 过滤 `toolsForApi`，`config.tools` 不动；**隐藏 schema 不是权限** |

顺带修复：`list_dir` 漏在 `BUILTIN_BOUNDED_TOOLS` 之外；`withFileLock` 心跳倒置（真 bug，复现率 1/40，会导致互斥失效）。

---

### ✅ A2｜Q2：可观测性与可扩展性 —— 已交付（v0.9.1）

| 项 | 交付物 |
| --- | --- |
| A2.1 事件契约冻结 | zod schema + JSON Schema 导出 + **fixture 与指纹双重回归**（指纹专抓 fixture 抓不到的"新增 optional 字段"）。发现并修正了 schema 与实际 `TokenUsage` 不符的错误 |
| A2.2 结构化遥测 | JSONL 为主 / OTLP 可选，**默认关闭**；按工具名的调用与失败数、compaction 压缩比、按状态分桶的重试；`rollupSummaries` 回答跨运行问题。不变式：**遥测永不拖垮它观察的运行** |
| A2.3 外部 hook | 9 个生命周期事件，JSON 走 stdin/stdout；**hook 只能否决、永不授权**——`HookDecision` 里没有 `allow` 字段，提权在类型上不可表达 |
| A2.4 声明式审批 | 30 条内置规则从原列表生成；分层覆盖/禁用/`allow` 压制。发现内置 sed 规则漏掉最常见的 `sed -i EXPR file` 形式（既有盲区，已钉死测试） |

四项默认全关，不配置则完全惰性。

---

### A3｜Q3：标准 agent 轨迹与可重建投影

> **二次修订整体重写，本节经落地设计补充。** 原 A3 的主题（补自监督、消编排重复）属于模式层，已移出。本季度 A3 只做一件事：**让所有模式写入同一种可关联、可验证的标准轨迹。**
>
> 参照系：codex 的 `rollout` / `history` / `thread-store` 分层。选它不是为了照搬，而是因为它把三件容易混淆的事拆开了：append-only rollout、模型上下文投影、查询索引。A3 采用这个分层思想，但 item、隐私策略和模式关联必须按 meta-agent 自己的需求定义。

A3 的目标不是“把所有状态塞进一条 JSONL”，而是建立下面三层：

| 层 | 回答的问题 | 是否唯一真相 | 典型载体 |
| --- | --- | --- | --- |
| **标准轨迹** | 发生过什么、先后与因果关系是什么 | 是，针对审计事实与对话历史 | append-only JSONL |
| **执行状态** | 下一步允许做什么、如何保证 exactly-once / lease / wake | 因模式而异 | graph journal、auto checkpoint、workflow state |
| **查询投影** | 如何快速列会话、搜索、聚合遥测 | 否，必须可重建 | JSON 索引；必要时再引入 SQLite |

**轨迹记录统一，不等于执行机制统一。** 只有当某个模式已经定义完整领域事件、纯 reducer，并通过“轨迹重放结果 = 现有状态”测试后，它的快照才可以降级为缓存。graph journal 包含 commit intent、effect intent、lease token 等执行语义，永久保留为 graph 的执行真相；通用轨迹只接收它的审计投影。

#### A3.0 现状：多套存储、版本与粒度约定

逐个核实的全量清单：

| 存储 | 路径 | schema 版本 | 写入方 | 粒度 |
| --- | --- | --- | --- | --- |
| 会话历史 | `~/.meta-agent/sessions/<id>/history.jsonl` | **无** | CLI 层 | 每条消息 |
| 会话索引 | `~/.meta-agent/sessions/index.json` | — | 全量重写，上限 50 条 | 每会话 |
| auto checkpoint | `<workspace>/.meta-agent/auto/checkpoints/<id>.json` | `1.1` | checkpoint coordinator / CLI | 每会话单文件 |
| workflow 状态 | `<projectDir>/.meta-agent/workflow-state.json` | `1.0` | robotics | **项目单例，无 sessionId** ⚠️ |
| robotics 项目态 | `~/.meta-agent/robotics/projects/<sha1(dir)>/<id>/state.json` | `1.0` | robotics | 每 (项目, 会话) |
| graph 日志 | `GraphStore`（事件溯源 + recovery fork） | `graph-journal-1.0` | `GraphKernel` | 每图实例 |
| subagent 记录 | `~/.meta-agent/subtasks/<taskId>.json` | `1.0` | dispatcher | 每任务 |
| jobs | `~/.meta-agent/jobs/<id>/<jobId>.json` | zod schema | jobs 层 | 每 job |
| 遥测 | 按 UTC 日分文件的 JSONL | `EVENT_SCHEMA_VERSION` | **仅 `KernelSession`** | 每事件 / 每运行汇总 |

这里实际列出了九类持久数据，分布在三种目录布局（`~/.meta-agent` / `<workspace>/.meta-agent` / 项目哈希桶），版本与关联方式彼此独立。问题不是“文件多”本身——graph journal 和 job record 有各自合理职责——而是它们之间没有共同游标与因果标识。由此产生四条结构性后果：

**一、不存在一条完整的会话轨迹。** `history.jsonl` 存的是 `ConversationMessage`（user / assistant + content block）。以下内容**全部不在任何地方**，或散在另外七个文件里且没有可对齐的序号：本轮生效的模型与审批策略、审批裁决与裁决者、压缩边界、subagent 生命周期、阶段推进、轮级 diff。"这个会话第 40 轮到底发生了什么"今天是一道需要人工拼四个文件时间戳的题。

**二、遥测只覆盖一层。** `createTelemetryRecorder` 全仓只有一个调用点：`KernelSession.ts:251`。graph 的节点转移、robotics 的阶段推进、subagent 的派发都不产生遥测。A2.2 交付的"能回答跨运行问题"，真实边界是"能回答 kernel 层的跨运行问题"。

**三、轨迹里没有确定性事实。** `tool_result` 存的是**模型看到的字符串**，不是退出码。B3 的问题（verify 只能靠代码观感）根因不在 verify 的 rubric——**就算允许 judge 引用退出码，也没有地方能读到退出码。**

**四、同一模式内部就有两种粒度约定。** `workflow-state.json` 落在 `join(projectDir, '.meta-agent', 'workflow-state.json')`，路径里没有 sessionId——同一项目并发两个 robotics 会话会互相覆盖阶段状态。而同属 robotics 的 `RoboticsProjectStore` 是 per-(project, session) 的。这类不一致不是疏忽，是没有共同契约时的必然产物。

#### A3.1 身份模型与轨迹契约

“会话”不足以覆盖所有模式：graph 的 function/effect/wait 节点不属于任何 agent session，persistent Lane 与 subagent 又各自有独立会话。因此存储单元定义为 **trajectory**，它有一个明确 subject：

```ts
type TrajectorySubject =
  | { kind: 'session'; sessionId: string }
  | { kind: 'graph_instance'; workspaceId: string; instanceId: string }
  | { kind: 'subagent'; taskId: string; sessionId: string }
```

普通交互、auto、simple_auto、robotics 各有一条 session trajectory；每个 graph instance 有一条 root trajectory，persistent Lane 和 subagent 是它的 child trajectory。这样 graph 自身的节点转移有明确落点，也不需要伪装成某个 Lane 的对话。

每行使用稳定 envelope：

```ts
interface TrajectoryLine {
  schemaVersion: 'trajectory-line-1.0'
  ts: number                 // 写入时刻，仅用于展示
  ordinal: number            // trajectory 内单调递增，唯一分页游标
  trajectoryId: string       // opaque UUID，不从路径或 subject 拼接
  runId?: string             // 一次 submit / activation / scheduler wake
  turnId?: string            // 一次用户轮或 agent turn
  item: TrajectoryItem       // 标签联合
}
```

`trajectoryId`、`runId`、`turnId` 解决三种不同粒度：一个交互 session 会有多个 run，因此 `result` 不能“每会话仅一次”；它应改成每个 `runId` 一个 `run_result`。item schema v1.1 不定义 `session_closed`：`dispose()` 只是释放进程资源，不等于用户任务已经终止；在有可靠的领域终态来源前，不能为了 GC 伪造生命周期事实。

`TrajectoryItem` 的成员，对照 codex `RolloutItem`（`SessionMeta | ResponseItem | TurnContext | WorldState | Compacted | EventMsg | InterAgentCommunication | SecurityRiskScore`）按我们的模式集合调整：

| item | 载荷 | 写入方 | 为什么必须在轨迹里 |
| --- | --- | --- | --- |
| `trajectory_meta` | subject、mode、root / parentTrajectoryId、workspace / workspaceId、provider、CLI 版本、git base、创建来源 | 创建，仅一次 | 轨迹身份、父子关系与复现锚点 |
| `run_started` / `run_result` | run 原因、预算；outcome、用量、成本、终止原因 | 每次 run 首尾 | 区分多轮 session 与一次具体执行 |
| `turn_context` | 本轮 model、审批策略、沙箱模式、可见工具**名称与 schema hash**、预算余量 | 每轮开始 | 回答“为什么这轮能使用这组能力”，避免重复保存完整 schema |
| `message` | 模型实际看到的 `ConversationMessage`，默认移除 thinking / redacted_thinking | 每条 canonical message | 现有 `history.jsonl` 的可恢复替代物 |
| `tool_outcome` | toolUseId、工具名、耗时、isError、输出摘要；shell 类额外记录 command、cwd、exitCode、signal、timedOut | 工具执行层 | 全工具统一，shell 额外提供 B3 所需确定性证据 |
| `turn_diff` | A1.2 的轮级 diff 摘要（文件、增删行数、内容哈希） | 每轮结束 | 已有能力，从未落盘 |
| `approval` | 请求、裁决、**裁决者**（内置规则 / hook / 人） | 审批时 | A2.3 / A2.4 的行为目前完全不可回溯 |
| `compaction` | 压缩边界、压缩前后 token、**完整 replacement history**、window 标识 | 压缩时 | 让反向扫描能安全停在自足的恢复点 |
| `subagent` | spawn / 完成 / 失败、taskId、childTrajectoryId、worktree、用量 | dispatcher | 跨 agent 因果链，不复制子历史 |
| `phase` | 领域阶段推进：robotics 阶段 + gate 结果、graph 节点转移与激活 | 领域层 | 让领域进度与对话落在同一条时间线 |
| `job` | created / progress / completed / failed、jobId、关联 toolUseId | jobs 层 | 异步 job 与发起轮次建立因果关系 |
| `knowledge` | experience / anchor / principle 的召回与写入 | 知识层 | B1.4 可解释性的前提 |
| `state_checkpoint` | mode、状态 schema、checkpoint revision、内容 hash、原存储引用 | 模式层 | 迁移期对账；不等于把 checkpoint 内容复制进轨迹 |
| `evaluation` | evaluator、verdict、score / metrics、证据 ordinal、artifact hash | 评测层 | 让后续 agent 自进化引用可验证判定，不把评测正文复制进轨迹 |

六条契约级约束：

1. **`ordinal` 是轨迹内的唯一游标。** 分页、断点续读、投影增量重建、resume 定位一律不用时间戳。ordinal 由单 writer 在真正落盘前分配，失败重试不能消耗或重复 ordinal。
2. **所有跨组件关系使用 ID，不使用时间戳猜因果。** `parentTrajectoryId`、`childTrajectoryId`、`runId`、`turnId`、`toolUseId`、`activationId` 是 join key。
3. **落盘策略集中**：`shouldPersist(item, persistencePolicy) → boolean`。模式决定“产生哪些 item”，不决定“同一种 item 是否落盘”，避免形成模式方言。流式 delta 不落盘。
4. **轨迹记录事实，不夸大事实。** exit code 是“某条被选择命令的可信执行结果”，不是任务已完成的不可伪造证明；B3 还必须检查命令、cwd、发生在最后一次相关 diff 之后，以及是否覆盖约定的验证范围。
5. **schema 治理沿用 A2.1**：zod + JSON Schema + fixture + 指纹；envelope 与 item payload 分别版本化。reader 对未知 optional 字段前向兼容，对未知 major item 保留原始行但不参与恢复投影。
6. **审计投影与模型上下文投影分开。** 失败 attempt、rollback、compact 前历史仍留在审计轨迹；interactive projector 应用 compaction 和 legacy safe-resume 规则。Graph Lane 的 committed / rollback segment 选择继续属于 graph 语义层，在标准 marker 定义前不写成通用恢复能力。

#### A3.2 轨迹存在哪里，是否需要数据库

标准轨迹集中存放在：

```text
~/.meta-agent/trajectories/<trajectoryId>/
  trajectory.jsonl       # 唯一真相源，append-only
  health.json            # canonical / projection degradation 状态
  writer.lock            # 仅 writer 存活期间存在，带 heartbeat
```

目录名使用 opaque UUID，不把 workspace path、sessionId、taskId 直接编码进路径。真实 subject、workspaceId、parent/root 关系只存在于首条 `trajectory_meta` 中。集中放在 `META_AGENT_HOME` 而不是 workspace，原因有三点：会话历史不应随工作树清理而丢失；跨 workspace 查询只需扫描一个根；权限与保留策略可以统一。graph 的执行 journal 仍留在 `<workspace>/.loop/`，轨迹只记录其审计摘要和 journal sequence 引用。

**轨迹真相源不使用数据库。Q3 也不立即引入 SQLite。** 当前包支持 Node 18，SQLite 通常意味着新增 native dependency，会增加安装、打包和 Windows 成本；而 1000 级会话的 metadata/title 搜索，用一个可重建的小型 JSON 索引已经足够。

Q3 的投影布局：

```text
~/.meta-agent/index/
  trajectories.json          # metadata 投影，entry 自带 lastOrdinal 游标
  trajectory-telemetry.json  # 历史遥测汇总 + 每轨迹 ordinal cursor
  trajectory-parity.json     # trajectory / legacy 双读对账证据
```

`index/` 下都是可重建投影，不是真相源。metadata 不再另写一个无人消费的 `projection-state.json`，而是由每条 index entry 的 `lastOrdinal` 做幂等增量折叠；`trajectory reindex --clean` 重建 metadata，`trajectory telemetry --clean` 重建历史聚合，`trajectory parity --clean` 重置对账观察。全文搜索可以先显式走较慢的文件扫描，不为一个尚未出现的性能问题提前引入数据库。

SQLite 只在以下任一条件被真实触发后加入，并且仍然只是投影：

- 轨迹数量或 metadata 索引大到 P95 查询超过 100 ms；
- 出现跨 item 的组合查询（例如“某 provider 下、最后一次 diff 后测试失败的 auto run”）；
- 需要 FTS 全文检索、分页和多进程高频查询。

届时数据库可放在 `~/.meta-agent/index.db`，删除后必须完全可重建。**知识库不属于这个可重建索引**：`knowledge` item 只记录召回、提议、批准和条目 ID，Experience/Principle/Anchor 的内容仍由它们自己的受审存储负责；否则一次人工编辑或历史导入无法从会话轨迹恢复，会破坏“数据库只是投影”的定义。

存储生命周期同样属于契约：Q3 不自动删除 canonical trajectory；active / paused / 被父轨迹引用的 child trajectory 尤其不能按年龄清理。当前提供 `meta-agent trajectory disk` 和只读 dry-run 的 `trajectory gc`；由于 v1.1 尚无可信 `session_closed` 与完整引用终态，`gc --apply` 明确拒绝执行。自动 TTL、压缩归档、显式删除和配额驱逐必须在引用完整性与 resume 回归测试之后单独决策，不能沿用当前“索引只留 50 条”而顺手删除真相源。

#### A3.3 记录器与写入语义

`TrajectoryRecorder`：每 trajectory 一个，其余组件只调用 `record(item)` 与 `barrier(reason)`。写入契约：

1. **后台写入，但队列有界。** 正常 `record()` 只入队；队列达到上限后产生背压，不允许用无限内存换“永不阻塞”。默认队列上限按 item 数和总字节双重限制。

2. **不静默丢弃。** item 只有整行写入成功后才从 pending 移除；I/O 失败关闭句柄、保留未写后缀，下个 barrier 重开并重试。会话结束不是唯一 barrier：`trajectory_meta`、每轮完成、compaction、durable park/wake、run_result、shutdown 都是 barrier。

3. **barrier 明确 durability。** 普通 flush 只保证数据交给文件系统；关键 barrier 使用 `FileHandle.sync()`。durable park 只有在轨迹 barrier 和原执行状态写入都成功后才能对外宣称已挂起。交互模式写失败时显式标记 session `persistence_degraded`、禁止把它展示为可安全 resume；graph 的执行不因审计投影失败而回滚，但必须暴露 trajectory degradation，因为它仍有独立 journal 保证正确性。

4. **单 writer 与多进程 fencing。** 打开 trajectory 前获取独占 writer lease；已有活跃 writer 时，第二个进程不得并发追加。resume 在获得 lease 后反向读取最后有效 ordinal，再继续编号。

5. **只修复 torn tail，不吞中段损坏。** 进程崩溃留下的最后一行不完整时，截到最后一个完整换行并记录 repair；文件中段 JSON 错误或 ordinal gap 必须 fail closed，不能像普通日志那样跳过。

6. **反向扫描有安全停止条件。** 只有遇到包含完整 replacement history 的 compaction，且同时找到其后的完整 turn context / turn boundary，resume 才能停止；否则回退到文件开头或显式报超限，不能“看到 compaction 就截断”。

7. **脱敏与限额在写入路径上。** 先做结构化字段脱敏，再用 `redactSecrets` 做文本兜底；默认不持久化 thinking / redacted_thinking；工具 schema 只记名称和 hash；二进制、图片和超长输出只存 hash、尺寸与有界摘要。目录权限默认 `0700`，文件默认 `0600`。

#### A3.4 各模式接入与双写阶段

接入遵循“先双写、再对账、最后切读”的顺序。A3 初期所有既有执行状态继续权威，不能一边定义 schema 一边删旧恢复路径。

| 模式 | 平移进来的 | 新增的 item | 随之消失的问题 |
| --- | --- | --- | --- |
| interactive / 默认 | `history.jsonl` | `turn_context` / `approval` / `tool_outcome` | 先得到完整审计；验证后切换 message resume |
| `auto` | `history.jsonl` + checkpoint 引用 | 同上 + `turn_diff` / `state_checkpoint` | checkpoint 暂不删除；为后续 reducer 对账准备输入 |
| `simple_auto` | `history.jsonl` | 同上 | — |
| `robotics` | 阶段 / gate → `phase` | 同上 + workflow definition hash | 先把 workflow state 改为 per-session；轨迹不被当作修复并发 bug 的捷径 |
| `loop graph` | root trajectory 记节点/激活/journal sequence | Lane / subagent 各有 child trajectory | graph 进入统一审计时间线，但 journal 永远保留 |
| subagent | — | 父轨迹记 `subagent` 生命周期；子会话有**自己的轨迹文件** | 跨 agent 因果链断裂 |
| jobs | job JSON | 父轨迹记 `job` 生命周期和 jobId | job 与发起 tool/turn 可关联 |

三个需要写明的取舍：

- **graph 保留自己的 journal，采用双写。** `graph-journal-1.0` 里有 recovery fork、commit intent、lease token——那是**执行正确性机制**，不是记录。把它塞进通用轨迹会污染契约（其他模式没有 lease）。做法：journal 仍是 graph 的执行真相，同时向轨迹发一份摘要级 `phase`。代价是少量冗余，收益是 graph 终于出现在统一时间线与遥测里。**判断依据**：一个 item 如果被消费它的组件用来做决策（而不只是被读来了解发生了什么），它属于执行机制，不属于轨迹。
- **subagent 的完整历史不进父轨迹。** 父轨迹只记生命周期 item + 子轨迹路径。理由与 codex 一致：子代理历史挤进父轨迹会让父轨迹的尾部读失去意义，但父轨迹必须能跳过去。
- **graph Lane 的审计历史与 resume history 分开。** 失败 / cancelled attempt 留在 child trajectory；只有 completed segment 被 model-context projector 选入下一次 Lane 上下文，保持现有 G3 语义。

`workflow-state.json` 的项目单例冲突必须直接修：新路径为 `<project>/.meta-agent/workflows/<sessionId>.json`，老路径只做匹配 session / definition 的 legacy fallback。即使轨迹写入失败，同项目并发 robotics 也不能再互相覆盖。

#### A3.5 投影层：索引与遥测

**sessions index 是轨迹投影。** `trajectories.json` 不再限制 50 条，按 `lastActivity`、mode、workspace、subject 建最小元数据索引；标题和 first prompt 是派生字段。更新失败不影响轨迹，下一次 reindex 可以修复。

**遥测分实时与历史两条输入。** A2.2 现有 `KernelEvent → TelemetryAggregator` 暂时保留，它仍负责 api retry、compact failure 等实时信号；新增 `TrajectoryTelemetryProjector` 折叠持久 item，负责 graph / robotics / subagent 的跨运行历史分析。只有当两者的字段映射和回归测试完整后，才允许合并实现。拥有轨迹不会让领域模式“自动进入遥测”——各模式仍必须显式发出标准 item。

Q3 查询面：

- `meta-agent trajectory inspect <id>`：按 ordinal 展示因果时间线；
- `meta-agent trajectory tail <id> [--after <ordinal>]`：断点读取；
- `meta-agent trajectory verify <id>`：schema、ordinal、父子引用和 torn-tail 检查；
- `meta-agent trajectory reindex [--clean]`：重建全部查询投影；
- `meta-agent trajectory telemetry [--clean]`：按持久 ordinal cursor 增量折叠跨模式历史遥测；
- `meta-agent trajectory parity [--clean]`：对账最新 session trajectory 与 legacy resume，只持久化数量、hash 和连续观察证据；
- `meta-agent trajectory disk` / `gc`：容量统计与保守保留审计，Q3 不执行删除；
- `meta-agent sessions --search <text>`：Q3 只承诺 title / first prompt / mode / workspace metadata 搜索。

#### A3.6 恢复边界：先统一模型历史，不承诺统一执行器

恢复拆成两类：

1. **模型上下文恢复**：M5 首阶段由公共 projector 折叠 `message + compaction + turn_context`，并复用 legacy resume 的安全边界与消息上限规则；先供 interactive 做切读。Lane 的 committed / rollback segment 选择仍由 graph 语义层决定，不能在没有标准 marker 前宣称通用 projector 已覆盖。
2. **模式执行恢复**：由模式自己的 reducer / journal 决定。auto 需要 pending wake、revision、健康计数等完整领域事件；robotics 需要 definition hash、gate completion 与 phase history；graph 继续只从 GraphStore 恢复。

因此 A3 不再宣称“恢复只有一套实现”。正确的不变式是：**对话恢复只有一份 projector；执行恢复可以有多份 reducer，但它们引用同一套轨迹证据与 ID。**

auto / robotics 快照只有满足以下条件后才能降级为缓存：

- 每个会影响下一步决策的字段都有 canonical domain event；
- reducer 是无 I/O 的纯函数；
- 用真实 legacy fixture 重放后与现有 snapshot 深度相等；
- crash point 测试覆盖“事件已写 / 快照未写”和“快照已写 / 投影未更新”；
- 连续一个发布周期双读对账无差异。

即使达到这些条件，graph journal 仍不参与降级，因为它不是快照，而是执行提交协议。

#### A3.7 迁移与兼容

- 新版本先双写 `history.jsonl` 与 trajectory；trajectory writer 的问题不能破坏旧版 resume。
- 存在 `history.jsonl` 而无 trajectory 时，按只读 legacy 格式读取；内存中可分配 synthetic ordinal，但不能把它冒充原始 durable ordinal。
- `meta-agent migrate trajectory` 只导入能证明顺序的单一 history 流；auto checkpoint / workflow state 以 `legacy_snapshot_import` item 引用，不通过时间戳把多个文件拼成伪因果序列。
- 迁移创建全新的 opaque trajectoryId，首条 meta 标明 legacy 来源、原路径与导入版本。
- **迁移是可选的**：不迁移的老会话仍可 resume，只是拿不到新 item。不做强制迁移，是因为迁移失败的代价（历史丢失）远大于收益（老会话拿到新字段）。
- 旧文件至少保留一个发布周期；切读、停止双写、删除 legacy 文件是三个独立开关，不能一次完成。

#### A3.8 分阶段交付与验收

| 阶段 | 交付 | 刻意不做 |
| --- | --- | --- |
| **A3-M1** | envelope / item schema、opaque identity、writer lease、bounded queue、barrier、reverse scanner、verify CLI | 不接 SQLite，不切换 resume |
| **A3-M2** | KernelSession 双写；message / turn_context / approval / tool_outcome / turn_diff / compaction | 不删除 history.jsonl |
| **A3-M3** | graph root + Lane/subagent 父子关系、robotics phase、job / knowledge 生命周期；workflow per-session 修复 | 不替换任何领域执行状态 |
| **A3-M4** | 增量 metadata index、锁外 reindex、持久历史 telemetry projector、inspect/tail/search/health/disk/gc CLI、双读 parity 证据入口 | 不做全文 FTS；GC 只 dry-run |
| **A3-M5（Q4 条件项）** | 双写稳定一个发布周期后，公共 model-context projector 让 interactive 先切读；auto/robotics 只做 replay parity 实验 | graph journal 永不迁移；未达稳定门槛不切读 |

> **实施状态（2026-08-22，审查整改后）**：A3-M1～M4 的技术交付已按兼容双写落地；审查发现的 compaction 空洞、断点跳页、伪反向读取、字符串嗅探、投影耦合、unknown item、超限背压、graph flush、索引重建和历史遥测接线问题均已修复并有回归覆盖。现有 `history.jsonl`、auto checkpoint、workflow state、job record 与 graph journal 的读取/执行职责均未切换。canonical trajectory 位于 `META_AGENT_HOME/trajectories/`，JSON 投影位于 `META_AGENT_HOME/index/`，当前无需数据库。
>
> 当前状态是 **M5 技术准入就绪、观察期尚未完成**：`trajectory parity` 已能积累 hash-only 双读证据，但 2026-08-22 当天不能制造“连续一个发布周期”的时间证据。因此现在不得打开 interactive trajectory 切读，也不得停止 legacy 双写。

进入 M5 的门槛拆成两组，避免把“代码已修好”误写成“迁移风险已被真实运行证明”：

1. **技术门槛（当前已满足）**：schema / fixture / 指纹全绿；ordinal、torn-tail、中段损坏、未知 item、oversize/backpressure、writer lease/heartbeat 有回归；`tail --after` 返回紧邻 cursor 的 page；反向 projector 与全量 projector 在安全 compaction、turn context、异常未闭合 run 上一致；canonical barrier 不等待可重建投影；graph 可显式等待 append + fsync + metadata；领域 item 由领域层结构化发出；health、reindex、telemetry 和 parity 有实际消费入口。
2. **运行证据门槛（当前未满足）**：至少跨一个真实发布周期周期性运行 `meta-agent trajectory parity`，所有可比较 session 均为 `match`，无持续 canonical/projection degraded、无无法解释的 missing legacy / error；发生 mismatch 时连续匹配窗口重新计时。该门槛是时间与真实样本约束，不能用重复跑单测替代。

核心验收：

- 任意一条 trajectory 中 ordinal 严格连续；并发第二 writer 被拒绝；torn tail 可修，中段损坏 fail closed；
- 每个 run 有且仅有一组 `run_started` / terminal `run_result`，多轮 session 不互相覆盖；
- `tool_outcome` 的 exitCode 来自执行层结构化字段，不从展示字符串反解析；
- 最后一个安全 compaction 后反向恢复的 model context 与全量正向重放深度一致；
- graph instance → Lane → subagent 可仅靠 ID 遍历，父轨迹不复制子历史；
- `meta-agent trajectory reindex --clean` 前后 metadata 查询一致；
- 1000 条 trajectory 的 metadata 搜索 P95 <100 ms；达不到再触发 SQLite 决策；
- 默认落盘不含 thinking、原始二进制、完整工具 schema 和已识别凭据。
- `trajectory parity` 的匹配结果不落消息正文，只落数量、hash、ordinal 与观察窗口；真实发布周期证据满足前不得切读。

#### A3.9 A3 的边界：什么不在里面

**自监督属于模式层，不在 A3。** A3 只保证一件事：无论哪个模式、由谁判定，**证据来源是同一条轨迹**。以下三项从 A3 移出，记录在 §4：

- verify / drift 的装配方式（`RoleCatalog.buildVerifyGate` / `buildDriftGate` 目前只有 `AgenticBackendFactory` 用）；
- `RoleCatalog.buildHandler` 死代码——注释写着 "Node-level handler used by the orchestration graph"，声称服务于 `KernelNodeRunner`；核实后 `KernelNodeRunner` 本身**只存在于注释里**（`grep` 全仓只命中 `core/roles/` 两个文件的注释），`buildHandler` 除 `RoleRegistry.ts` 内部转发外无任何调用点。这不是"接线没接完"，是**为一个不存在的消费者建的抽象**；
- graph 是否需要节点级独立复核。

此外，下列事项也不由 A3 首期承担：把知识正文迁入索引数据库、删除 graph journal、让所有 mode 共用一个执行 reducer、在没有性能数据前引入 SQLite。

**为什么 A3 先做标准轨迹**：这些模式问题的答案各自取决于判定者和执行语义，而“发生过什么、如何关联、证据能否验证”对所有模式相同。先把相同部分做成一份契约，之后增加关卡、知识抽取或恢复 reducer 时才不必各自发明证据格式。

---

### A4｜Q4：接口与包结构

#### A4.1 协议层 + SDK

依赖 A2.1 已交付的 schema 冻结。目标是让 loop/graph 与 auto 能被 IDE、Web 前端、其他语言驱动。

- 基于冻结的事件 schema 定义 JSON-RPC（submit / interrupt / steer / subscribe / resume）。
- 传输先做 stdio，够用即停。
- **判定：若没有明确的前端接入需求，本项整体推迟。** 不要为了"codex 有"而做。

#### A4.2 包拆分与领域插件化

**现状**：90K LOC 单包，`exports: "."` 单入口。其中 robotics(13.7K) + workflow + units + validation + provenance 是领域逻辑。

1. **先上机器强制（低成本，可立即做）**：ESLint import 边界规则，禁止 `kernel/` → `robotics/|loop/`，禁止 `tools/` → 领域目录。
2. **再做物理拆分**：`@meta-agent/kernel` / `@meta-agent/tools` / `@meta-agent/robotics` / `@meta-agent/cli`。借鉴 codex `agent-role` 的**有界覆盖**模型（子代理只能收窄权限，不能扩权）。

> campaign 相关代码在拆分时按"冻结模块"处理：单独成包或留在主包边缘，不投入重构。

#### A4.3 Windows fail-closed

`powershell` 工具已存在但 `sandbox/detect.ts` 只探测 bwrap / sandbox-exec。最低目标不是复刻 codex 的 `windows-sandbox-rs`，而是 **Windows 上默认拒绝无沙箱执行**，与 auto 的 `allowUnsandboxedFallback: false` 语义一致。

---

## 第二部分：护城河深化

codex 在这几块是空白，且短期不会做——它的目标用户是写代码的开发者，不是调机器人的工程师。

### B1｜知识系统：从"防污染"到"证据链"

**现有优势**：三层知识 + 置信分层 + observation/contradiction 计数 + 强制人工 review + 晋升硬门槛（检索分 ≥450 且 ≥3 条独立经验收敛）。codex 的 `memories` 没有其中任何一条。

#### B1.1 抽取管线后台化（Q3）

借鉴 codex `memories` 的两阶段管线（claim / lease / backoff / retry-exhausted），但**保留人工闸门**。主循环只标记候选，后台 worker 从完整历史离线提炼。收益双重：省主循环 token；后台能看到整段历史，提炼质量更高。

> **依赖 A3-M2/M3。** "后台 worker 读完整历史"这句话在今天没有对应物——`history.jsonl` 只有消息，工具退出码、diff、阶段结果都不在里面，离线提炼能看到的并不比主循环多多少。轨迹落地后这一项才成立，且成立得更彻底：worker 的输入是一个带 ordinal 的流，可以断点续读、可以按 item 类型过滤。

#### B1.2 auto 经验写入纳入 review（Q3）

**新增项**，来自审查报告发现 8：drift agent 的 `experience_write` **绕过人工 review 直接写共享库**（有文档、是有意的），但 README 把"AI 提议、人来裁决"讲成三类知识的统一纪律，没说明 auto 是例外。

一条由跑偏的 drift agent 写下的错误教训，会每轮注入主 agent 并持久留在 workspace——这正是人工 review 被设计出来防止的场景。

方案：auto 写入进 pending 队列，但标记为 `auto_proposed` 并允许**在同一运行内被召回**（不阻塞当次运行的价值），跨运行才需要人工批准。

#### B1.3 robotics 阶段 ↔ 知识层打通（Q4，依赖 A3.4）

替换初版的"campaign ↔ 知识层打通"。robotics 的实验失败点应自动成为 experience 候选，`invalidatedAssumptions` 自动生成 physical anchor 候选；反向，阶段启动时召回同域 physical anchor 作为硬约束。

> 一次修订说这一项"与 robotics 接入自监督天然协同，drift agent 的判定证据正是经验的来源"。robotics 不装 drift 之后，这个协同点换了——但换得更好：**失败点直接从轨迹里挖**（`tool_outcome` 的非零退出码、`phase` 的 gate 未通过、`turn_diff` 的反复回改），不需要一个 agent 先把它判定出来。少一层 LLM 判断，多一层确定性。知识的召回与写入本身也是 `knowledge` item，因此"哪条经验在什么时候被召回、当时的上下文是什么"天然可查，这是 B1.4 的前提。

#### B1.4 知识检索的可解释性（Q4）

注入时附带命中理由与检索分构成；提供 `/experience why` 解释上一轮召回决策。目的是让人工 review 者能判断**检索策略**是否退化，而不只是判断单条知识对错。

### B2｜Graph Loop：从"能跑"到"可证"

**现有优势**：需求 → 蒸馏 → 静态校验 + 独立语义审阅 → 冻结 → 事件溯源执行。codex 的 multi-agent 是运行时动态 spawn，没有"先固化拓扑再执行"这一层。

#### B2.1 图的收敛性保证（Q3）

`GraphLint` / `GraphValidate` 目前做结构校验，缺语义层的终止性：

- 静态检测不可达终态、互相等待的 wait 节点、无界重试环。
- 为每个图计算**最坏情况资源上界**（轮数 / 预算 / 时长），冻结前展示给审阅者。这是"人来裁决"能真正生效的前提——现在审阅者看到拓扑，看不到代价。

#### B2.2 蒸馏质量的可度量化（Q4）

需求 → 图是整条链路最不可控的一环。建立带标准答案拓扑的 benchmark，度量结构相似度与关键约束覆盖率；把 `DistillTraceStats` 接入 A2.2 遥测，让"蒸馏质量是否随模型/提示词变化而退化"成为可监控量。

#### B2.3 图的复用与模板（Q4）

跑成功的图沉淀为可参数化模板进入 `GraphCatalog`；与 B1 打通——模板携带它依赖的 physical anchor 与 principle，复用时校验前提是否仍成立。

### B3｜auto 自监督的确定性成分（**新增，来自审查报告**）

这是审查报告里评级最高的两个问题之一，初版计划成文时尚未发现。

**问题**：verify 的 rubric 明文禁止运行 typecheck/test/lint（`VerifyJudge.ts:136`），所以 `meta-agent --mode auto "把构建跑绿"` 的护栏实际是**一个 LLM 读代码后觉得像是好了**。根因是结构性的：git 快照由 `add -A` 构建、遵守 `.gitignore`，`node_modules/`、`build/` 都不在里面，在那跑测试只会得到虚假失败。

**方案**（Q3，**依赖 A3-M2 的 `tool_outcome`**）：不是"让 judge 跑测试"，而是**把确定性检查交给执行者、把结果作为证据交给 judge**：

1. 构建 / 测试命令的**退出码与输出摘要**由工具执行层作为结构化 `tool_outcome` 写入轨迹，不从模型看到的字符串反解析。
2. verify 的 rubric 改为**要求**引用轨迹中的命令、cwd、exitCode 和 ordinal，并验证证据发生在最后一次相关 diff 之后。
3. “退出码为 0”只证明所选命令成功，不自动证明验证范围充分；任务契约或项目配置仍要说明应运行哪些检查。
4. 与 A1.1 的持久 shell 天然契合，但证据必须绑定具体 command segment，不能只取一个长驻 session 的“最后状态”。

> 一次修订把这一项写成"在 checkpoint 时记录退出码"，那是在 auto 的 checkpoint 结构里开一个专用字段。轨迹落地后这个专用改动不需要了——退出码本来就在轨迹里，B3 缩减为**改 rubric + 给 judge 一个查询接口**。工作量降了一个量级，而且这条证据同时对所有模式可用（包括 robotics 的人工 gate 验收：人也想看退出码）。

**收益**：绕开 git 快照的结构限制（`add -A` 遵守 `.gitignore`，`node_modules/` 与 `build/` 不在快照里，在那跑测试只会得到虚假失败），同时补上 auto 目前完全缺失的确定性成分。

### B4｜多提供商层

codex 深度绑定 OpenAI Responses API。我们的 GLM 默认 + DeepSeek/Qwen/Anthropic 统一 thinking 抽象在国内场景是实打实的优势。

- **Q3**：provider 能力矩阵（thinking 形态、缓存语义、并发限制、计费口径）显式化为数据，新增一家提供商应是加一条数据而非加一段代码。
- **Q3**：接入 A2.2 遥测，按 provider 统计失败率/延迟/单位任务成本，让 fallback 策略有数据依据。

---

## 3. 排期总览与依赖

```
✅ Q1  A1.1 持久 shell / A1.2 apply_patch+diff / A1.3 工具懒加载      已交付 v0.9.0
✅ Q2  A2.1 事件冻结 → A2.2 遥测 / A2.3 hook / A2.4 审批规则          已交付 v0.9.1

Q3  ├─ A3-M1 契约 + 身份 + writer/reader/verify CLI       ← 本季度地基
    ├─ A3-M2 KernelSession 双写 + tool_outcome             ← B3 的证据源
    ├─ A3-M3 graph/robotics/subagent/job 接入               ← 保留既有执行状态
    ├─ A3-M4 JSON metadata 索引 + 历史遥测投影              ← 暂不引 SQLite
    ├─ B3   verify 引用结构化命令证据 ←────────────────── 依赖 A3-M2
    ├─ B1.1 知识抽取后台化 ←──────────────────────────── 依赖 A3-M2/M3
    ├─ B1.2 auto 经验写入纳入 review      ← 小改动，独立，消除纪律例外
    ├─ B2.1 图的收敛性保证                 ← 独立
    └─ B4   provider 能力矩阵 + 遥测       ← 历史分析部分依赖 A3-M4

Q4  ├─ A4.1 协议层 + SDK（视前端需求，可整体推迟）
    ├─ A4.2 包拆分 + 领域插件化（ESLint 边界规则可提前到 Q3）
    ├─ A4.3 Windows fail-closed
    ├─ A3-M5 interactive trajectory 切读（projector 已技术就绪；双写稳定后才打开）
    ├─ B1.3 robotics 阶段 ↔ 知识层打通     ← 依赖 A3-M3 的 phase item
    ├─ B1.4 知识检索可解释性               ← 依赖 A3-M3 的 knowledge item
    ├─ B2.2 蒸馏质量度量
    └─ B2.3 图模板与复用

模式层（不在 A3，见 §4）：自监督装配方式 / graph 节点级复核 / buildHandler 死代码去留
```

**关键依赖链**（不可调换）：

- `A3-M1 轨迹契约` → 其余全部 A3 项。契约必须先冻结，否则各模式会长出不同 envelope、身份与游标约定
- `A3-M2 的 tool_outcome` → `B3 确定性证据`（执行层结构化事实必须先存在）
- `A3-M2/M3` → `B1.1 知识抽取后台化`（worker 需要消息、工具、diff 与阶段 item）
- `A3-M3 各模式接入` → `A3-M4 历史投影`（领域 item 必须先存在，遥测不会自动扩面）
- `A2.1 schema 冻结`（已交付）→ `A3.1`（同一套 zod + 指纹治理）→ `A4.1 协议层`

**为什么 Q3 以 A3-M1 开头**：它是本季度唯一的共享地基。B3、B1.1、B1.3、B1.4、遥测扩面各自需要的证据最终都应落在同一种 envelope 与身份体系里。先做它，这些实现都会缩小；不做它，它们会各自长出私有记录。这里追求的是“没有新的轨迹方言”，不是强行把合理的 graph journal、checkpoint、知识库合成一个文件。

---

## 4. 已发现但未排期的问题

来自 [auto verify/drift 审查](./auto-verify-drift-审查-2026-08.md) 与本次代码核实，按严重度排列。已修复的不再列出。

### 4.1 由 A3 处置

| 问题 | 严重度 | 处置 |
| --- | --- | --- |
| verify 禁止运行任何确定性检查 | 高 | **B3**，前置 A3-M2 的结构化 `tool_outcome` |
| `workflow-state.json` 是项目单例，同项目并发 robotics 会话互相覆盖 | 中 | **A3-M3 直接修路径**为 per-session，轨迹只负责记录，不拿日志替代并发隔离 |
| 遥测只接在 `KernelSession` 一处，graph / robotics / subagent 全部不可观测 | 中 | **A3-M3/M4**：各模式显式发标准 item，再由历史 projector 聚合；保留现有实时 KernelEvent 遥测 |
| 审批裁决（规则 / hook / 人）完全不可回溯 | 中 | **A3-M2 的 `approval` item** |
| drift 直接写共享经验库绕过人工 review | 低 | **B1.2** |

### 4.2 模式层问题（A3 明确不碰）

A3 只保证它们**有共同的证据来源**；答案取决于各模式的判定者定位。

| 问题 | 严重度 | 处置 |
| --- | --- | --- |
| drift 的 checkpoint 判据几乎全部由被审查者自述 | 高 | A3-M2/M3 只提供 tool outcome / diff / phase 事实，**不会自动消解**；仍需模式层改 drift 输入与判据 |
| verify / drift 的装配方式硬绑在 `AgenticBackendFactory` 里，不能独立装配 | 中 | 未排期。真正要先回答的是"哪些模式需要机器判定者"，而不是"怎么装" |
| `RoleCatalog.buildHandler` 死代码（其声称的消费者 `KernelNodeRunner` 只存在于注释里） | 低 | 未排期。**要么接上，要么删掉**——一个"设计好、从未接线"的抽象在仓库里放到第二个季度，是在给后来者制造错误的能力预期 |
| graph 是否需要节点级独立复核 | 中 | 未排期。graph 的判定者是拓扑（确定性），加 LLM 复核节点是否与这个定位自洽，需要先想清楚 |
| `severity` minor/major 无行为差异（纯装饰） | 中 | 未排期。要么给 `major` 真后果（建议：下次 drift 间隔减半），要么删字段。**保持现状是最差选项** |
| 纠偏无闭环，执行者可自我豁免 | 中 | 未排期。至少应在 `major` 后缩短下次检查间隔 |
| `DRIFT_TURN_INTERVAL` / `MAX_VERIFY_ROUNDS` 硬编码 | 中 | 未排期。优先级反了：judge 内部预算可配，而"多久查一次""最多返工几轮"不可配 |

### 4.3 其他

| 问题 | 严重度 | 处置 |
| --- | --- | --- |
| 内置 sed 规则漏掉 `sed -i EXPR file` | 低 | 已钉死测试。A2.4 后操作员可自行用三行配置补上 |
| 熔断退出完全绕过 verify | 信息 | 设计正确，仅记录 |

---

## 5. 明确不做清单

列出来是为了让"不做"成为一个决定，而不是一个遗漏。

| 能力 | 不做的理由 |
| --- | --- |
| **campaign 的任何投入** | **本阶段 idea 状态**。代码保留可运行，但不重构、不迁移、不作为收敛目标、不投入测试 |
| 插件市场 / marketplace | 生态需要用户规模支撑，当前做出来是空货架。先把 hook（已交付）+ MCP 两条路做扎实 |
| OAuth 连接器体系 | 同上，且 MCP 已覆盖大部分集成需求 |
| 远程 / 容器执行环境 | 场景是本地机器人开发，硬件在本地。远程执行是伪需求 |
| 独立 TUI（codex 269K LOC） | 现有 CLI + 轻量 TUI 够用，投入产出比极低 |
| `code-mode`（写代码调工具而非发 tool JSON） | 有意思但收益未验证，且与"先冻结图再执行"的可控性哲学有张力。**观察，不跟进** |
| 从 Claude Code / Cursor 的迁移器 | 用户重叠度低。出现真实需求再做 |
| 网络出口 MITM + 域名级策略 | 现有二元开关 + 凭据脱敏对本地开发够用 |
| 多层配置治理（ConfigLayerStack） | 面向企业下发场景，当前无此类用户 |
| OTLP traces / metrics | A2.2 只做了 logs。traces 需要稳定的 span 边界，那是 A4.1 协议层之后的事 |
| **给某个模式定制专属轨迹格式** | 一套 envelope / 身份 / 游标契约覆盖全模式**就是 A3 的意义**。模式可以有领域 item，但不能另建不兼容的轨迹方言 |
| **把轨迹真相源做成数据库** | JSONL 追加路径简单、可检查、易做 torn-tail 恢复；数据库适合做可重建查询投影。没有真实性能触发条件前，Q3 不引 SQLite |
| 交互式模式加机器判定者（drift/verify） | 人已经在环内判过一次。机器再判一次，产出的是需要人去裁决的第三方意见，净增负担。**这是本次修订推翻一次修订的直接原因** |

**复核节奏**：每季度末复核一次，判据是"是否出现了真实用户需求"，而不是"codex 又更新了什么"。campaign 的复核判据是"是否有人真的要跑参数扫描"。

---

## 6. 成功判据

执行到 2027 H1 结束时应能回答"是"：

**底座（A 线）**

- [x] 能在一个 shell 会话里驱动 REPL / 交互式程序
- [x] 一次调用完成多文件原子修改，每轮产出可审阅、可回退的 diff
- [x] 挂载多个 MCP server 不再显著挤占上下文预算
- [x] 能用一条查询回答"上周所有 auto run 里哪类工具最常失败"
- [x] 不改代码、仅改配置即可扩展生命周期行为
- [ ] **任意模式的一次运行，都能用一条命令查看完整因果轨迹，不需要拼多个文件的时间戳**
- [ ] **删掉 JSON 查询投影后能从轨迹完全重建，metadata 查询结果一致**
- [ ] 遥测覆盖全部模式——graph 的节点转移与 robotics 的阶段推进出现在同一条时间线上
- [ ] 对话恢复只有一份公共 projector；模式执行恢复有明确 reducer / journal 边界
- [ ] 同项目并发的 robotics 会话不再互相覆盖阶段状态
- [ ] 每一轮"用了哪个模型、什么审批策略、什么沙箱模式"可查
- [ ] `kernel/` 对领域目录的依赖由工具链拦截，而非靠 review

**护城河（B 线）**

- [ ] **verify 引用执行层结构化记录的命令、cwd、退出码和证据时序，而不只是代码观感**
- [ ] 知识提炼不再占用主循环 token，且质量不降
- [ ] auto 写入的经验不再是人工 review 纪律的沉默例外
- [ ] robotics 的实验失败自动进入知识候选，physical anchor 自动约束阶段设计
- [ ] 每一条被召回的知识都能回答"为什么是它"
- [ ] 图在冻结前能展示最坏情况资源上界

**反向判据**（同等重要）——以下任一为"是"，说明计划跑偏：

- [ ] 为了对齐 codex 的某项能力，推迟了 B 线任务
- [ ] 不做清单里的项目在没有真实用户需求的情况下被启动
- [ ] **campaign 在没有真实使用需求的情况下被重新投入**
- [ ] **某个模式绕过标准 envelope / 身份 / ordinal 自建了另一套轨迹方言**
- [ ] **在轨迹契约冻结之前，就有模式先接了一版自己的轨迹**（方言化的起点）
- [ ] 给交互式模式加了机器判定者
- [ ] 底座某项做到了"超越 codex"（说明超投了，该收手时没收）
