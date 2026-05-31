# @meta-agent/runtime

面向工程智能体的 TypeScript 运行时。它把模型调用、工具执行、会话状态、权限控制、上下文压缩、实验流程和多智能体协作封装成统一接口，适合构建可长期运行、可追踪、可恢复的 AI 工程代理。

## 特性概览

- **主 LLM 扩展思考（默认开启）**：默认 `thinkingConfig: { type: 'adaptive' }`，Anthropic 走 `thinking: { budget_tokens: 16k }`，DeepSeek/Qwen 走 `reasoning_effort: 'max'`；可通过 `thinkingConfig: { type: 'disabled' }` 关闭。
- **多轮工具循环**：支持模型在同一任务中连续调用文件、Shell、网络、MCP、自定义工具等能力，直到任务完成或达到限制。
- **自动上下文压缩**：长会话接近上下文窗口上限时自动压缩历史，保留关键状态和任务目标。
- **模式路由**：`SessionRouter` 可按提示词和环境自动选择 `agentic`、`campaign`、`robotics` 模式。
- **工程验证与确认**：内置 V&V Hook，可在工具调用前后执行量级、单位、物理约束等检查。
- **数据溯源**：每次工程工具调用可记录 provenance ID，支持追踪输入、输出、验证结果和依赖链。
- **Campaign 工作流**：支持 DOE 参数扫描、论文复现、多阶段实验、人工检查点和多目标 Pareto 分析。
- **Robotics 工作流**：支持硬件档案、经验库、工作流阶段、Git 工作树隔离和子代理协作。
- **权限与沙箱**：限制工作目录、敏感命令确认、计划模式只读、工具级调用拦截。
- **CLI 与库双入口**：既可在终端中直接使用，也可作为 npm 包集成到应用或服务中。

## 安装

```bash
npm install @meta-agent/runtime
```

要求 Node.js `>= 18.0.0`。

## 环境变量

运行时会按优先级自动选择可用提供商：

| 环境变量 | 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek API Key，优先级最高 |
| `QWEN_API_KEY` | Qwen API Key |
| `ANTHROPIC_API_KEY` | Anthropic API Key |

也可以在代码里显式传入 `apiKey`、`baseURL`、`model`、`fallbackModel`。

## 快速开始

### 在代码中创建会话

```ts
import {
  SessionRouter,
  createStandardTools,
} from '@meta-agent/runtime'

const router = new SessionRouter({
  mode: 'auto',
  projectDir: process.cwd(),
  maxTurns: 30,
})

const tools = await createStandardTools({
  workspaceRoot: process.cwd(),
})

for (const tool of tools) {
  router.registerTool(tool)
}

for await (const event of router.submit('分析 src 目录并给出重构建议')) {
  if (event.type === 'text') {
    process.stdout.write(event.text)
  }

  if (event.type === 'result') {
    console.log('\n完成:', event.subtype)
  }
}
```

### 使用 CLI

```bash
meta-agent "分析当前项目的测试失败原因"
```

指定工作目录：

```bash
meta-agent --workspace ~/projects/demo "重构数据处理模块"
```

指定模式：

```bash
meta-agent --mode campaign "做一次 x=[0,10], y=[0,5] 的 DOE 参数扫描"
meta-agent --mode robotics "根据硬件限制优化 PID 参数"
```

输出 JSON 事件：

```bash
meta-agent --json "检查项目结构"
```

## 会话模式

| 模式 | 适用场景 | 说明 |
| --- | --- | --- |
| `auto` | 默认入口 | 根据首个请求和环境自动选择后端 |
| `agentic` | 通用工程任务 | 多轮工具调用、文件修改、命令执行、上下文压缩 |
| `campaign` | 长周期实验 | DOE、论文复现、阶段推进、人工检查点、溯源记录 |
| `robotics` | 机器人开发 | 硬件档案、经验库、工作流、子代理、Git 工作树协作 |

推荐应用层优先使用 `SessionRouter`，只有在需要精确控制后端时才直接使用具体 Session 类。

```ts
import { SessionRouter } from '@meta-agent/runtime'

const session = new SessionRouter({
  mode: 'auto',
  projectDir: process.cwd(),
})
```

## 内置工具

`createStandardTools()` 会组装常用工具集：

| 类别 | 工具 |
| --- | --- |
| 文件系统 | `read_file`、`write_file`、`edit_file`、`glob`、`grep`、`notebook_edit` |
| Shell | `bash`、`powershell` |
| 网络 | `web_fetch`、`web_search` |
| MCP | `mcp_call`、`list_mcp_resources`、`read_mcp_resource` |
| UI | `ask_user`、`send_message`、`todo_write` |
| 系统 | `sleep`、`cron_create`、`cron_delete`、`cron_list`、`skill`、`config` |
| 子代理 | `run_agent` |
| 溯源 | `get_provenance`、`list_recent`、`find_duplicate`、`get_lineage` |
| 工作流 | `workflow_status`、`workflow_advance`、`workflow_complete_gate`、`workflow_list_phases` |

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
      fidelity: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
      },
    },
    required: ['configPath'],
  },
  async call(input) {
    const result = await runSimulation(String(input.configPath))
    return {
      content: JSON.stringify(result),
      isError: false,
    }
  },
}

session.registerTool(runSimulationTool)
```

### 为工具加上验证与溯源

```ts
import {
  createRuntimeContext,
  instrumentTool,
} from '@meta-agent/runtime'

const runtimeContext = createRuntimeContext({
  projectDir: process.cwd(),
})

const safeTool = instrumentTool(runSimulationTool, {
  runtimeContext,
})

