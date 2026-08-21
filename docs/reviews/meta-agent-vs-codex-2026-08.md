# meta-agent vs codex：功能与架构对比评审

> 评审日期：2026-08-21 · 对象：`@meta-agent/runtime@0.8.20`（TypeScript）vs OpenAI `codex`（Rust）
> 方法：源码级通读两侧目录结构、关键模块实现与文档，结论逐条回溯到具体文件。

---

## 0. 体量与形态基线

| 维度 | meta-agent | codex |
| --- | --- | --- |
| 语言 / 形态 | TypeScript，**单 npm 包** + CLI | Rust，**117 个 crate** 的 workspace + CLI/TUI |
| 非测试代码量 | ~90.5K LOC（含测试 127K，231 个测试文件） | `tui` 269K、`core` 196K、`app-server` 50K…（量级差 10x+） |
| 运行时依赖 | 3 个（anthropic-sdk / openai / zod） | 数百 crate，自建 Bazel + Cargo 双构建 |
| 对外接口 | CLI + npm 库（`exports: "."` 单入口） | CLI + TUI + app-server(JSON-RPC) + Python/TypeScript SDK + MCP server |
| 模块边界强制手段 | 目录约定 + 代码注释 | Cargo 依赖图（编译器强制） |

**基线判断**：这不是同量级项目，逐项对齐是错误目标。本文的用法是——**把 codex 当作"通用 agent 运行时底座"的工业化参考解**，识别哪些是 meta-agent 必须补的地基，哪些是可以主动不做的。

---

## 1. 功能层面：短板与未实现

### 1.1 执行原语（最痛的一块）

| 能力 | meta-agent 现状 | codex 对应 | 影响 |
| --- | --- | --- | --- |
| **持久 shell 会话** | ❌ 无。`bash` 是一次性调用（默认 30s，硬顶 600s），进程结束即销毁（`src/tools/shell/bash/index.ts`） | `unified_exec`：`exec_command` + `write_stdin`，带 TTY、`yield_time_ms` 分段让出、`max_output_tokens`（`core/src/tools/handlers/unified_exec/`） | 无法驱动 REPL、gdb、交互式安装器、需要多次输入的 CLI；长任务只能"跑完或超时"，没有中途观察 |
| **结构化补丁** | ❌ 无。`edit_file` 仅 110 行的字符串替换，文件过大直接拒绝并提示"Use a targeted patch workflow"（该 workflow 并不存在） | `apply_patch`：独立 crate + Lark 语法 + freeform tool，支持多文件 add/delete/update（`core/src/tools/handlers/apply_patch.rs`） | 大规模重构效率低；多文件原子修改无法表达 |
| **本轮 diff 聚合** | ❌ 无 | `turn_diff_tracker.rs`：追踪一轮内所有文件变更，产出统一 diff | 用户无法一眼看清"这一轮改了什么"，也没有以轮为单位的 revert |
| **工具懒加载** | ❌ 无。全部工具 spec 一次性注入 system prompt | `tool_search` + `defer_loading` + namespace（`tools/src/tool_search.rs`） | **挂 3–4 个 MCP server 就会显著吃掉上下文预算**，这是当前扩展性最硬的天花板 |

### 1.2 安全与权限

| 能力 | meta-agent | codex |
| --- | --- | --- |
| 命令审批 | 硬编码正则清单 `SensitiveCommandPatterns.ts` | 双层：`execpolicy`（声明式规则 DSL，可组织下发）+ `guardian`（把 `policy.md` 交给模型判风险，输出数据外泄/凭据探测/持久性安全削弱/破坏性操作的结构化裁定） |
| 沙箱平台 | bwrap(Linux) + sandbox-exec(macOS)，**Windows 无沙箱**，无 landlock 降级 | seatbelt + bwrap + landlock + `windows-sandbox-rs`(19.7K LOC，含 read grants) |
| 网络管控 | 二元：`network: "unrestricted" \| "none"` | `network-proxy` crate：MITM、按域名/连接策略、**credential broker**（凭据不进子进程）、attribution（把出站请求归因到具体命令） |
| 强制层位置 | bash 走 OS 沙箱，但 fs 工具走 TS 层 `workspaceGuard` 路径检查 | 读写统一收敛到 `exec-server` + `sandboxing::manager` |

> ⚠️ **架构性风险**：meta-agent 里"新工具忘了调 `workspaceGuard`"就是一个逃逸口，纪律靠 review 而非结构保证。codex 把所有 exec/fs 挤进单一 server 边界，新增工具无法绕过。

### 1.3 可观测性与运维

