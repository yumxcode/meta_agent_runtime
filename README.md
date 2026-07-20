# @meta-agent/runtime

面向工程智能体的 TypeScript 运行时。它把流式模型调用、多轮工具循环、会话状态与恢复、权限与沙箱、上下文压缩、自治执行、并发子代理、实验流程和知识沉淀封装成统一接口,适合构建可长期运行、可追踪、可恢复的 AI 工程代理。既是一个 npm 库,也是一个开箱即用的 CLI。

> 当前版本:`0.7.6` · Node.js `>= 18`

---

## 特性概览

- **五种会话模式**:`agentic`(通用工具循环)、`auto`(无人值守自治 + 工作区监狱)、`simple_auto`(轻量无人值守:沿用 auto 监狱但去掉 checkpoint/drift/verify,面向简单短任务)、`campaign`(DOE/多目标优化)、`robotics`(机器人开发)。模式只会显式选择，未指定时为 `agentic`。
- **长周期 Loop 运行时**:`meta-agent loop ...` 将自然语言需求编译为 `graph-2.0`，再做静态校验与独立语义审阅；提供确定性路由、持久 Lane、直接 Workspace、timer/event、可恢复 paused 节点、Effect outbox、崩溃恢复与单机并发。安全边界由 Kernel 固定，领域节点和拓扑由 LLM 自由生成。
- **多提供商自动选择**:按环境变量优先级自动落到 Zhipu/GLM(默认)、DeepSeek、Qwen、Anthropic;统一封装 thinking/reasoning、计费、betas、消息规范化等差异。
- **主 LLM 扩展思考(默认开启)**:默认 `thinkingConfig: { type: 'adaptive' }`;可关闭或自定义预算;回退模型自动切到更保守的 thinking 配置。
- **多轮工具循环 + 自动上下文压缩**:模型可连续调用文件 / Shell / 网络 / MCP / 自定义工具直至任务完成;接近上下文上限时自动压缩历史,保留任务目标与关键状态锚点。
- **并发子代理**:`run_agent`(同步阻塞)与 `spawn_sub_agent`(异步并行扇出)两条委派路径,隔离上下文、断路器(轮数/预算/时长)、事件驱动完成通知、读默认只读 / 写强制 git 分支隔离。
- **auto 自治模式**:工作区硬监狱(fail-closed 沙箱)、独立的 verify(完成校验)与 drift(目标漂移)关卡子代理、断路器、可中断/可 `--resume` 的 durable checkpoint、失败自动重试、收紧的并发与预算上限。
- **权限与沙箱**:工作目录限制、计划模式只读、敏感命令交互确认、`beforeToolCall` 拦截、OS 级 sandbox(Linux bwrap / macOS sandbox-exec)、工具结果预算截断。
- **工程验证与溯源**:V&V Hook(量纲/单位/物理约束/OOM)、provenance 数据溯源与血缘追踪、单位与量纲系统。
- **Campaign 工作流**:DOE 参数扫描、多保真度筛选、并行评估、多目标 Pareto 分析、论文复现、人工检查点。
- **Robotics 工作流**:硬件档案、三层知识沉淀(经验 / 原则 / 物理锚点)、阶段式工作流、Git 工作树隔离、多单元 Team 协作(git 共享实验记录本)。
- **记忆与定时任务**:跨会话记忆(待审核队列)、cron 定时任务、技能(skill)按需加载。

---

## 设计理念:面向工程问题与机器人算法开发

通用编码代理擅长"把代码写到能跑",但工程系统与机器人算法开发的真正难点不在写代码,而在于四件事:**物理世界会反复证伪你的假设;一条经验要经过多次验证才值得信任;一旦错误结论被沉淀下来,会污染之后的每一个决策;而真正的优化是长周期、多目标、需要人来把关的过程。** meta-agent 为此设计了四套相互咬合的机制——experience、physical anchor、人工 review、campaign。它们共同把"一次性的临场发挥"变成"可累积、可追溯、不退化的工程能力"。

### 1. Experience 机制 —— 把一次踩坑变成可检索、会增值的资产

