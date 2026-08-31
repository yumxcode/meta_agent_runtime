# @meta-agent/runtime

面向工程与机器人算法开发的 TypeScript 智能体运行时。把流式模型调用、多轮工具循环、会话恢复、权限与沙箱、上下文压缩、无人值守自治、并发子代理、长周期图循环与知识沉淀封装成统一接口。既是 npm 库,也是开箱即用的 CLI。

> 当前版本:`0.9.7` · Node.js `>= 18` · 全部文档见 [docs/README.md](docs/README.md)

---

## 能力概览

| 能力 | 一句话 | 详情 |
| --- | --- | --- |
| 会话模式 | `agentic` / `auto` / `simple_auto` / `robotics`,只显式选择,默认 `agentic` | [会话模式](#会话模式) |
| 长周期 Loop | 自然语言需求 → `graph-2.0` 执行图 → 静态校验 + 语义审阅 → 冻结 → 可恢复运行 | [图循环使用指南](docs/图循环/图循环使用指南.md) |
| 子代理与并发 | 同步 `run_agent` + 异步 `spawn_sub_agent`;读默认只读、写强制 git 分支隔离 | [子代理与并发](#子代理与并发) |
| 权限与沙箱 | 工作区监狱、OS 级沙箱(bwrap / sandbox-exec)、凭据过滤与输出脱敏 | [权限配置](docs/参考手册/权限配置.md) |
| 内置工具 | fs / shell / network / mcp / ui / system;持久 shell 会话、原子多文件补丁、工具懒加载 | [内置工具](#内置工具) |
| 知识沉淀 | experience → principle 收敛 + physical anchor;全部经人工 review 才入共享库 | [知识系统 v1](docs/知识系统/知识系统v1-经验与锚点.md) |
| 轨迹与复盘 | 统一 JSONL 轨迹(默认开启)+ 手动启动的 Reviewer 任务复盘 | [轨迹与复盘](#轨迹与复盘) |
| 多提供商 | 按环境变量自动落到 Zhipu/GLM(默认)、DeepSeek、Qwen、Anthropic | [提供商与环境变量](#提供商与环境变量) |
| 可观测性 | 版本化 `KernelEvent` 契约、结构化遥测(默认关闭)、9 个生命周期 Hook | [配置参考](docs/参考手册/配置参考.md) |
| 工程验证 | V&V Hook(量纲 / 单位 / 物理约束 / OOM)、provenance 血缘追踪 | [架构参考](docs/architecture/meta-agent-architecture.md) |

---

## 设计理念

通用编码代理擅长"把代码写到能跑",但工程系统与机器人算法开发的难点不在写代码:**物理世界会反复证伪假设;一条经验要多次验证才值得信任;一旦错误结论被沉淀,会污染之后每一个决策。** 三套相互咬合的机制针对这三件事:

- **Experience** —— 每次踩坑写成带 schema 的结构化经验(领域 / 问题 / 方案 / 结果 / 被证伪的假设 / 证据引用),带 `observed → reproduced → derived → reported → hypothesis` 置信分层与观测/矛盾计数。每轮最多注入 4 条相关经验——**噪声上下文比没有上下文更糟**。反复验证且检索分达标(≥ 450 且 ≥ 3 条不同经验共享同一机制)才**晋升为原则**。
- **Physical Anchor** —— 记录模型不得擅自推翻的物理/设备事实,附机制与操作性影响,带 `global / robot / code` 作用域。对抗大模型最危险的失败模式:顺着漂亮的逻辑链把硬件约束"推理掉",仿真很美、上机就炸。
- **人工 Review** —— 经验、原则、锚点**全部不允许 AI 直接写入共享库**,先落待审缓冲区,由 `/experience review`、`/principle review`、`/anchor review` 逐条裁决。待审条目重启后存活,**永不自动提交**。AI 负责高召回地提议,人负责高精度地把关。

机制细节与取舍见 [知识系统 v1](docs/知识系统/知识系统v1-经验与锚点.md)、[物理锚点接入方案](docs/知识系统/物理锚点接入方案.md)、[原则机制改进方案](docs/知识系统/原则机制改进方案.md)。

---

## 安装

```bash
npm install @meta-agent/runtime
```

要求 Node.js `>= 18.0.0`。运行时依赖仅 `@anthropic-ai/sdk`、`openai`、`zod` 三个纯 JS 包。

---

## 提供商与环境变量

按以下优先级自动探测(也可从 baseURL / 模型名识别),无需显式配置:

| 优先级 | 提供商 | 环境变量 | 默认模型 | 协议 |
| --- | --- | --- | --- | --- |
| 1 | **Zhipu / GLM**(默认) | `ZHIPU_API_KEY` / `ZAI_API_KEY` / `GLM_API_KEY` | `glm-5.2`(1M 上下文) | Anthropic 兼容 |
| 2 | DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` 系列 | OpenAI 兼容 |
| 3 | Qwen | `QWEN_API_KEY` | `qwen` 系列 | Anthropic 兼容端点 |
| 4 | Anthropic | `ANTHROPIC_API_KEY` | `claude` 系列 | Anthropic 原生 |

也可显式传入 `apiKey` / `baseURL` / `model` / `fallbackModel` 覆盖。多账号并行时,`meta-agent` 读 `~/.meta-agent/config.json`,`meta-agent-glm` 读 `~/.meta-agent/glm_config.json`,或用 `META_AGENT_CONFIG_FILE=/path/to/account.json` 指定任意配置文件。

完整配置项、超时与环境变量清单见 [配置参考](docs/参考手册/配置参考.md)。

---

## 快速开始

### 在代码中创建会话

```ts
import { SessionRouter, createStandardTools } from '@meta-agent/runtime'

const router = new SessionRouter({
  mode: 'agentic',          // 'agentic' | 'auto' | 'simple_auto' | 'robotics'
  projectDir: process.cwd(),
  maxTurns: 30,
})

// 组装内置工具(默认 fs / shell / network / mcp / ui / system)
const tools = await createStandardTools({
  system: { cwd: process.cwd(), mode: 'agentic' },
})
for (const tool of tools) router.registerTool(tool)

for await (const event of router.submit('分析 src 目录并给出重构建议')) {
  if (event.type === 'text') process.stdout.write(event.text)
  if (event.type === 'result') console.log('\n完成:', event.subtype)
}
```

> `SessionRouter` 是推荐入口:按模式装配后端,并自动注册子代理委派工具(`run_agent` / `spawn_sub_agent` 等),并发委派无需手动接线。

### 使用 CLI

```bash
# 通用工程任务(默认 agentic)
meta-agent "分析当前项目的测试失败原因"

# 指定工作目录(代理只能在该目录内操作)
meta-agent --workspace ~/projects/demo "重构数据处理模块"

# 无人值守自治(工作区内写/删自动批准,全程硬监狱)
meta-agent --mode auto "把构建跑绿,修掉所有失败用例"      # 或 --yolo

# 轻量无人值守(同款监狱,不启用 checkpoint/drift/verify)
meta-agent --mode simple_auto "把 README 里的死链接都修掉"

# 机器人开发
meta-agent --mode robotics --workspace ~/robot-project "调试导航模块的路径抖动"

# 长周期多 Agent Loop(从需求文档生成可审核的执行图)
meta-agent loop distill requirements.md

# 恢复上一个会话;输出原始 JSON 事件
meta-agent --resume last "继续"
meta-agent --json "检查项目结构"
```

常用选项:`-m/--mode`、`--yolo`、`-w/--workspace`、`-k/--api-key`、`-b/--base-url`、`--model`、`--fallback-model`、`-t/--max-turns`、`--max-budget-usd`、`-r/--resume`、`--session-dir <dir>`、`--attached`、`-y/--yes`、`-d/--debug`、`--show-thinking`、`-j/--json`。交互期内 `Ctrl+G` 注入修正(下一步边界生效,不打断生成),`Ctrl+C` 中断当前轮。`meta-agent --help` 查看全部交互命令(`/team`、`/experience`、`/principle`、`/anchor`、`/memory`、`/sessions`、`/compact` 等)。

---

## 会话模式

模式**只能显式选择**,绝不会被提示词措辞推断出来。

| 模式 | 适用场景 | 关键能力 |
| --- | --- | --- |
| `agentic` | 通用工程任务与问答 | 多轮工具调用、文件修改、命令执行、上下文压缩、同步/异步子代理 |
| `auto` | 无人值守自治 | 工作区硬监狱、verify/drift 关卡、断路器、checkpoint/恢复、失败重试、会话预算 |
| `simple_auto` | 轻量无人值守 | 同款监狱与自动批准,但**去掉 checkpoint / drift / verify**,面向简单短链路任务 |
| `robotics` | 机器人开发 | 硬件档案、三层知识库、工作流阶段、并行实验、Git 工作树、Team 协作 |

> `campaign`(DOE 参数扫描 / 多保真度 / Pareto 多目标优化)仍在开发中,尚未对外提供,类型与源码中的残留请勿依赖。

### auto 与 simple_auto

`auto` 在 agentic 之上叠加四层自监督:

- **工作区硬监狱** —— fail-closed OS 沙箱,写/删强制约束在工作目录内,配置层无法解锁,同样下发给每个子代理。
- **verify 关卡** —— 声明完成时起独立只读判定子代理,在一次性 git 快照里核验目标是否真的达成;失败开放(verifier 故障不卡死已完成的运行)。
- **drift 关卡** —— 在结构性边界起独立子代理,对照原始目标与 checkpoint 判断是否跑偏。
- **可中断 / 可恢复** —— 进度写入 durable checkpoint,`--resume` 继续。已恢复会话里**输入新需求即成为新目标**,只有空输入或"继续"才保留原目标。

默认预算:并发子代理上限 3、普通子代理共享 \$10;主代理 + 子代理 + gate 共用 \$20 会话预算(`--max-budget-usd` 或 `META_AGENT_AUTO_MAX_BUDGET_USD` 覆盖)。gate 子代理预算另由 `META_AGENT_VERIFY_MAX_TURNS`(30)、`META_AGENT_VERIFY_MAX_BUDGET_USD`(1)、`META_AGENT_DRIFT_MAX_BUDGET_USD`(0.5)、`META_AGENT_VERIFY_MAX_DURATION_MS`(1800000)调整。

`simple_auto` 共享同一执行后端与硬监狱,但不写/读 checkpoint、不起 drift 与 verify 关卡、不装配经验库注入。实现上内核对三者都是"钩子缺失即跳过",后端工厂的 `wantsGates` 开关决定是否挂载。任务一旦变复杂或高风险,改用 `auto`。

设计与闭环细节见 [自动模式设计](docs/自动模式/自动模式设计.md)、[闭环控制:验证与漂移](docs/自动模式/闭环控制-验证与漂移-2026-06-17.md)。

### 定时恢复与 attached

```bash
# plain auto 的持久定时恢复调度器(一个 workspace 一个常驻进程)
meta-agent -w /path/to/project auto-scheduler

# 单终端管理全部 workspace；全局最多同时执行 3 个 Auto turn
meta-agent tasks --manage --max-running 3

# attached:原命令窗口等待,到期后仍在原窗口继续输出
meta-agent -w /path/to/project --mode auto --attached "持续检查任务,必要时用 self_timer 等待"
```

`auto` 中的 `self_timer` 是**持久化 park**,不是进程内 `sleep`:CLI 先保存完整会话与 checkpoint 再写 wake,默认随后退出,由独立 `auto-scheduler` 或 `tasks --manage` 到期恢复同一 session/goal。manage TUI 中选择任务按 `r` 可立即运行，无需额外 scheduler shell；`--max-running` 是跨 workspace 的全局执行上限。选中正在运行的托管任务时，TUI 下半区会实时跟随它的 Agent 回复、工具调用/结果、重试和终态信息。attached 模式下等待阶段 `Ctrl+C` 仅解除附着并保留 wake;执行中 `Ctrl+C` 表示放弃该 Auto 会话并取消其全部 wake(已写入工作区的文件修改不回滚)。`simple_auto` 不暴露该工具。机制与部署见 [自动调度器](docs/自动模式/自动调度器.md)。

---

## 长周期 Loop 运行时

跨阶段长任务使用唯一执行模型 `durable-graph-v2`,只有三类核心概念:**Graph 控制流、Execution Lane、真实项目 Workspace**。Agent 直接读写 Workspace;Kernel 只保存路由 State、Activation journal、timer/event 与能力锁,不维护用户数据副本。安全边界由 Kernel 固定,领域节点和拓扑由 LLM 自由生成。

四条默认边界:

- 路由、计数、阈值、预算、等待和终态转移由 Graph/Kernel 确定执行,**Agent 不输出 `next_node` / `stop` 等路由命令**。
- 工作 Agent 只能提出完成候选与证据,独立只读 Reviewer(或已注册的确定性 Function)核验后才能进入业务 `done`。
- 文件访问由 `lane.workspace` 的 read/write/deny 与单写者规则审计、由沙箱执行;Freeze 拒绝不同 Lane 的重叠写路径。
- 除真实的权限、并发、外部事件或失败隔离边界外,研究、实现、评测、恢复与记录尽量留在同一个 persistent Worker 中。

**路由是有序决策列表**:同一 `(from, on)` 下的条件边按数组声明顺序 first-match,分支之间不需要互斥,也不需要 `priority`。这不是风格偏好——早先要求唯一 priority 时,一张实测图上 18 条条件边产生了 76 对人工互斥义务,其中 66 对(87%)根本不可能同时为真,而全部路由失败都源于这些数字排错。

```bash
# 可选:需求含"最多 N 轮""完成即结束"这类需澄清约束时,先共创约束台账
meta-agent -w /path/to/workspace loop intake requirements.md
meta-agent -w /path/to/workspace loop distill requirements.md --out loop.graph.json
# 审阅冻结前的图、权限、预算与边
meta-agent -w /path/to/workspace loop create loop.graph.json
meta-agent -w /path/to/workspace loop tick --until-quiescent
meta-agent -w /path/to/workspace loop inspect <instanceId>
meta-agent -w /path/to/workspace loop timeline <instanceId>
```

- `loop intake`(可选前置)把 Compiler 修不好的缺口提前问出来:探针题库由阻断枚举反查,先机械预检(查文件、查 PATH、比对已注册能力)再只问查不出的部分,产出人已逐条确认的 Constraint Ledger(`loop.intake.json`)。需求文件一改按 sha 自动失效;`--no-intake` 走原路径。
- `loop distill` 是可见的前台编译会话:Architect 出 Constraint Ledger 与 Blueprint,Compiler 按 `graph-2.0` ABI 生成完整图并 `graph_validate`,独立 Semantic Reviewer 再做语义核验。阻断级合同差异拒绝候选,拓扑粒度等 advisory 只记录不阻断。
- 语义复核按"可观测优先于可阻断"收敛:宿主持有跨轮 verdict 台账,证据区域未变的约束不重复裁决;Reviewer 必须为每条 hard constraint 给出一行裁决,缺行整份作废。

| 主题 | 文档 |
| --- | --- |
| 完整命令、GraphSpec 示例 | [图循环使用指南](docs/图循环/图循环使用指南.md) |
| 节点执行边界与替换契约 | [`graph_agent` 执行底座](docs/图循环/图代理执行底座.md) |
| 架构与可靠性边界 | [持久化图循环设计 v2](docs/图循环/持久化图循环设计-v2.md) |
| Intake 与语义复核收敛 | [Distill 接入与复核收敛方案](docs/图循环/Distill接入与复核收敛方案-2026-07-31.md) |
| Capability Pack / GitHub Actions Pack | [支持包:证据与外部契约](docs/图循环/支持包-证据与外部契约.md) |

---

## 子代理与并发

主代理可按任务性质选择**阻塞**或**并发**地把子任务派给隔离子代理(各自独立、空上下文、看不到主会话历史):

| 工具 | 语义 | 何时用 |
| --- | --- | --- |
| `run_agent` | **同步**,阻塞到子代理跑完 | 下一步依赖该结果、或子任务间有严格依赖 |
| `spawn_sub_agent` | **异步**,立即返回 task_id | 相互独立、可并行、长耗时、失败不应阻塞主流程 |
| `get_sub_agent_status` / `_intermediate` / `cancel_sub_agent` / `list_sub_agents` | 异步收口与控制 | 取结果、查进度、取消、查总览 |
| `research_dispatch` | 同步,隔离调研后只回一行结论 + 落盘报告 | 需读全文但不想污染主上下文的资料调研 |
| `experiment_dispatch` | 异步(robotics),各自独立 worktree/分支 | 并行实验,主代理事后合并 |

- **并发扇出**:同一轮发出多个 `spawn_sub_agent` 并行执行(后台上限默认 4、auto 3),完成后经系统提示顶部的「Sub-Agent Notifications」事件驱动回灌。
- **写隔离(强制)**:`spawn_sub_agent` 默认 `shared_readonly`;要写文件必须显式 `isolated_write`,子代理在独立 git 分支写、主代理用 `auto_merge_subagent` 串行合并——绝不允许多个子代理并发共享写同一棵树。
- **断路器**:每个子代理强制 `maxTurns` / `maxBudgetUsd` / `maxDurationMs`,在代码层而非提示词层执行。

---

## 内置工具

`createStandardTools(options)` 组装常用工具集(`include` 默认 `['fs','shell','network','mcp','ui','system']`,可加 `'agent'`):

| 类别 | 工具 |
| --- | --- |
| 文件系统 | `read_file`、`write_file`、`append_file`、`edit_file`、`apply_patch`、`turn_diff`、`glob`、`list_dir`、`grep`、`notebook_edit` |
| Shell | `bash`、`powershell`、`exec_session`、`write_stdin`、`close_session` |
| 网络 | `web_fetch`、`web_search` |
| MCP | `mcp_call`、`list_mcp_resources`、`read_mcp_resource` |
| UI | `ask_user`、`send_message`、`todo_write`、`progress_note`、`artifacts_register` |
| 系统 | `sleep`、`skill`、`config`、`enter_plan_mode`、`exit_plan_mode`、`cron_*`、`memory_write` |
| 子代理 | `run_agent`、`spawn_sub_agent`、`get_sub_agent_status`、`get_sub_agent_intermediate`、`cancel_sub_agent`、`list_sub_agents`、`research_dispatch` |
| 溯源 | `get_provenance`、`list_recent`、`find_duplicate`、`get_lineage` |
| 工作流 | `workflow_status`、`workflow_advance`、`workflow_complete_gate`、`workflow_list_phases` |
| Robotics | `experiment_dispatch`、`paper_search`、`experience_*`、`principle_*`、`physical_anchor_*`、`hardware_profile_*`、team 与 git 协调工具 |

> 在 `SessionRouter` 下,子代理委派工具按模式自动注册;auto 模式还会装配工作区监狱、worktree 隔离与合并工具。`createAutoUiTools()` 为无人值守场景排除 `ask_user`/`send_message`。

三个值得单独知道的设计:

- **持久 Shell 会话** —— `exec_session` / `write_stdin` / `close_session` 让进程跨工具调用存活,覆盖 `bash` 做不到的三件事:REPL 交互、`cd`/`export`/`source` 状态保持、长任务中途观察。守卫栈与一次性 `bash` 逐条对齐(cwd 监狱、凭据过滤、OS 沙箱、独立进程组、输出脱敏),隔离按 `agentId` 而非 `sessionId`。是管道不是 PTY:块缓冲程序需 `python3 -u` / `stdbuf -oL`,全屏 TTY 程序不可用。
- **原子多文件补丁** —— `apply_patch` 在一次调用里完成新增/修改/删除/重命名,分三阶段(校验全部路径 → 内存算出最终内容 → 才写盘),中途失败逆序回滚。格式刻意不带行号:那是模型唯一算不准的部分。`turn_diff` 把本轮所有改动聚合成统一 diff,支持 `stat` 与整轮 `revert`(轮粒度撤销,shell 造成的改动追踪不到)。
- **工具懒加载** —— 工具可声明 `namespace` + `deferLoading`,schema 不进每轮请求,由 `tool_search` 按需载入。**隐藏的只是 schema,不是权限**——被隐藏的工具仍可执行;揭示对整个会话粘滞。默认不 defer 任何类别:对 fs/shell/ui 做延迟是有害的(看不到怎么读文件时,模型不会去搜索,它会瞎猜)。排障用 `META_AGENT_TOOLS_EAGER=1`。

### 注册自定义工具

```ts
import type { MetaAgentTool } from '@meta-agent/runtime'
import { createRuntimeContext, instrumentTool } from '@meta-agent/runtime'

const runSimulationTool: MetaAgentTool = {
  name: 'run_simulation',
  description: '运行仿真并返回关键指标',
  inputSchema: {
    type: 'object',
    properties: { configPath: { type: 'string' } },
    required: ['configPath'],
  },
  async call(input) {
    const result = await runSimulation(String(input.configPath))
    return { content: JSON.stringify(result), isError: false }
  },
}

// 可选:挂上 V&V 校验与数据溯源
const runtimeContext = createRuntimeContext({ projectDir: process.cwd() })
router.registerTool(instrumentTool(runSimulationTool, { runtimeContext }))
```

---

## 权限与沙箱

多层保护,由外到内:

- `projectDir` / `--workspace` 限制文件工具只能访问指定工作区;计划模式(`enter_plan_mode`)拦截写操作。
- 敏感 Shell 命令交互确认(`-y/--yes` 跳过);`beforeToolCall` 可在执行前 allow / deny / 重定向。
- OS 级 sandbox:Linux 走 bwrap、macOS 走 sandbox-exec;auto 模式强制 fail-closed,只放行工作区为可写根。
- 默认隐藏凭证目录(`~/.ssh`、`~/.aws`、`~/.config/gh` …);子进程环境变量过滤,输出按名称与**值形态**双重脱敏(`ghp_…`、`AKIA…`、`postgres://user:pw@…`)。
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

工作区之外的读写授权全部走 `config.json` 的 `sandbox.*`(全局 `~/.meta-agent/config.json`,项目内 `<project>/.meta-agent/config.json` 优先)。**这是唯一能授予宿主路径的地方**——模型改不了,工具自己的声明也只能「要求」一个已被授权的路径,不能新增。授权按路径段匹配(`/data/shared` 不连带 `/data/shared-backup`),同时作用于 OS 沙箱与 kernel 权限 jail;`readDenyPaths` 永远压过显式 allow;`network: "none"` 是粘性的。

完整字段、默认值与常见坑见 [权限配置](docs/参考手册/权限配置.md) 与 [配置参考](docs/参考手册/配置参考.md#完整文件长这样带注释版)。

---

## 轨迹与复盘

| 组件 | 成熟度 | 说明 |
| --- | --- | --- |
| 轨迹记录(A3) | **已交付**(v0.9.2) | 统一 JSONL 轨迹,默认开启 |
| Reviewer 复盘 | **已交付**(v0.9.3) | 核心闭环可用,跨任务聚类与矛盾分析待实现 |
| 人工验收(T3) | **已交付**(v0.9.4) | `reviewer rate`,系统内第一个可锚定晋升的证据 |
| 自进化 G0 信任契约 | **已交付**(v0.9.4) | 注入 provenance 可归因、注入渲染器已建(未接线) |
| 自进化 G1 评测底座 | **已交付**(v0.9.4) | 隔离 runner + 合成 fixture 端到端;首批真实用例待人工策展 |
| 自进化 G2 及之后 | **未放行** | 需先有真实评测集,见实施计划 |

**轨迹记录**:每次运行按 `subject` 落一条带 schemaVersion 的 canonical JSONL(`~/.meta-agent/trajectories/<id>/trajectory.jsonl`),条目按 ordinal 可定位,写入前过脱敏。默认开启(测试环境除外),`META_AGENT_TRAJECTORY=0` 关闭。

```bash
meta-agent trajectory list [--search kw] [--limit N]
meta-agent trajectory inspect|tail|verify|reindex|disk|telemetry|parity|gc <id>
```

**Reviewer** 是人手动启动的一等分析模式:把 root / child / 多次 run 聚成 `TaskCase`,复用 KernelLoop 生成过程审计 `TaskReview`,只有高价值、可迁移的方法论 Finding 才形成 `LearningProposal`。它回答的不是"做完了没",而是**路径选择是否合理、成功指标是否合适、完成声明是否诚实、长周期是否发生遗忘或目标偏移**。硬约束:只有 TaskCase 内的只读证据工具、每个结论必须引用 ordinal、AI 产物一律 `pending`、**只有人工 approve 才能创建 `ExperienceCandidate`**。

```bash
meta-agent reviewer run [--all|--limit N] [--trajectory ID] [--since 7d]
meta-agent reviewer reports | report <taskReviewId>
meta-agent reviewer list [--status pending|approved|rejected] | show <proposalId>
meta-agent reviewer review | approve <id> [--note] | reject <id> [--reason]
```

**自进化**目前只有 G0 契约层落地(`EvaluatorTrust`:LLM judge 不是 reward;`Eligibility`:可审计不等于可用;`InjectionProvenance`:记录注入了什么、不改变注入什么)。G2 仅限只读分析,G3 及之后为 No-Go。

设计与门槛见 [轨迹学习 Reviewer 模式设计](docs/知识系统/轨迹学习Reviewer模式设计.md)、[自进化实施计划](docs/知识系统/自进化实施计划.md)、[自进化方案审查(2026-08-25)](docs/reviews/meta-agent-自进化方案审查-2026-08-25.md)。

---

## Robotics 模式

在通用代理之上叠加机器人开发所需的上下文、知识与协作:

- **硬件档案 `HardwareProfile`** —— 关节、传感器、执行器、安全边界;`hardware_profile_*` 读写。
- **三层知识沉淀** —— `ExperienceStore` / `PrincipleStore` / `PhysicalAnchorStore`,均带"待审队列 → 人工 review → 提交"纪律。
- **工作流** —— `WorkflowLoader` 从项目定义加载阶段与 gate,`workflow_*` 推进。见 [工作流系统设计](docs/工作流/工作流系统设计.md)。
- **并行实验** —— `experiment_dispatch` 起隔离实验子代理,各自在 `GitWorkspaceManager` 创建的工作树/分支提交,主代理用 git 协调工具 diff/merge/discard。
- **Team 协作** —— 多个"人 + 代理"单元通过 git 共享实验记录本(`team.json` + 派生 board/log/goals),乐观锁 + 显式抢占;对应 `/team` 系列命令。

行为示例见 [场景手册:循环 / 压缩 / 提示词](docs/机器人模式/场景手册-循环与压缩与提示词-2026-06-12.md)。

---

## MCP 集成

```ts
import { registerMcpClient, type McpClient } from '@meta-agent/runtime'

class MyMcpClient implements McpClient {
  async listTools() { return [] }
  async callTool(name: string, input: unknown) {
    return { content: [{ type: 'text', text: JSON.stringify({ name, input }) }], isError: false }
  }
}

registerMcpClient('my-server', new MyMcpClient())
```

注册后模型可通过 `mcp_call` 调用其工具,`list_mcp_resources` / `read_mcp_resource` 访问其资源。

**MCP Apps(可选浏览器 Host)**:CLI 默认纯文本;`meta-agent ui` 会在回环地址启动临时 sidecar,把带 `_meta.ui.resourceUri` 的 `text/html;profile=mcp-app` Resource 显示在沙箱 iframe 中。Host 仅监听 `127.0.0.1` 并使用每次随机生成的 URL token;iframe 不获得同源权限,外部资源受 `_meta.ui.csp` 白名单约束;App 发起 `tools/call` 时父页面逐次确认,并限制在原 Server 且工具须对 `app` 可见。不用 `ui` 子命令时自动降级为文本 `content`。

```bash
meta-agent ui
meta-agent ui --ui-port 43100 --no-open
```

---

## 扩展思考(thinking / reasoning)

主 LLM 默认开启(等价 `thinkingConfig: { type: 'adaptive' }`),回退到 `fallbackModel` 时自动切到 `fallbackThinkingConfig`(默认 `disabled`)。

```ts
new SessionRouter({ thinkingConfig: { type: 'disabled' } })                    // 关闭
new SessionRouter({ thinkingConfig: { type: 'enabled', budgetTokens: 32_000 } }) // 自定义预算
```

| Provider | 启用时发送 |
| --- | --- |
| Anthropic | `thinking: { type: 'enabled', budget_tokens: N }` + interleaved-thinking beta |
| Zhipu / GLM · Qwen | Anthropic 兼容端点,与 Anthropic 行为一致 |
| DeepSeek | `reasoning_effort: 'max'`(并上报 `reasoning_content` 流) |

---

## 开发命令

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 编译库(tsc)并构建 CLI bundle |
| `npm run dev` | TypeScript watch 模式 |
| `npm test` | 运行 Vitest 全量测试 |
| `npm run typecheck` | 类型检查(`tsc --noEmit`) |
| `npm run test:integration` | mock server 集成/冒烟测试 |
| `npm run pack` | 构建并打包 npm tarball |

---

## 项目结构

```text
docs/             # 架构、设计、报告与评审文档(索引见 docs/README.md)
src/
├── kernel/       # 流式模型调用、工具循环、compact、权限、工具可见性、事件契约、遥测、hook
├── core/         # 配置、系统提示、记忆、任务契约、auto checkpoint/verify/drift、调度器
├── modes/        # MetaAgentSession 门面 + 后端适配与消息桥接
├── routing/      # 显式模式选择与 SessionRouter
├── loop/         # 长周期图循环:图规范/冻结、事件溯源运行时、蒸馏、宿主调度
├── providers/    # 多提供商注册表(协议/计费/能力/探测)
├── tools/        # 内置工具(fs/shell/network/mcp/ui/system/agent/provenance/research)
├── subagent/     # 子代理调度、桥接、事件总线、委派工具
├── trajectory/   # 统一轨迹记录、索引、健康度与投影
├── reviewer/     # 任务复盘:TaskCase、TaskReview、学习提案与人工闸门
├── evolution/    # 自进化契约层(信任、资格、注入溯源);实施中
├── robotics/     # 机器人模式、硬件档案、知识三层、Team 协作
├── workflow/     # 阶段式工作流
├── validation/   # V&V Hook 与内置检查器
├── provenance/   # 数据溯源与血缘
├── units/        # 单位与量纲系统
├── sandbox/      # OS 级沙箱(bwrap / sandbox-exec)
├── infra/        # 共享基础设施(git 工作树、知识存储、持久化、持久 shell、diff/补丁、env)
├── context/      # 上下文分页与知识源
├── jobs/         # 后台任务系统
├── research/     # research_dispatch 结果存储
└── cli/          # 命令行入口与子命令
```

---

## 导出入口

常用 API(完整列表见 `src/index.ts`):

- **会话**:`SessionRouter`、`MetaAgentSession`、`RoboticsSession`
- **工具**:`createStandardTools`、`createFsTools` / `createShellTools` / `createNetworkTools` / `createMcpTools` / `createUiTools` / `createSystemTools`、`createRunAgentTool` / `createAgentTools`、`createRoboticsTools`、`EngineeringToolRegistry`
- **运行时与验证**:`createRuntimeContext`、`instrumentTool`、`VVHookChain`、`createDefaultVVChain`、`ProvenanceTracker`、`UnitRegistry`
- **知识**:`ExperienceStore`、`PrincipleStore`、`PhysicalAnchorStore`、`HardwareProfile`、`GitWorkspaceManager`
- **轨迹与复盘**:`trajectory/*`(recorder、reader、indexStore、health)、`ReviewerStore`、`runTaskReviews`、`KernelTaskCaseReviewer`
- **其它**:`AutoScheduler`、`JobManager`、`WorkflowLoader`、`TaskContractStore`、`registerMcpClient`

```ts
import type {
  MetaAgentConfig, MetaAgentEvent, MetaAgentTool, ToolResult,
  SessionMode, ThinkingConfig, RouterOptions,
} from '@meta-agent/runtime'
```

---

## 版本

当前包版本:`0.9.7`。版本号由 `npm run version:sync` 与 `package.json` 保持一致。