- **meta-agent 可观测性接近为零**：`otel / telemetry / opentelemetry` 全仓 0 处引用；只有 `CostTracker` 和 `DebugWriter`。
- codex 有 `otel`（OTLP 导出 + events/metrics/trace_context）、`analytics`（events/facts/reducer/accepted_lines）、`diagnostics`、`feedback`。
- **后果**：无法回答"上周 200 次 auto run，哪类工具最常失败 / 哪个阶段烧钱最多 / drift 命中率多少"。而 auto/loop 这类长周期无人值守模式，恰恰是**最依赖事后统计**的场景 —— 这是当前功能与定位之间最大的错配。

### 1.4 扩展与生态

| 能力 | meta-agent | codex |
| --- | --- | --- |
| 外部 hook | ❌ 仅进程内 TS 回调 `PhaseHooks`（4 个点，只能 inject/abort，仅库用户可用，CLI 用户无法挂钩） | `hooks` crate：8 类生命周期事件（pre/post tool use、permission request、pre/post compact、session start/end、user prompt submit、subagent start/stop、stop），JSON Schema 契约、外部命令或 MCP 执行、`allow_managed_hooks_only` 组织管控 |
| 插件 / 市场 | ❌ 无 | `plugin` + `core-plugins`：manifest、marketplace add/policy、已装列表、`request_plugin_install` 工具 |
| 连接器 / OAuth | ❌ 无 | `connectors`：app info、`app_tool_policy`、runtime projection、metadata store |
| 迁移互操作 | ❌ 无任何导入路径 | `external-agent-migration`：从 Claude Code / Cursor 导入 config、hooks、mcp、memory、subagents、sessions |
| 远程 / 容器执行 | ❌ 全部本机进程 | `exec-server` 支持 local + remote 环境（capability discovery、environment registry/toml、Noise 加密 rendezvous、remote fs/process）+ `cloud-tasks` |
| 前端协议 | ❌ 无 | `app-server`(50K) + `app-server-protocol`(32K) + transport(stdio/uds/websocket) + 测试客户端 + SDK |

**扩展方式对比**：meta-agent 目前只有两条路 —— 写 TS 代码 `registerTool`，或手写 MCP 配置文件。这意味着**非开发者无法扩展**，也意味着不存在生态。

### 1.5 状态与持久化

| 维度 | meta-agent | codex |
| --- | --- | --- |
| 存储 | 散落 JSON / JSONL（`~/.meta-agent/sessions/<id>/history.jsonl` + `index.json`），无 sqlite | `state` crate：SQLite + 121 行 migrations + audit + telemetry；`rollout`：JSONL 录制 + 压缩 + reverse scanner + session index + search |
| Schema 演进 | 靠 `parseArrayFiltered` 容错，无迁移框架 | 正式 migration + `schema_fixtures_tests` / `precomputed_exports_tests` 兼容性回归 |
| 会话操作 | append + resume（`--resume`） | thread fork、section 排序、queued items、goals、recovery、rollout 截断与预算 |
| 记忆 | 同步路径：`memory_write` → pending → 人工 review，占主循环 token | 两阶段**后台**抽取管线（stage1 job claim / lease / backoff / retry-exhausted），从 rollout 离线提炼 |

---

## 2. 架构层面：短板

### 2.1 单体包 + 领域逻辑与运行时同包

90K LOC、24 个 `src/` 子目录，全部通过一个 `exports: "."` 发布。其中 **robotics(13.7K) + campaign + coordination + workflow + units + validation + provenance ≈ 20K LOC 是领域逻辑**，任何只想要通用 kernel 的使用者都必须拖上机器人知识库和 DOE 采样器。

codex 的做法是：核心 crate 保持通用，领域能力全部下沉到 plugin / skill / agent-role（TOML 定义的**有界覆盖** —— 子代理只能收窄父会话权限，永远不能扩权，见 `core/src/agent/role.rs`）。

### 2.2 层次纪律靠注释，不靠编译器

`PhaseHooks.ts` 的注释写着"the kernel never imports the implementation"、`KernelLoop` 注释标注与 CC 的对应关系 —— 这些都是**约定**。TypeScript 单包内没有任何机制阻止 `kernel/` 反向 import `robotics/`。codex 的 crate 依赖图由 Cargo 强制，违规直接编译失败。

### 2.3 协议未先于实现定义

codex 有独立的 `protocol` / `app-server-protocol` / `exec-server-protocol` / `code-mode-protocol` crate，带 schema fixtures 和 precomputed exports 做跨版本回归。

meta-agent 的 `KernelEvent` 只是内部 TS 类型，**没有版本化线协议**。这意味着一旦要接前端、要跨语言、要让 loop 被外部驱动，都要推倒重来。

### 2.4 配置系统单薄

meta-agent：全局 `~/.meta-agent/config.json` + 项目 `.meta-agent/config.json` 两层。
codex：`config` crate 24K LOC，`ConfigLayerStack` / `ConfigLayerSource` 多层（managed / requirements / project / user / session），并有 `Constrained` 类型表达"组织下发不可覆盖项"。