每次任务中得到的教训(成功或失败)都可以写成一条结构化 **经验(`ExperienceStore`)**,而不是消散在聊天历史里。一条经验不是一段自由文本,而是带 schema 的记录:领域(`domain`)、问题(`problem`)、方案(`solution`)、结果(成功/失败 + 失败原因 + 绕过办法)、被证伪的假设(`invalidatedAssumptions`)、证据引用(`evidenceRefs`,指向实验日志 / commit / 数据手册),以及一个机器模型在写入时抽出的同域抽象原则(`abstractPrinciple`)。

经验自带**置信分层**,避免"听说"和"亲测"被同等对待:`observed`(本项目见过)→ `reproduced`(多次复现)→ `derived`(由物理/数学/规格推导)→ `reported`(论文/文档报告但本地未验证)→ `hypothesis`(仅为合理猜测)。每条经验还记录 `observationCount`(支持它的独立观测数)与 `contradictionCount`(后续证伪它的次数),让信任度随证据动态变化。

经验不是写完就堆着吃灰。每一轮对话,`ExperienceWorkingSetManager` 会按"机制与抽象原则是否真正适用"(本地启发式打分 + 可选的 flash 模型相关性判定)挑出最多 4 条相关经验注入当前上下文——刻意从严,因为**噪声上下文比没有上下文更糟**。

当一类经验被反复验证、足够可信时,会**晋升为原则(`PrincipleStore`)**:可迁移的机制陈述,带第一性原理支撑(`firstPrinciplesSupport`)、适用边界(`applicabilityBounds`)和明确的不适用条件(`nonApplicableWhen`)。晋升有硬门槛,不是攒够数量就行:检索分(由置信层级、观测数、矛盾数加权计算)需 ≥ 450,且至少要有 3 条不同经验共享同一机制(`N_CONVERGENCE = 3`)——**单独一条经验永远只是一个观测点,不会成为原则**。低于阈值的抽象只能由用户显式请求才晋升。这套"经验 → 收敛 → 原则"的路径,让代理越用越懂这台机器、这套系统,而不是每次从零开始。

### 2. Physical Anchor 机制 —— 钉死物理事实,不让模型把现实"推理掉"

大模型最危险的失败模式之一是**自洽地推翻物理现实**:它会顺着一条漂亮的逻辑链,把一个不该忽略的硬件约束当成可以忽略的细节。在机器人算法开发里,这种"推理掉现实"会直接导致仿真很美、上机就炸。

**物理锚点(`PhysicalAnchorStore`)** 就是为对抗这一点设计的:它记录一条具体的、模型不得擅自推翻的物理/设备事实(`fact`),并附上为什么重要的机制(`mechanism`)和对规划/调试的操作性影响(`implication`)。例如"该 IMU 在静止时仍有 X 度/秒的零偏漂移""这个关节的实际力矩上限比额定值低 15%""里程计在地毯上打滑率显著升高"。

锚点带**作用域(`scope`)**:`global`(任何场景)、`robot`(限定某台机器人)、`code`(限定某套代码),确保一台机器的特性不会被错误地套到另一台上。锚点同样记录观测/矛盾计数,并与原则双向链接——物理层级的原则必须由物理锚点背书(`anchoredByPhysicalAnchorIds`)。一句话:experience 沉淀"我们试出来什么",physical anchor 锁定"世界本来是什么样,别忘了"。

### 3. 人工 Review 机制 —— AI 提议,人来裁决

知识库一旦被污染,危害是复利式的:一条错误经验会被检索、被引用、被晋升成原则,持续误导后续所有任务。因此这三类知识(经验、原则、物理锚点)**全部不允许 AI 直接写入共享库**。

当 AI 调用 `experience_write` / 写原则 / 写锚点时,条目先进入对应的**待审核缓冲区**(`ExperiencePendingStore` 等),而不是立即提交。用户通过 `/experience review`、`/principle review`、`/anchor review`(或在会话结束清理时)逐条审阅,**只有被批准的条目才会落入跨会话的共享知识库**。待审核条目会在正常重启后存活,让你在恢复项目后再慢慢审,而且**永不自动提交**。

这条纪律是整套知识系统可信的前提:AI 负责高召回地提议候选,人负责高精度地把关。它把"模型可能写错"这个无法消除的风险,挡在了共享知识库的门外。

### 4. Campaign 机制 —— 把长周期优化变成可监控、有检查点的流程

