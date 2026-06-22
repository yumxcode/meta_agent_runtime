# @meta-agent/runtime

面向工程智能体的 TypeScript 运行时。它把流式模型调用、多轮工具循环、会话状态与恢复、权限与沙箱、上下文压缩、自治执行、并发子代理、实验流程和知识沉淀封装成统一接口,适合构建可长期运行、可追踪、可恢复的 AI 工程代理。既是一个 npm 库,也是一个开箱即用的 CLI。

> 当前版本:`0.3.3` · Node.js `>= 18`

---

## 特性概览

- **四种会话模式**:`agentic`(通用工具循环)、`auto`(无人值守自治 + 工作区监狱)、`campaign`(DOE/多目标优化)、`robotics`(机器人开发)。外加 `detect` 哨兵按提示词与环境自动选择。
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
  mode: 'agentic',          // 'detect' | 'agentic' | 'auto' | 'campaign' | 'robotics'
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

# 其它模式
meta-agent --mode campaign "做一次 x=[0,10], y=[0,5] 的 DOE 参数扫描"
meta-agent --mode robotics --workspace ~/robot-project "调试导航模块的路径抖动"

# 恢复上一个会话;输出原始 JSON 事件
meta-agent --resume last "继续"
meta-agent --json "检查项目结构"
```

CLI 常用选项:`-m/--mode`、`--yolo`、`-w/--workspace`、`-k/--api-key`、`-b/--base-url`、`--model`、`--fallback-model`、`-t/--max-turns`、`-r/--resume`、`--session-dir <dir>`(单次 prompt 运行时把会话历史持久化到该目录,便于后续 `--resume`)、`-y/--yes`、`-d/--debug`、`--show-thinking`、`-j/--json`。交互期内 `Ctrl+G` 注入修正(在下一步边界引导模型,不打断生成),`Ctrl+C` 中断当前轮。运行 `meta-agent --help` 查看全部交互命令(`/team`、`/experience`、`/principle`、`/anchor`、`/memory`、`/sessions`、`/compact` 等)。

---

## 会话模式

| 模式 | 适用场景 | 关键能力 |
| --- | --- | --- |
| `detect` | 默认哨兵 | 按提示词与环境推断到 agentic(auto 仅显式进入) |
| `agentic` | 通用工程任务与问答 | 多轮工具调用、文件修改、命令执行、上下文压缩、同步/异步子代理 |
| `auto` | 无人值守自治 | 工作区硬监狱、verify/drift 关卡、断路器、checkpoint/恢复、失败重试、收紧的并发与预算 |
| `campaign` | 长周期实验/优化 | DOE、多保真度、并行评估、Pareto、论文复现、人工检查点、溯源 |
| `robotics` | 机器人开发 | 硬件档案、三层知识库、工作流阶段、并行实验、Git 工作树、Team 协作 |

### auto 自治模式

`auto` 是为"交代目标后无人值守跑完"设计的模式,在 agentic 之上叠加:

- **工作区硬监狱**:fail-closed OS 沙箱,所有文件写/删被强制约束在工作目录内,配置层无法解锁;同样下发给每个被派生的子代理。
- **verify 关卡**:执行体声明完成时,起一个独立的只读判定子代理,在一次性 git 快照里核验"原始目标是否真的达成",每个"完成"主张都需证据,失败开放(verifier 故障不会卡死已完成的运行)。
- **drift 关卡**:在结构性边界起一个独立子代理,对照原始目标与 durable checkpoint 判断是否跑偏,并可沉淀有据可循的经验教训。
- **断路器与收紧默认**:并发子代理上限收到 3、共享预算上限默认 \$5;失败子代理指数退避自动重试。
- **可中断 / 可恢复**:进度(目标、已完成、待办、产出、在途子代理)写入 durable checkpoint;`--resume` 可继续中断的运行。在已恢复的会话里**输入新需求时,新需求会成为新目标**;只有空输入或"继续/continue"这类续跑信号才保留原目标。

verify 关卡判定子代理的预算可通过环境变量覆盖(默认面向多文件交付物放宽):

| 环境变量 | 默认 | 含义 |
| --- | --- | --- |
| `META_AGENT_VERIFY_MAX_TURNS` | 40 | 判定子代理最大轮次 |
| `META_AGENT_VERIFY_MAX_BUDGET_USD` | 100 | 判定子代理最大花费(美元) |
| `META_AGENT_VERIFY_MAX_DURATION_MS` | 600000 | 判定子代理墙钟上限(ms) |

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
├── routing/      # 模式检测 ModeDetector 与 SessionRouter
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

- 会话:`SessionRouter`、`MetaAgentSession`、`CampaignSession`、`RoboticsSession`、`ModeDetector`
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

当前包版本:`0.3.3`。