→ meta-agent 无法表达任何企业/团队治理场景。

### 2.5 三套并行的长周期编排机制（概念重复）

这是我认为**最值得优先处理的内部架构债**：

| 机制 | 位置 | 调度 | 状态 | 并发单元 |
| --- | --- | --- | --- | --- |
| auto 自治 | `core/auto/` | `AutoScheduler` + checkpoint/verify/drift | `AutoCheckpointStore` | subagent |
| graph loop | `loop/graph/` | `GraphKernel` + `TransitionEngine` | `GraphStore`（事件溯源） | `LaneManager` |
| campaign | `campaign/` + `coordination/` | `CampaignMonitor`（零 LLM） | `CampaignStateStore` | `WorkerCoordinator` |

三者各有一套状态存储、一套推进逻辑、一套并发原语。已验证：**`campaign/` 与 `coordination/` 对 graph runtime 零引用**，完全平行。graph 至少复用了 `subagent` dispatcher（`loop/seatSpawn.ts`），是三者中耦合最健康的。

代价：三份 checkpoint/恢复/并发上限/预算逻辑要分别维护、分别测、分别修 bug。

### 2.6 无 feature flag 机制

codex 有 `features` crate，新能力可灰度、可按 agent role 开关。meta-agent 靠环境变量散落判断（`META_AGENT_*`），没有统一注册表，也无法按角色/会话粒度控制。

---

## 3. meta-agent 的真实优势（codex 完全没有的）

必须明确：以下四点是 codex 的**空白区**，也是 meta-agent 的护城河，不能在补短板的过程中被稀释。

1. **知识防污染纪律**。三层知识（experience / principle / physical anchor）+ 置信分层（observed → reproduced → derived → reported → hypothesis）+ observation/contradiction 计数 + **强制人工 review** + 晋升硬门槛（检索分 ≥450 且 ≥3 条独立经验收敛）。codex 的 `memories` 是自动抽取自动使用，**没有置信分层、没有矛盾计数、没有人工闸门** —— 它默认知识是干净的。meta-agent 默认知识会被污染，并为此付出了工程代价。这是更正确的假设。
2. **Physical Anchor**。codex 无任何对应物。"不让模型把物理现实推理掉"是纯粹的领域洞察。
3. **graph-2.0：先编译成图，再审，再确定性执行**。自然语言需求 → 蒸馏 → 静态校验 + 独立语义审阅 → 冻结 → 事件溯源执行（effect outbox、可恢复 paused 节点、timer/event、崩溃恢复）。codex 的 multi-agent 是**运行时动态 spawn**，没有"先固化拓扑再执行"这一层。对长周期高风险任务，meta-agent 的模型可控性更强。
4. **Campaign / DOE / 多保真度阶梯 / Pareto 前沿 / 人工检查点**。codex 没有任何实验设计层。

另外，多提供商自动探测（GLM 默认 + DeepSeek/Qwen/Anthropic 统一 thinking 抽象）在国内场景是实打实的优势，codex 深度绑定 OpenAI Responses API。

---

## 4. 可借鉴清单（按性价比排序）

### P0 — 地基级，收益/成本比最高

1. **持久 shell 会话**（对标 `unified_exec`）：`exec_command` + `write_stdin` + `yield_time_ms` 分段返回。现有 `bash` 保留为便捷封装。
2. **`apply_patch` 统一补丁工具 + 每轮 diff 聚合**：一个工具表达多文件 add/delete/update；`turn_diff_tracker` 让每轮产出可审阅的统一 diff，同时成为 revert 单元。
3. **工具懒加载 / `tool_search`**：工具 spec 分 namespace + defer loading。**这是解除 MCP 扩展天花板的前提**，越晚做代价越大。

### P1 — 一到两个月

4. **外部 hook 系统**：直接对标 codex 的 8 事件 + JSON Schema + 外部命令/MCP 执行。现有 `PhaseHooks` 降为内部实现，对外暴露稳定契约。
5. **审批策略声明式化**：`SensitiveCommandPatterns` 正则清单 → 规则文件（可被项目/组织覆盖）；高风险动作可选接一道 LLM guardian 二审。正则清单必然漏（新命令、管道、shell 变形）。
6. **结构化事件 + OTLP**：先把 `KernelEvent` 冻结成**版本化 schema**（这一步同时是 P2 协议层的前置），再接 OpenTelemetry。
7. **state 收敛到 SQLite + migration**：sessions / jobs / subagent tasks / 知识库统一入库，带迁移框架和索引。同时解决检索、清理、schema 演进三个问题。

### P2 — 季度级