很多工程与算法问题不是"一次把它做对",而是"在一个参数/设计空间里系统地搜索最优"。这类长周期工作如果全交给 LLM 自由发挥,会失控、会跑偏、会烧钱。**campaign 模式**把它结构化成确定性的工程流程:

- **DOE 参数扫描**(`DOESampler`)系统化采样设计空间,而非随手试几组。
- **多保真度阶梯**(`FidelityLadder`):先用低保真度(L0)快速筛掉大批劣解,只把 top-K 升到中保真度(L1)、再把 top-J 升到高保真度(L2),把昂贵的仿真预算花在刀刃上。
- **并行评估**(`WorkerCoordinator`)同时跑多个候选,结果经 `buildCapsule` 压成 <500 token 的上下文胶囊回灌,不撑爆主上下文。
- **Pareto 多目标分析**(`ParetoAnalyzer`)在相互冲突的目标(如精度 vs 时延 vs 功耗)间给出前沿,而不是假装存在单一最优。
- **零 LLM 的确定性监控**(`CampaignMonitor`)在后台推进阶段、做超时与晋升判定——确定性逻辑负责调度,模型只负责需要判断力的部分。

关键在于**人工检查点**:在每个 `PARETO_READY_*` 阶段,流程会**停下来等用户显式输入**(给足 7 天、监控器绝不替你超时跳过),由你审阅 Pareto 前沿、决定收敛方向或选 top-K 继续。只有当你显式开启 `autoEscalate` 时,流程才会跳过检查点自动晋升。这让长周期优化既能无人值守地推进,又始终把方向盘留在人手里。

### 四者如何咬合

这四套机制不是孤立功能,而是一条闭环:**physical anchor** 先把世界的硬约束钉死,防止规划脱离现实;**campaign** 在这些约束下系统地跑实验、做优化;每次实验产出的教训沉淀为 **experience**,反复验证后收敛、晋升为 **principle**(并由 physical anchor 背书);而所有进入共享知识库的内容都必须先过 **人工 review**。于是代理在同一个项目、同一台机器人上越做越准——经验在累积,原则在固化,物理现实始终被尊重,而人对知识质量和优化方向始终保有最终裁决权。

---

## 安装

```bash
npm install @meta-agent/runtime
```

要求 Node.js `>= 18.0.0`。运行时依赖 `@anthropic-ai/sdk`、`openai`、`zod`。

---

## 提供商与环境变量

运行时按以下优先级自动探测可用提供商(也可在 baseURL/模型名上识别),无需显式配置:

| 优先级 | 提供商 | 环境变量 | 默认模型 | 协议 |
| --- | --- | --- | --- | --- |
| 1 | **Zhipu / GLM**(默认) | `ZHIPU_API_KEY` / `ZAI_API_KEY` / `GLM_API_KEY` | `glm-5.2`(1M 上下文) | Anthropic 兼容 |
| 2 | DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` 系列 | OpenAI 兼容 |
| 3 | Qwen | `QWEN_API_KEY` | `qwen` 系列 | Anthropic 兼容端点 |
| 4 | Anthropic | `ANTHROPIC_API_KEY` | `claude` 系列 | Anthropic 原生 |

也可以在代码或 CLI 里显式传入 `apiKey` / `baseURL` / `model` / `fallbackModel` 覆盖自动探测。

---

## 快速开始

### 在代码中创建会话

```ts
import { SessionRouter, createStandardTools } from '@meta-agent/runtime'

const router = new SessionRouter({
  mode: 'agentic',          // 'agentic' | 'auto' | 'simple_auto' | 'campaign' | 'robotics'
  projectDir: process.cwd(),
  maxTurns: 30,
})

// 组装内置工具(默认包含 fs / shell / network / mcp / ui / system)
const tools = await createStandardTools({
  system: { cwd: process.cwd(), mode: 'agentic' },
})
for (const tool of tools) router.registerTool(tool)

for await (const event of router.submit('分析 src 目录并给出重构建议')) {
  if (event.type === 'text') process.stdout.write(event.text)
  if (event.type === 'result') console.log('\n完成:', event.subtype)
}
```

> 提示:`SessionRouter` 是推荐入口。它会按模式装配后端,并自行注册子代理委派工具(`run_agent` / `spawn_sub_agent` 等),所以并发委派能力无需手动接线。只有需要精确控制单一后端时才直接 `new MetaAgentSession / CampaignSession / RoboticsSession`。

### 使用 CLI

```bash
# 通用工程任务(默认 agentic)
meta-agent "分析当前项目的测试失败原因"

