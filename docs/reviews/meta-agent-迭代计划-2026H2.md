# meta-agent 迭代计划（2026 H2 – 2027 H1）

> 制定日期：2026-08-21
> 输入依据：[meta-agent vs codex 对比评审](./meta-agent-vs-codex-2026-08.md)
> 适用版本基线：`@meta-agent/runtime@0.8.20`

---

## 0. 计划的基本原则

**目标不是追平 codex。** codex 是 117 个 crate、数十人年的通用编码 agent 工业化实现；逐项对标既不可能，也会把资源从真正的差异化上抽走。

对比的用途只有一个：**codex 已经工业化的部分，暴露了我们底座上哪些是"缺失"而不是"取舍"。**

据此，本计划分两条并行线：

| 线 | 目标 | 判据 | 资源占比 |
| --- | --- | --- | --- |
| **A. 底座补强** | 把通用运行时补到"不再成为瓶颈" | 够用即停，**明确不追求超越** | ~60% |
| **B. 护城河深化** | 把 codex 空白的四块拉得更开 | 没有参照物，由领域效果判定 | ~40% |

以及一条同等重要的**不做清单**（§4），用于抵抗"看到 codex 有就想做"的冲动。

---

## 第一部分：底座补强

### A0. 判定标准：什么算"薄弱点"

一项能力进入底座补强清单，必须同时满足：

1. **它是瓶颈**——当前正在阻塞真实使用，而非"将来可能有用"；
2. **它是通用能力**——做出来不产生差异化，只是消除负分；
3. **它有成熟参照解**——codex 已验证的形态可直接借鉴，不需要我们做设计探索。

对照这三条，评审中列出的 codex 能力有一半**不进入**本计划（见 §4）。

---

### A1｜Q1（约 3 个月）：解除三个硬天花板

三项互不依赖，可并行，各自独立可交付。

#### A1.1 持久 Shell 会话

**问题**：`src/tools/shell/bash/index.ts` 是一次性调用（默认 30s，硬顶 600s），进程结束即销毁。REPL、gdb、交互式安装器、需要多次输入的 CLI 全部无法驱动；长任务只能"跑完或超时"，中途无法观察。

**方案**（对标 codex `unified_exec`）：

- 新增 `exec_session` / `write_stdin` 两个工具，底层复用 `src/infra/exec/runShellCommand.ts` 的进程组管理与脱敏管线，但把进程句柄存活到会话级。
- 关键参数：`yield_time_ms`（到时让出并返回已捕获输出，进程继续活着）、`max_output_tokens`（单次返回预算）、可选 TTY。
- 会话生命周期绑定 KernelSession；会话结束或超出 `maxSessions` 时按 LRU 回收，并杀死整个进程组。
- 现有 `bash` 保留为"起一个 session、跑完、关掉"的便捷封装，**行为完全不变**（零回归）。

**验收**：能在一个会话里启动 `python3 -i`，连续三次 `write_stdin` 并拿到各自输出；能启动一个 10 分钟的构建，每 30s 拿到增量输出；进程组在会话异常终止时无残留（`ps` 校验）。

**规模**：约 800–1200 LOC + 测试。

---

#### A1.2 统一补丁工具 + 每轮 Diff 聚合

**问题**：`src/tools/fs/edit_file/index.ts` 仅 110 行的字符串替换，文件超限直接拒绝并提示 "Use a targeted patch workflow" —— 而这个 workflow 并不存在。多文件原子修改无法表达，用户也看不到"这一轮到底改了什么"。

**方案**（对标 codex `apply_patch` + `turn_diff_tracker`）：

- **`apply_patch` 工具**：单次调用表达多文件的 add / delete / update，统一 patch 文本格式，解析失败给出精确到行的错误。走与 `edit_file` 相同的 `workspaceGuard` 与写锁（`src/core/fs/WriteMutex.ts`）。
- **TurnDiffTracker**：挂在 `KernelLoop` 的 `post_tool` 相位，累计本轮所有 FS 变更（含 `write_file`/`edit_file`/`apply_patch`/bash 造成的改动），轮末产出统一 diff。
- diff 同时成为**以轮为单位的 revert 单元**——这是 auto 模式当前缺的回退粒度（现在只能整体 `--resume`，无法"撤掉上一轮"）。

**验收**：一次调用完成"新建 2 文件 + 修改 3 文件 + 删除 1 文件"；轮末 diff 与 `git diff` 结果一致；对一轮执行 revert 后工作区回到轮前状态。