session.registerTool(safeTool)
```

## 扩展思考（thinking / reasoning）

主 LLM 调用默认打开 thinking，模型会先在隐藏的 `thinking` block 里推理再给出答案。

```ts
import { SessionRouter } from '@meta-agent/runtime'

// 默认即开启 — 等价于 thinkingConfig: { type: 'adaptive' }
const session = new SessionRouter({ projectDir: process.cwd() })

// 明确关闭（对成本/延迟敏感的轻量问答）
new SessionRouter({ thinkingConfig: { type: 'disabled' } })

// Anthropic 自定义预算
new SessionRouter({ thinkingConfig: { type: 'enabled', budgetTokens: 32_000 } })
```

不同 provider 的映射：

| Provider | 启用时发送 |
| --- | --- |
| Anthropic | `thinking: { type: 'enabled', budget_tokens: N }` + `interleaved-thinking-2025-05-14` beta |
| DeepSeek | `reasoning_effort: 'max'`（同时上报 `reasoning_content` 流） |
| Qwen | 走 Anthropic-compat 端点，与 Anthropic 行为一致 |

回退到 `fallbackModel` 时，会自动切换到 `fallbackThinkingConfig`（默认 `disabled`），避免 fallback 模型不支持 thinking 时再次失败。

## 权限控制

运行时提供多层权限保护：

- `workspaceRoot` 限制文件工具只能访问指定工作区。
- `beforeToolCall` 可在工具执行前允许、拒绝或重定向调用。
- 计划模式会拦截写操作，仅允许读取与分析。
- 敏感 Shell 命令可通过 `askUser` 交互确认。
- 工具结果会按预算截断，避免单次返回撑满上下文。

示例：

```ts
const session = new SessionRouter({
  projectDir: process.cwd(),
  beforeToolCall: async ({ toolName, input }) => {
    if (toolName === 'bash' && String(input.command).includes('rm -rf')) {
      return {
        action: 'deny',
        reason: '禁止执行高风险删除命令',
      }
    }

    return { action: 'allow' }
  },
})
```

## Campaign 模式

Campaign 模式用于长周期工程实验和科研流程，适合：

- DOE 参数扫描
- 多保真度仿真
- 多目标 Pareto 前沿分析
- 论文复现
- 多阶段实验推进
- 人工检查点与结果审阅

内置插件：

| 插件 | 说明 |
| --- | --- |
| `doe` | 设计空间采样、多保真度筛选、Pareto 分析 |
| `paper-repro` | 论文解析、实验复现、结果对比 |

## Robotics 模式

Robotics 模式在通用代理能力上增加机器人开发所需的上下文和工具：

- `HardwareProfile`：记录关节、传感器、执行器、安全边界等硬件信息。
- `ExperienceStore`：沉淀实验经验，避免重复失败配置。
- `WorkflowLoader`：从项目工作流定义中加载阶段和 gate。
- `GitWorkspaceManager`：为子代理任务创建独立工作树，隔离并行修改。
- 子代理工具：派发、查看、取消、汇总并行任务。

CLI 示例：

```bash
meta-agent --mode robotics --workspace ~/robot-project "调试导航模块的路径抖动问题"
```

## MCP 集成

可以注册任意 MCP 客户端，并通过统一工具调用：

```ts
import {
  registerMcpClient,
  type McpClient,
} from '@meta-agent/runtime'

class MyMcpClient implements McpClient {
  async listTools() {
    return []
  }

  async callTool(name: string, input: unknown) {
    return {
      content: JSON.stringify({ name, input }),
      isError: false,
    }
  }
}

registerMcpClient('my-server', new MyMcpClient())
```

注册后，模型可通过 `mcp_call` 调用该服务暴露的工具。

## 开发命令

```bash
npm run build
npm run typecheck
npm test
npm run test:integration
npm run pack
```

常用脚本：

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 编译库并构建 CLI |
| `npm run build:lib` | 仅编译 TypeScript |
| `npm run build:cli` | 仅构建 CLI |
| `npm run dev` | TypeScript watch 模式 |
| `npm test` | 运行 Vitest 单元测试 |
| `npm run typecheck` | 执行类型检查 |
| `npm run pack` | 构建并打包 npm tarball |

## 项目结构

```text
src/
├── kernel/       # 流式模型调用、工具循环、compact、权限和成本统计
├── core/         # 高层 Session、配置、系统提示、记忆、任务契约
├── modes/        # agentic / campaign 后端适配
├── routing/      # 模式检测和 SessionRouter
├── tools/        # 内置工具集合
├── validation/   # V&V Hook 与内置检查器
├── provenance/   # 数据溯源
├── campaign/     # Campaign 状态、DOE、Pareto、插件接口
├── robotics/     # 机器人模式、硬件档案、经验库、团队协作
├── subagent/     # 子代理调度
├── workflow/     # 阶段式工作流
├── jobs/         # 后台任务系统
├── units/        # 单位与量纲系统
└── cli/          # 命令行入口
```

## 导出入口

常用 API：

- `SessionRouter`
- `MetaAgentSession`
- `CampaignSession`
- `RoboticsSession`
- `createStandardTools`
- `createRuntimeContext`
- `instrumentTool`
- `campaignRegistry`
- `ProvenanceTracker`
- `VVHookChain`
- `UnitRegistry`
- `JobManager`
- `WorkflowLoader`

类型定义可直接从包入口导入：

```ts
import type {
  MetaAgentConfig,
  MetaAgentEvent,
  MetaAgentTool,
  ToolResult,
} from '@meta-agent/runtime'
```

## 版本

当前包版本：`0.2.1`。