# 指定工作目录(代理只能在该目录内操作)
meta-agent --workspace ~/projects/demo "重构数据处理模块"

# 无人值守自治(工作区内写/删自动批准,全程硬监狱)
meta-agent --mode auto "把构建跑绿,修掉所有失败用例"      # 或 --yolo

# 轻量无人值守(同款工作区监狱,但不启用 checkpoint/drift/verify,适合简单短任务)
meta-agent --mode simple_auto "把 README 里的死链接都修掉"

# 长周期多 Agent Loop（从需求文档生成可审核的执行图）
meta-agent loop distill requirements.md

# 其它模式
meta-agent --mode campaign "做一次 x=[0,10], y=[0,5] 的 DOE 参数扫描"
meta-agent --mode robotics --workspace ~/robot-project "调试导航模块的路径抖动"

# 恢复上一个会话;输出原始 JSON 事件
meta-agent --resume last "继续"
meta-agent --json "检查项目结构"
```

CLI 常用选项:`-m/--mode`、`--yolo`、`-w/--workspace`、`-k/--api-key`、`-b/--base-url`、`--model`、`--fallback-model`、`-t/--max-turns`、`--max-budget-usd`、`-r/--resume`、`--session-dir <dir>`(单次 prompt 运行时把会话历史持久化到该目录,便于后续 `--resume`)、`-y/--yes`、`-d/--debug`、`--show-thinking`、`-j/--json`。交互期内 `Ctrl+G` 注入修正(在下一步边界引导模型,不打断生成),`Ctrl+C` 中断当前轮。运行 `meta-agent --help` 查看全部交互命令(`/team`、`/experience`、`/principle`、`/anchor`、`/memory`、`/sessions`、`/compact` 等)。

---

## 会话模式

| 模式 | 适用场景 | 关键能力 |
| --- | --- | --- |
| `agentic` | 通用工程任务与问答 | 多轮工具调用、文件修改、命令执行、上下文压缩、同步/异步子代理 |
| `auto` | 无人值守自治 | 工作区硬监狱、verify/drift 关卡、断路器、checkpoint/恢复、失败重试、会话级预算 |
| `simple_auto` | 轻量无人值守 | 同款工作区硬监狱与自动批准,但**去掉 checkpoint / drift / verify**;面向简单、短链路任务 |
| `campaign` | 长周期实验/优化 | DOE、多保真度、并行评估、Pareto、论文复现、人工检查点、溯源 |
| `robotics` | 机器人开发 | 硬件档案、三层知识库、工作流阶段、并行实验、Git 工作树、Team 协作 |

### auto 自治模式

`auto` 是为"交代目标后无人值守跑完"设计的模式,在 agentic 之上叠加:

- **工作区硬监狱**:fail-closed OS 沙箱,所有文件写/删被强制约束在工作目录内,配置层无法解锁;同样下发给每个被派生的子代理。
- **verify 关卡**:执行体声明完成时,起一个独立的只读判定子代理,在一次性 git 快照里核验"原始目标是否真的达成",每个"完成"主张都需证据,失败开放(verifier 故障不会卡死已完成的运行)。
- **drift 关卡**:在结构性边界起一个独立子代理,对照原始目标与 durable checkpoint 判断是否跑偏,并可沉淀有据可循的经验教训。
- **断路器与收紧默认**:并发子代理上限收紧到 3、普通子代理共享预算上限默认 \$10；`auto` / `simple_auto` 的主代理、子代理和 gate 共用默认 \$20 会话预算，可用 `--max-budget-usd` 或 `META_AGENT_AUTO_MAX_BUDGET_USD` 覆盖。
- **可中断 / 可恢复**:进度(目标、已完成、待办、产出、在途子代理)写入 durable checkpoint;`--resume` 可继续中断的运行。在已恢复的会话里**输入新需求时,新需求会成为新目标**;只有空输入或"继续/continue"这类续跑信号才保留原目标。

verify 关卡判定子代理的预算可通过环境变量覆盖(默认面向多文件交付物放宽):

| 环境变量 | 默认 | 含义 |
| --- | --- | --- |
| `META_AGENT_VERIFY_MAX_TURNS` | 30 | 判定子代理最大轮次 |
| `META_AGENT_VERIFY_MAX_BUDGET_USD` | 1 | 判定子代理最大花费(美元) |
| `META_AGENT_DRIFT_MAX_BUDGET_USD` | 0.5 | 航向判定子代理最大花费(美元) |
| `META_AGENT_VERIFY_MAX_DURATION_MS` | 1800000 | 判定子代理墙钟上限(ms) |

### simple_auto 轻量自治模式

`simple_auto` 与 `auto` 共享同一套执行后端与**工作区硬监狱**(工作目录内写/删自动批准、配置层无法解锁、同样下发给子代理),但刻意去掉了 `auto` 的三套自监督机制,专注于简单、短链路的无人值守任务:

- **无 checkpoint**:不写 durable checkpoint,也不读旧 checkpoint——本模式不面向"中断后 `--resume` 续跑"的长任务。
- **无 drift 关卡**:不在结构性边界起独立子代理做目标漂移校正。
- **无 verify 关卡**:模型声明完成即视为完成,不再起独立判定子代理做完成度核验。
- **无经验库注入**:不装配 auto 的经验召回/写入。

实现上,内核循环对 checkpoint/drift/verify 三者都是"配置钩子缺失即跳过",`simple_auto` 只是让后端工厂不挂载这些钩子(见 `AgenticBackendFactory` 的 `wantsGates` 开关),因此得到的是"`auto` 的自治与监狱、但没有自监督开销"。和 `auto` 一样,`simple_auto` 仅能**显式进入**(`--mode simple_auto`),绝不会被提示词措辞推断出来。任务一旦变复杂或高风险,建议改用 `auto`。

### 长周期 Loop 运行时

跨阶段长任务使用唯一执行模型 `durable-graph-v2`。它只有三类核心概念：Graph 控制流、Execution Lane、真实项目 Workspace。Agent 直接读写 Workspace；Kernel 只保存路由 State、Activation journal、timer/event 和能力锁，不维护用户数据的副本，也不创建 Lane worktree。

Lane 负责连续会话、串行化和写路径所有权。`workspace.read` 声明输入路径，`workspace.write` 的通用模式只有 `owned | atomic_replace | append_only`，`workspace.deny` 始终优先；Freeze 会拒绝不同 Lane 的重叠写路径。`write_file` 使用原子替换，`append_file` 提供串行追加。强相关的长生命周期工作放在一个 persistent Lane/Agent Activation 中，timer hard park 后仍以同一 Activation 和会话继续。

`loop distill` 是可见的前台 Agentic 编译会话：Architect 读取需求与必要项目文件，生成 Constraint Ledger 和简明 Blueprint（Workspace、Lanes、Control）；Compiler 通过 `graph_reference` 获取精确 `graph-2.0` ABI，生成完整图并调用 `graph_validate`；独立 Reviewer 再对原始需求、Agent prompt 中的直接读写、Workspace ownership、Lane、控制闭环和能力可用性做语义核验。Distill、Create 和 Runtime 使用同一个 `graph_agent` Tool Catalog，Freeze 锁定图实际引用的工具；Reviewer 发现任何合同差异都会拒绝，不允许以 warning 通过。Distill prompt、Validator、Freeze 和 Runtime 共用同一 ABI，不接受旧字段或隐式兼容。

Node 默认使用 `Agent | Wait | Terminal`；只有真实需要纯函数、幂等外部操作或并发汇合时才添加 `Function | Effect | Join`。`$state`、Reducer 和 `when` 提供确定性计数/阈值路由，开放领域判断仍交给 Agent。Kernel 支持 crash recovery、timer、早到 event inbox、event timeout 和 `source + deliveryId` 幂等去重。

快速开始：

```bash
meta-agent -w /path/to/workspace loop distill requirements.md --out loop.graph.json
# 审阅冻结前的图、权限、预算与边
meta-agent -w /path/to/workspace loop create loop.graph.json
meta-agent -w /path/to/workspace loop tick --until-quiescent
meta-agent -w /path/to/workspace loop inspect <instanceId>
meta-agent -w /path/to/workspace loop timeline <instanceId>
meta-agent -w /path/to/workspace loop files <instanceId>
meta-agent -w /path/to/workspace loop disk <instanceId>
```

完整命令和 GraphSpec 示例见 [Loop 使用指南](docs/loop-runtime-guide.md)；执行边界见 [`graph_agent` 执行底座](docs/graph-agent-executor.md)；架构与可靠性边界见 [Durable Graph v2 设计](docs/loop-durable-graph-runtime-plan.md)。领域扩展通过 Capability Pack 提供版本化 Function、Reducer、Effect 和 advisory Scenario guidance。

---

## 子代理与并发

主代理可按任务性质选择**阻塞**或**并发**地把子任务派给隔离子代理(各自独立、空上下文、看不到主会话历史):

| 工具 | 语义 | 何时用 |
| --- | --- | --- |
| `run_agent` | **同步**,阻塞到子代理跑完返回结果 | 下一步依赖该结果、或子任务间有严格依赖 |
| `spawn_sub_agent` | **异步**,立即返回 task_id,后台并发执行 | 相互独立、可并行、长耗时、失败不应阻塞主流程 |
| `get_sub_agent_status` / `_intermediate` / `cancel_sub_agent` / `list_sub_agents` | 异步收口与控制 | 取完整结果、查中途进度、取消、查总览 |
| `research_dispatch` | 同步,隔离调研后只回一行结论 + 落盘报告 | 需要读全文但不想污染主上下文的文献/资料调研 |
| `experiment_dispatch` | 异步(robotics),并行跑实验 | 并行实验,每个在独立 worktree/分支提交,主代理事后合并 |

要点:

- **并发扇出**:在同一轮发出多个 `spawn_sub_agent`,它们会并行执行(后台并发上限默认 4、auto 3);完成后通过系统提示顶部的「Sub-Agent Notifications」段事件驱动回灌,主代理不被阻塞。
- **写隔离(强制)**:`spawn_sub_agent` 默认 `shared_readonly`(只读、可放心并发);要写文件必须显式 `isolated_write`,子代理在独立 git 分支里写、主代理事后用 `auto_merge_subagent` 串行合并——绝不允许多个子代理并发共享写同一棵树。
- **断路器**:每个子代理强制 `maxTurns` / `maxBudgetUsd` / `maxDurationMs`,在代码层而非提示词层执行。

各模式会注入"何时用同步 vs 异步、如何安全并发"的提示引导,降低误选。

---

## 内置工具

`createStandardTools(options)` 组装常用工具集(`include` 默认 `['fs','shell','network','mcp','ui','system']`,可加 `'agent'`):

| 类别 | 工具 |
| --- | --- |
| 文件系统 | `read_file`、`write_file`、`edit_file`、`glob`、`grep`、`notebook_edit` |
| Shell | `bash`、`powershell` |
| 网络 | `web_fetch`、`web_search` |
| MCP | `mcp_call`、`list_mcp_resources`、`read_mcp_resource` |
| UI | `ask_user`、`send_message`、`todo_write`、`progress_note`、`artifacts_register` |
| 系统 | `sleep`、`skill`、`config`、`enter_plan_mode`、`exit_plan_mode`、`cron_create`、`cron_delete`、`cron_list`、`memory_write` |
| 子代理 | `run_agent`、`spawn_sub_agent`、`get_sub_agent_status`、`get_sub_agent_intermediate`、`cancel_sub_agent`、`list_sub_agents`、`research_dispatch` |
| 溯源 | `get_provenance`、`list_recent`、`find_duplicate`、`get_lineage` |
| 工作流 | `workflow_status`、`workflow_advance`、`workflow_complete_gate`、`workflow_list_phases` |
| Robotics | `experiment_dispatch`、`paper_search`、`experience_*`、`principle_*`、`physical_anchor_*`、`hardware_profile_*`、team 工具、git 协调工具 |

> 在 `SessionRouter` 下,子代理委派工具与 research_dispatch 会按模式自动注册;auto 模式还会装配工作区监狱、worktree 隔离与合并工具。`createAutoUiTools()` 为无人值守场景排除 `ask_user`/`send_message`。

### 注册自定义工具

```ts
import type { MetaAgentTool } from '@meta-agent/runtime'