**规模**：约 1000–1500 LOC + 测试。

---

#### A1.3 工具懒加载 / tool_search

**问题**：所有工具 spec 一次性注入 system prompt（`src/modes/toolAdapter.ts` 全量 `inputJSONSchema`）。挂 3–4 个 MCP server 就会显著吃掉上下文预算。**这是当前扩展性最硬的天花板，且越晚做迁移代价越大**——每晚一个季度，就多一批依赖"工具默认可见"的提示词与测试。

**方案**（对标 codex `tool_search` + `defer_loading`）：

- 工具注册表增加 `namespace` 与 `deferLoading` 标记（`src/tools/registry/EngineeringToolRegistry.ts`）。
- 内置核心工具（fs / shell / ui）保持常驻；**MCP 工具、robotics 领域工具、provenance 工具默认 defer**，system prompt 里只留 namespace 摘要。
- 新增 `tool_search` 工具：按关键词/namespace 检索，命中后把完整 spec 注入当前上下文，之后可正常调用。
- 保留 `META_AGENT_TOOLS_EAGER=1` 逃生开关，便于对比排障与灰度。

**验收**：挂载 5 个 MCP server（合计 60+ 工具）时，system prompt 工具段 token 数相比全量注入下降 ≥ 70%；一个需要 MCP 工具的任务能在两跳内（search → call）完成。

**规模**：约 600–900 LOC + 测试 + 提示词调整。

---

### A2｜Q2（约 3 个月）：可观测性与可扩展性

#### A2.1 冻结 `KernelEvent` 为版本化 Schema 【前置任务】

**问题**：`src/kernel/types/KernelEvent.ts` 只有 138 行的内部 TS 联合类型，没有版本化线协议。一旦要接前端、跨语言、或让 loop 被外部驱动，都要推倒重来。

**方案**：

- 用 zod（已是运行时依赖）为每类事件定义 schema，导出 JSON Schema，带 `schemaVersion`。
- 建立**兼容性回归测试**：把当前事件样本存为 fixtures，任何破坏性变更必须显式改版本号并更新 fixture（对标 codex 的 `schema_fixtures_tests`）。
- 这一步**同时是 A2.2 和 A4.1 的前置**，必须先做。

**验收**：`KernelEvent` 有 JSON Schema 导出；fixture 回归测试在 CI 中拦截未声明的破坏性变更。

---

#### A2.2 结构化遥测 / OpenTelemetry

**问题**：全仓 grep `otel|telemetry|opentelemetry` = **0 命中**。只有 `CostTracker` 和 `DebugWriter`。

这是当前**功能与定位之间最大的错配**：auto / loop 是无人值守长周期模式，恰恰最依赖事后统计，但我们无法回答"上周 200 次 run 里哪类工具最常失败 / 哪个阶段最烧钱 / drift 命中率多少 / verify 平均要几轮"。

**方案**：

- 基于 A2.1 的稳定事件流，加一层 OTLP exporter（trace：session → turn → tool call；metric：token/cost/latency/失败率）。
- **默认关闭**，通过 `config.json` 的 `telemetry.endpoint` 显式开启。本地默认可落地为 JSONL，无需搭后端也能用。
- 优先埋点：工具失败率按名称聚合、auto 的 stall/drift/verify 触发计数、compact 触发频次与压缩比、subagent 断路器命中原因。

**验收**：跑完一次 auto 任务后，能用一条查询得到"本次 run 各工具调用次数与失败率"；接入任意 OTLP collector 可见完整 trace。

---

#### A2.3 外部 Hook 系统

**问题**：`src/kernel/loop/PhaseHooks.ts` 只有 4 个相位、两个动作（inject / abort），且是**进程内 TS 回调**——只有把 meta-agent 当库用的开发者能挂钩，CLI 用户无法在不改代码的情况下扩展。

**方案**（对标 codex `hooks` crate 的 8 类事件）：

- 生命周期事件：`session_start` / `session_end` / `user_prompt_submit` / `pre_tool_use` / `post_tool_use` / `permission_request` / `pre_compact` / `post_compact` / `subagent_start` / `subagent_stop`。
- 配置在 `config.json` 的 `hooks.*`，执行体为外部命令（stdin 传 JSON，stdout 读 JSON）或 MCP 调用。每类事件有 JSON Schema 契约。
- 现有 `PhaseHooks` 降为**内部实现**，外部 hook 通过它接入，保持"fail-open、只能 inject/abort"的安全不变式。
- 预留 `hooks.managedOnly` 开关（对标 codex `allow_managed_hooks_only`），为未来团队治理留口子。