8. **app-server 式协议层 + SDK**：让 loop/graph 能被 IDE、Web 前端、其他语言驱动。依赖第 6 项的 schema 冻结。
9. **包拆分 + 领域插件化**：至少拆成 `kernel` / `tools` / `domain(robotics+campaign)` / `cli` 四包；robotics、campaign 改造为插件。过渡期可先用 ESLint import 边界规则做机器强制。借鉴 codex `agent-role` 的**有界覆盖**模型（子代理只能收窄权限）。
10. **Windows 沙箱 + landlock 降级**：`powershell` 工具已有但无沙箱，这是当前唯一"工具可用但保护缺失"的组合，属于隐性风险。
11. **网络出口按域名策略 + 凭据代理**：把 `network: none/unrestricted` 二元升级为策略化。
12. **迁移器**：支持从 Claude Code / codex 导入 config、MCP、memory、subagent 定义。降低切换成本，也是获客手段。

---

## 5. 迭代方向建议

### 5.1 战略定位：不要追全栈

codex 的 117 crate、269K LOC TUI 是数十人年投入。逐项对齐既不可能也不必要。建议的分工是：

- **底座（exec / patch / hook / policy / telemetry / 协议 / 存储）**：把 codex 当作已验证的既有解，用最短路径补齐到"够用"，**明确不追求超越**。这些是通用能力，差异化价值为零。
- **护城河（知识不退化 / 长周期图执行 / 实验设计）**：资源压在这里。codex 在这三块是空白，且短期不会做——它的目标用户是写代码的开发者，不是调机器人的工程师。

### 5.2 首要架构动作：收敛三套长周期编排

把 `auto` 和 `campaign` 统一到 `graph` runtime 上：

- **campaign → graph 的一种 capability pack**：DOE 采样是 function 节点，并行评估是 lane 扇出，Pareto 检查点是 wait 节点，`CampaignMonitor` 的确定性推进正是 `TransitionEngine` 的职责。
- **auto → graph 的一种预置拓扑**：checkpoint 就是 graph 的事件溯源快照，verify/drift 就是特定的 agent 节点。

收益：一套状态存储、一套恢复语义、一套并发/预算上限、一套可观测埋点。当前是三份。这件事**越晚做迁移成本越高**，而且它是第 7 项（SQLite 收敛）的天然前置。

### 5.3 知识系统的下一步：把优势拉得更开

- 借鉴 codex `memories` 的**后台抽取管线**（job claim / lease / backoff）：把 experience 抽取从主循环挪到后台，主循环只负责标记候选。既省 token，又能在 rollout 全文上做更好的提炼——但**保留人工 review 闸门**，这是不能让步的部分。
- 打通 campaign 与知识层：每次 DOE 实验的失败点应自动成为 experience 候选，`invalidatedAssumptions` 应自动回写为 physical anchor 候选。目前两套机制是割裂的。

### 5.4 一个务实的路线图排序

```
Q1: unified_exec + apply_patch/diff + tool_search   ← 解除三个硬天花板
Q2: KernelEvent schema 冻结 → otel;hook 系统外部化;execpolicy
Q3: SQLite 收敛 + 三套编排合一（campaign/auto → graph）
Q4: 协议层 + SDK + 包拆分 + 领域插件化
```

顺序理由：Q1 三项互不依赖、单独可交付、立即改善日常体验；Q2 的 schema 冻结是 Q4 协议层的前置；Q3 的编排合一是 SQLite 收敛的前置（否则要为三套状态各建一次表）。

---

## 附：结论溯源

| 结论 | 依据文件 |
| --- | --- |
| bash 一次性、无持久会话 | `src/tools/shell/bash/index.ts`（314 行，`HARD_MAX_TIMEOUT_MS`） |
| edit_file 为字符串替换且拒绝大文件 | `src/tools/fs/edit_file/index.ts:58` |
| 无 otel/telemetry | 全仓 grep `otel|telemetry|opentelemetry` = 0 命中 |
| 无 sqlite / apply_patch / tool_search / marketplace / oauth / landlock | 全仓 grep = 0 命中 |
| 沙箱仅 Linux/macOS | `src/sandbox/detect.ts` |
| PhaseHooks 仅 inject/abort、进程内 | `src/kernel/loop/PhaseHooks.ts` 头部契约注释 |
| campaign 与 graph runtime 零耦合 | grep `GraphKernel\|graph/runtime` in `src/campaign src/coordination` = 0 |
| graph 复用 subagent dispatcher | `src/loop/seatSpawn.ts` |
| codex hook 八类事件 | `codex-rs/hooks/src/events/`、`hooks/src/schema.rs` fixture 常量 |
| codex guardian 风险分类 | `codex-rs/core/src/guardian/policy.md` |
| codex agent-role 有界覆盖 | `codex-rs/core/src/agent/role.rs` 头部文档注释 |
| codex state 121 行 migrations | `codex-rs/state/src/migrations.rs` |
| codex memories 后台管线 | `codex-rs/state/src/model/memories.rs`（Stage1JobClaimOutcome） |