const runSimulationTool: MetaAgentTool = {
  name: 'run_simulation',
  description: '运行仿真并返回关键指标',
  inputSchema: {
    type: 'object',
    properties: {
      configPath: { type: 'string' },
      fidelity: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
    required: ['configPath'],
  },
  async call(input) {
    const result = await runSimulation(String(input.configPath))
    return { content: JSON.stringify(result), isError: false }
  },
}

router.registerTool(runSimulationTool)
```

### 为工具加上验证与溯源

```ts
import { createRuntimeContext, instrumentTool } from '@meta-agent/runtime'

const runtimeContext = createRuntimeContext({ projectDir: process.cwd() })
const safeTool = instrumentTool(runSimulationTool, { runtimeContext })
router.registerTool(safeTool)
```

---

## 扩展思考(thinking / reasoning)

主 LLM 调用默认开启 thinking,模型会先在隐藏的 `thinking` block 里推理再作答。

```ts
import { SessionRouter } from '@meta-agent/runtime'

// 默认即开启,等价 thinkingConfig: { type: 'adaptive' }
new SessionRouter({ projectDir: process.cwd() })

// 明确关闭(对成本/延迟敏感的轻量问答)
new SessionRouter({ thinkingConfig: { type: 'disabled' } })

// Anthropic 自定义预算
new SessionRouter({ thinkingConfig: { type: 'enabled', budgetTokens: 32_000 } })
```

| Provider | 启用时发送 |
| --- | --- |
| Anthropic | `thinking: { type: 'enabled', budget_tokens: N }` + interleaved-thinking beta |
| Zhipu / GLM | Anthropic 兼容端点,接受 thinking 配置 |
| DeepSeek | `reasoning_effort: 'max'`(并上报 `reasoning_content` 流) |
| Qwen | Anthropic 兼容端点,与 Anthropic 行为一致 |

回退到 `fallbackModel` 时自动切到 `fallbackThinkingConfig`(默认 `disabled`),避免 fallback 模型不支持 thinking 时再次失败。

---

## 权限与沙箱

运行时提供多层保护:

- `projectDir` / `--workspace` 限制文件工具只能访问指定工作区。
- 计划模式(`enter_plan_mode`)拦截写操作,仅允许读取与分析。
- 敏感 Shell 命令通过 `askUser` 交互确认(`-y/--yes` 可在可信脚本中跳过)。
- `beforeToolCall` 可在工具执行前 allow / deny / 重定向调用。
- OS 级 sandbox:Linux 走 bwrap、macOS 走 sandbox-exec;auto 模式强制 fail-closed,只放行工作区为可写根。
- 工具结果按预算截断,避免单次返回撑满上下文。

```ts
const router = new SessionRouter({
  projectDir: process.cwd(),
  beforeToolCall: async ({ toolName, input }) => {
    if (toolName === 'bash' && String(input.command).includes('rm -rf')) {
      return { action: 'deny', reason: '禁止执行高风险删除命令' }
    }
    return { action: 'allow' }
  },
})
```

---

## Campaign 模式

用于长周期工程实验与科研流程:DOE 参数扫描、多保真度仿真、并行评估、多目标 Pareto 前沿、论文复现、多阶段推进与人工检查点。核心组件包括 `CampaignStateStore`、`WorkerCoordinator`(并行评估)、`CampaignMonitor`(零 LLM 的确定性后台监控)、`ParetoAnalyzer`、`DOESampler`、`FidelityLadder`,结果经 `buildCapsule` 压成 <500 token 的上下文胶囊注入下一轮。

内置插件:

| 插件 | 说明 |
| --- | --- |
| `doe` | 设计空间采样、多保真度筛选、Pareto 分析 |
| `paper-repro` | 论文解析、实验复现、结果对比 |

---

## Robotics 模式

在通用代理之上叠加机器人开发所需的上下文、知识与协作:

- **硬件档案 `HardwareProfile`**:关节、传感器、执行器、安全边界等;`hardware_profile_*` 工具读写。
- **三层知识沉淀**:`ExperienceStore`(具体经验)、`PrincipleStore`(抽象原则,经验达阈值可晋升)、`PhysicalAnchorStore`(物理锚点);均带"待审核队列 → 人工 review → 提交"的纪律,对应 `/experience`、`/principle`、`/anchor` 命令。
- **工作流**:`WorkflowLoader` 从项目定义加载阶段与 gate,`workflow_*` 工具推进。
- **并行实验**:`experiment_dispatch` 起隔离实验子代理,各自在 `GitWorkspaceManager` 创建的独立工作树/分支提交,主代理用 git 协调工具 diff/merge/discard。
- **Team 协作**:多个"人 + 代理"单元通过 git 共享的实验记录本(`team.json` + 派生 board/log/goals)协作,乐观锁 + 显式抢占;对应 `/team` 系列命令。

---

## MCP 集成

注册任意 MCP 客户端,模型即可通过统一工具调用:

```ts
import { registerMcpClient, type McpClient } from '@meta-agent/runtime'

class MyMcpClient implements McpClient {
  async listTools() { return [] }
  async callTool(name: string, input: unknown) {
    return { content: JSON.stringify({ name, input }), isError: false }
  }
}

registerMcpClient('my-server', new MyMcpClient())
```

注册后,模型可通过 `mcp_call` 调用该服务暴露的工具,`list_mcp_resources` / `read_mcp_resource` 访问其资源。

---

## 开发命令

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 编译库(tsc)并构建 CLI bundle |
| `npm run build:lib` | 仅编译 TypeScript |
| `npm run build:cli` | 仅构建 CLI |
| `npm run dev` | TypeScript watch 模式 |
| `npm test` | 运行 Vitest 全量测试 |
| `npm run typecheck` | 类型检查(`tsc --noEmit`) |
| `npm run test:integration` | mock server 集成/冒烟测试 |
| `npm run pack` | 构建并打包 npm tarball |

---

## 项目结构

```text
docs/             # 架构、设计、报告与评审文档
src/
├── kernel/       # 流式模型调用、工具循环、compact、权限、成本统计
├── core/         # 高层 Session、配置、系统提示、记忆、任务契约、auto checkpoint/verify/drift
├── modes/        # agentic / campaign 后端适配与消息桥接
├── routing/      # 显式模式选择与 SessionRouter
├── providers/    # 多提供商注册表(协议/计费/能力/探测)
├── tools/        # 内置工具(fs/shell/network/mcp/ui/system/agent/provenance/research)
├── subagent/     # 子代理调度、桥接、事件总线、委派工具
├── coordination/ # Campaign 并行评估、Pareto、胶囊、监控
├── campaign/     # Campaign 状态、插件框架、DOE
├── robotics/     # 机器人模式、硬件档案、知识三层、Team 协作
├── workflow/     # 阶段式工作流
├── validation/   # V&V Hook 与内置检查器
├── provenance/   # 数据溯源与血缘
├── units/        # 单位与量纲系统
├── jobs/         # 后台任务系统
├── sandbox/      # OS 级沙箱(bwrap / sandbox-exec)
├── infra/        # 共享基础设施(git 工作树、知识存储、持久化)
├── context/      # 上下文分页与知识源
├── research/     # research_dispatch 结果存储
└── cli/          # 命令行入口
```

文档入口见 [docs/README.md](docs/README.md)。

---

## 导出入口

常用 API(完整列表见 `src/index.ts`):

- 会话:`SessionRouter`、`MetaAgentSession`、`CampaignSession`、`RoboticsSession`
- 工具:`createStandardTools`、`createFsTools`/`createShellTools`/`createNetworkTools`/`createMcpTools`/`createUiTools`/`createSystemTools`、`createRunAgentTool`/`createAgentTools`、`createRoboticsTools`、`EngineeringToolRegistry`
- 运行时与验证:`createRuntimeContext`、`instrumentTool`、`VVHookChain`、`createDefaultVVChain`、`ProvenanceTracker`、`UnitRegistry`
- Campaign:`campaignRegistry`、`CampaignStateStore`、`CampaignMonitor`、`WorkerCoordinator`、`ParetoAnalyzer`、`DOESampler`、`FidelityLadder`
- Robotics 知识:`ExperienceStore`、`PrincipleStore`、`PhysicalAnchorStore`、`HardwareProfile`、`GitWorkspaceManager`
- 其它:`JobManager`、`WorkflowLoader`、`TaskContractStore`、`MCP` 注册(`registerMcpClient`)

类型可直接从包入口导入:

```ts
import type {
  MetaAgentConfig, MetaAgentEvent, MetaAgentTool, ToolResult,
  SessionMode, ThinkingConfig, RouterOptions,
} from '@meta-agent/runtime'
```

---

## 版本

当前包版本:`0.7.6`。