**验收**：不改一行 TS 代码，通过配置实现"每次 `bash` 调用前记录到审计文件"和"session 结束时触发通知"。

---

#### A2.4 审批策略声明式化

**问题**：`src/kernel/permissions/SensitiveCommandPatterns.ts` 是硬编码正则清单。正则清单**必然漏**——新命令、管道组合、shell 变形（`$(echo cm0gLXJm | base64 -d)`）都绕得过。

**方案**：

- 把正则清单抽成**规则文件**（内置默认 + 项目/全局可覆盖），规则表达"可执行文件 + 参数模式 + 判定"，对标 codex `execpolicy`。
- 高风险动作可选接一道 **LLM guardian 二审**：复用现有 `src/core/flash/FlashClient.ts`，输入是策略文档 + 待执行动作，输出结构化风险裁定。对标 codex `guardian/policy.md` 的四类风险（数据外泄 / 凭据探测 / 持久性安全削弱 / 破坏性操作）。
- guardian **默认关闭**（有成本与延迟），auto 模式默认开启（无人值守场景最需要）。

**验收**：新增一条规则无需改代码；构造 5 个能绕过当前正则的变形命令，规则+guardian 组合能拦住 ≥4 个。

---

### A3｜Q3（约 3 个月）：状态收敛与编排合一

> 这两项**必须同一季度做**：编排合一是状态收敛的前置，否则要为三套状态各建一次表。

#### A3.1 三套长周期编排收敛到 Graph Runtime 【最高优先级架构债】

**问题**：当前存在**三套并行的长周期编排机制**：

| 机制 | 调度 | 状态存储 | 并发单元 |
| --- | --- | --- | --- |
| `core/auto/` | `AutoScheduler` + checkpoint/verify/drift | `AutoCheckpointStore`（schema 1.1） | subagent |
| `loop/graph/` | `GraphKernel` + `TransitionEngine` | `GraphStore`（事件溯源 + recovery fork） | `LaneManager` |
| `campaign/`+`coordination/` | `CampaignMonitor`（零 LLM） | `CampaignStateStore` | `WorkerCoordinator` |

已验证：**`campaign/` 与 `coordination/` 对 graph runtime 零引用**，完全平行。graph 至少复用了 subagent dispatcher（`src/loop/seatSpawn.ts`），是三者中耦合最健康的。

代价是三份 checkpoint / 恢复语义 / 并发上限 / 预算控制 / 可观测埋点要分别维护、分别测、分别修。

**方案**：以 `GraphStore` 的事件溯源模型为唯一底座。

- **campaign → graph 的一个 capability pack**：DOE 采样 = function 节点；并行评估 = lane 扇出；保真度晋升 = 条件边；`PARETO_READY_*` 人工检查点 = wait 节点（event 类型）；`CampaignMonitor` 的确定性推进正是 `TransitionEngine` 的职责，可整体删除。
- **auto → graph 的一个预置拓扑**：`AutoCheckpoint` 语义等价于 graph 的事件溯源快照 + `GraphCheckpoint`；verify / drift 是两个特定的 agent 节点；stall guard 保留在 kernel 层不动。
- **迁移纪律**：两者都先做"新实现与旧实现并行 + 结果比对"，跑满一个版本周期后再删旧路径。`AUTO_CHECKPOINT_SCHEMA_VERSION` 提供了现成的兼容读取入口。

**验收**：`CampaignMonitor` 与 `AutoCheckpointStore` 从代码库移除；三种长周期任务共用一套恢复、一套并发上限、一套预算、一套埋点；旧 checkpoint 文件可被读取并迁移。

**风险**：这是本计划里最大的一次重构。缓解手段是并行运行期 + `GraphSoakHarness`（已有的 soak 测试设施）扩展到覆盖 auto / campaign 两种拓扑。

---

#### A3.2 状态收敛到 SQLite

**问题**：状态散落在 JSON / JSONL（`~/.meta-agent/sessions/<id>/history.jsonl` + `index.json`、各知识库独立文件），无 sqlite、无迁移框架、无索引。schema 演进只靠 `parseArrayFiltered` 容错。会话多了以后检索与清理会成为问题。

**方案**：

- 引入 SQLite（`node:sqlite` 或 better-sqlite3）+ **正式迁移框架**（版本表 + 顺序迁移脚本，对标 codex `state` crate）。
- 入库对象：sessions 索引与元数据、jobs、subagent tasks、graph instances、知识库（experience / principle / anchor / pending 队列）。
- **对话历史仍保留 JSONL**（append-only 是对的），但索引、搜索、统计走 SQLite。
- 提供一次性迁移命令，旧文件迁移后保留备份。

**验收**：`meta-agent sessions --search "关键词"` 在 1000 个会话下 <100ms；schema 变更通过迁移脚本完成，旧库可平滑升级。

---

### A4｜Q4（约 3 个月）：接口与包结构

#### A4.1 协议层 + SDK

依赖 A2.1 的 schema 冻结。目标是让 loop / graph 能被 IDE、Web 前端、其他语言驱动 —— 现在只有 CLI 和 npm 库两条路。

- 基于冻结的事件 schema 定义 JSON-RPC 接口（submit / interrupt / steer / subscribe events / resume）。
- 传输先做 stdio，够用即停；websocket 视需求再加。
- 优先级判定：**如果没有明确的前端接入需求，本项可整体推迟**。不要为了"codex 有"而做。

#### A4.2 包拆分与领域插件化

**问题**：90K LOC 单包，`exports: "."` 单入口。其中 robotics(13.7K) + campaign + coordination + workflow + units + validation + provenance ≈ **20K LOC 是领域逻辑** —— 任何只想要通用 kernel 的使用者都要拖上机器人知识库和 DOE 采样器。层次纪律靠注释（`PhaseHooks.ts` 写着 "the kernel never imports the implementation"），没有编译器保证。

**方案**（分两步，第一步立即可做）：

1. **先上机器强制**：ESLint import 边界规则，禁止 `kernel/` → `robotics/|campaign/|loop/`，禁止 `tools/` → 领域目录。**这一步成本极低、Q1 就该做**，不必等到 Q4。
2. **再做物理拆分**：`@meta-agent/kernel` / `@meta-agent/tools` / `@meta-agent/robotics` / `@meta-agent/cli`。领域包通过插件接口注册，借鉴 codex `agent-role` 的**有界覆盖**模型（子代理只能收窄父会话权限，永远不能扩权）。

#### A4.3 Windows 沙箱

`powershell` 工具已存在，但 `src/sandbox/detect.ts` 只探测 bwrap / sandbox-exec —— **Windows 上工具可用但保护缺失**，这是当前唯一的"能力与防护不匹配"组合。

最低目标不是复刻 codex 的 `windows-sandbox-rs`（19.7K LOC），而是：**Windows 上默认拒绝无沙箱执行**，与 auto 模式的 `allowUnsandboxedFallback: false` 保持一致的 fail-closed 语义。有余力再做 Job Object + 受限令牌的真实约束。

---

## 第二部分：护城河深化

以下四块 codex 完全空白，且短期不会做（它的目标用户是写代码的开发者，不是调机器人的工程师）。**没有参照物意味着没有捷径，也意味着做出来就是净差异化。**

### B1｜知识系统：从"防污染"到"证据链"

**现有优势**：三层知识（experience / principle / physical anchor）+ 置信分层（observed → reproduced → derived → reported → hypothesis）+ observation/contradiction 计数 + 强制人工 review + 晋升硬门槛（检索分 ≥450 且 ≥3 条独立经验收敛）。

对比：codex 的 `memories` 是自动抽取自动使用，**没有置信分层、没有矛盾计数、没有人工闸门**——它默认知识是干净的。我们默认知识会被污染，并为此付出了工程代价。**这个假设更正确，是护城河的根。**

**下一步：**

#### B1.1 抽取管线后台化（Q1–Q2）

借鉴 codex `memories` 的两阶段管线（`Stage1JobClaimOutcome`：claim / lease / backoff / retry-exhausted），但**保留人工 review 闸门**——这是不能让步的部分。

- 主循环只负责**标记候选**（"这里踩坑了"），不再在对话中同步组织完整的结构化经验。
- 后台 worker 从完整会话历史里离线提炼，产出结构化 experience 进入 pending 队列。
- 收益双重：省主循环 token；后台能看到**整段历史**而非当时的局部上下文，提炼质量更高。

**验收**：主循环因知识写入产生的 token 开销下降 ≥60%；后台提炼的 experience 通过人工 review 的比例不低于当前同步路径。

#### B1.2 Campaign ↔ 知识层打通（Q2–Q3）

**当前两套机制是割裂的**——campaign 跑完一轮 DOE，失败点不会自动成为经验。

- 每次实验的失败自动成为 experience 候选，携带完整参数组合与观测数据作为 `evidenceRefs`。
- 被证伪的假设（`invalidatedAssumptions`）自动生成 physical anchor 候选。
- 反向：campaign 启动时自动召回同域 physical anchor，作为设计空间的**硬约束**注入采样器——不让 DOE 在物理上不可能的区域浪费预算。

这一项与 A3.1（campaign 并入 graph）**天然协同**，应同批设计。

#### B1.3 知识检索的可解释性（Q3）

现在 `ExperienceWorkingSetManager` 每轮挑最多 4 条注入，但用户看不到"为什么是这 4 条"。

- 注入时附带命中理由与检索分构成。
- 提供 `/experience why` 命令解释上一轮的召回决策。
- 目的：让人工 review 者能判断**检索策略**本身是否退化，而不只是判断单条知识对错。

---

### B2｜Graph Loop：从"能跑"到"可证"

**现有优势**：自然语言需求 → 蒸馏 → 静态校验 + 独立语义审阅 → 冻结 → 事件溯源执行（effect outbox、可恢复 paused 节点、timer/event、崩溃恢复、单机并发）。

对比：codex 的 multi-agent 是**运行时动态 spawn**（`multi_agents_v2`：spawn / send_message / wait / interrupt / followup），没有"先固化拓扑再执行"这一层。**对长周期高风险任务，我们的模型可控性结构性更强。**

**下一步：**

#### B2.1 图的收敛性保证（Q2–Q3）

当前 `GraphLint` / `GraphValidate` 做的是结构校验。缺的是**语义层的终止性保证**：

- 静态检测不可达终态、潜在活锁（互相等待的 wait 节点）、无界重试环。
- 为每个图计算**最坏情况资源上界**（轮数 / 预算 / 时长），在冻结前展示给审阅者。这是"人来裁决"能真正生效的前提——现在审阅者看到拓扑，但看不到代价。

#### B2.2 蒸馏质量的可度量化（Q3）

需求 → 图的蒸馏是整条链路里最不可控的一环。

- 建立蒸馏 benchmark：一组带标准答案拓扑的需求样本，度量结构相似度与关键约束覆盖率。
- 把 `DistillTraceStats` 的数据接入 A2.2 的遥测，让"蒸馏质量是否随模型/提示词变化而退化"成为可监控量。

#### B2.3 图的复用与模板（Q4）

- 跑成功的图沉淀为可参数化模板，进入 `GraphCatalog`。
- 与 B1 打通：模板携带它依赖的 physical anchor 与 principle，复用时自动校验前提是否仍成立。

---

### B3｜Campaign：实验设计层的纵深

codex 没有任何实验设计层。这块的迭代不看 codex，看领域需求。

- **Q3**：并入 graph runtime（见 A3.1），拿到统一的恢复、并发、预算、埋点能力。
- **Q4**：采样策略从纯 DOE 扩展到序贯设计（贝叶斯优化 / 主动学习），让"下一批测什么"由已有观测决定，而非预先排定。这是把预算花在刀刃上的下一个数量级。
- **持续**：Pareto 检查点的呈现质量——现在停下来等人裁决，但人拿到的信息是否足以裁决，决定了这个机制是真闸门还是走过场。

---

### B4｜多提供商层：守住国内场景优势

codex 深度绑定 OpenAI Responses API（有 ollama / lmstudio / aws-auth，但不是一等公民）。我们的 GLM 默认 + DeepSeek / Qwen / Anthropic 统一 thinking 抽象，在国内场景是实打实的优势。

- **Q2**：把 provider 能力矩阵（thinking 形态、缓存语义、并发限制、计费口径）显式化为数据，而非散落在 `src/providers/registry.ts` 的分支里。新增一家提供商应是加一条数据，不是加一段代码。
- **Q3**：接入 A2.2 遥测，按 provider 统计失败率 / 延迟 / 单位任务成本，让 fallback 策略有数据依据而非拍脑袋。

---

## 3. 排期总览与依赖

```
Q1  ├─ A1.1 持久 shell 会话          ┐
    ├─ A1.2 apply_patch + diff 聚合   ├─ 三项独立并行，各自可交付
    ├─ A1.3 工具懒加载 / tool_search  ┘
    ├─ A4.2-1 ESLint import 边界（低成本，提前做）
    └─ B1.1 知识抽取后台化（启动）

Q2  ├─ A2.1 KernelEvent schema 冻结  ──┐ 前置
    ├─ A2.2 OTLP 遥测 ←───────────────┘
    ├─ A2.3 外部 hook 系统
    ├─ A2.4 审批策略声明式化 + guardian
    ├─ B1.1 知识抽取后台化（交付）
    ├─ B2.1 图的收敛性保证
    └─ B4 provider 能力矩阵数据化

Q3  ├─ A3.1 三套编排收敛到 graph ─────┐ 前置
    ├─ A3.2 状态收敛到 SQLite ←───────┘
    ├─ B1.2 Campaign ↔ 知识层打通（与 A3.1 同批设计）
    ├─ B1.3 知识检索可解释性
    ├─ B2.2 蒸馏质量度量
    └─ B4 provider 遥测

Q4  ├─ A4.1 协议层 + SDK（视前端需求，可整体推迟）
    ├─ A4.2-2 包物理拆分 + 领域插件化
    ├─ A4.3 Windows fail-closed
    ├─ B2.3 图模板与复用
    └─ B3 序贯实验设计
```

**关键依赖链**（不可调换顺序）：

- `A2.1 schema 冻结` → `A2.2 遥测` → `A4.1 协议层`
- `A3.1 编排合一` → `A3.2 SQLite 收敛`（否则要为三套状态各建一次表）
- `A3.1 编排合一` ↔ `B1.2 campaign 知识打通`（同批设计，避免为旧 campaign 结构写一次集成再删掉）

**为什么 Q1 是这三项**：互不依赖、单独可交付、立即改善日常体验，且 A1.3（工具懒加载）**越晚做迁移代价越大**——每晚一个季度就多一批依赖"工具默认可见"的提示词与测试。

---

## 4. 明确不做清单

以下是 codex 有、我们**主动不做**的。列出来是为了让"不做"成为一个决定，而不是一个遗漏。

| 能力 | 不做的理由 |
| --- | --- |
| 插件市场 / marketplace | 生态需要用户规模支撑，当前阶段做出来是空货架。先把 hook + MCP 两条扩展路径做扎实。 |
| OAuth 连接器体系 | 同上，且 MCP 已覆盖大部分集成需求。 |
| 远程 / 容器执行环境（exec-server remote、cloud-tasks） | 我们的场景是本地机器人开发与工程实验，硬件在本地。远程执行是伪需求。 |
| 独立 TUI（codex `tui` 269K LOC） | 现有 CLI + `src/cli/tui/` 的轻量实现够用。投入产出比极低。 |
| `code-mode`（让模型写代码调工具而非发 tool JSON） | 有意思但收益未验证，且与我们"图先冻结再执行"的可控性哲学有张力。**观察，不跟进。** |
| 从 Claude Code / Cursor 的迁移器 | 用户重叠度低。若出现真实需求再做，成本不高。 |
| 网络出口 MITM + 域名级策略 | 现有 `network: none/unrestricted` 二元 + 凭据脱敏，对本地开发场景够用。企业场景出现时再说。 |
| 多层配置治理（ConfigLayerStack / Constrained） | 面向企业下发场景，当前无此类用户。 |

**复核节奏**：每季度末复核一次本清单，判据是"是否出现了真实用户需求"，而不是"codex 又更新了什么"。

---

## 5. 成功判据

计划执行到 2027 H1 结束时，应能回答"是"：

**底座（A 线）**

- [ ] 能在一个 shell 会话里驱动 REPL / 交互式程序
- [ ] 一次调用完成多文件原子修改，每轮产出可审阅、可回退的 diff
- [ ] 挂载 5 个 MCP server 不再显著挤占上下文预算
- [ ] 能用一条查询回答"上周所有 auto run 里哪类工具最常失败"
- [ ] 不改代码、仅改配置即可扩展生命周期行为
- [ ] 长周期编排只有**一套**实现
- [ ] `kernel/` 对领域目录的依赖由工具链拦截，而非靠 review

**护城河（B 线）**

- [ ] 知识提炼不再占用主循环 token，且质量不降
- [ ] campaign 的实验失败自动进入知识候选，physical anchor 自动约束设计空间
- [ ] 图在冻结前能展示最坏情况资源上界
- [ ] 蒸馏质量是可监控的量，而非靠人工感觉

**反向判据**（同等重要）——以下任何一条为"是"，说明计划跑偏了：

- [ ] 为了对齐 codex 的某项能力，推迟了 B 线任务
- [ ] 不做清单里的项目在没有真实用户需求的情况下被启动
- [ ] 底座某项做到了"超越 codex"（说明超投了，该收手时没收）
