# @hermes/runtime — 设计理念与工程亮点

> 阶段性总结 · v0.1.0

---

## 一、设计哲学

### 1. 上下文是最稀缺的资源

大模型的上下文窗口是有限且昂贵的。runtime 的核心设计目标之一，是让每个 token 都"物尽其用"：

- **主动压缩（Proactive Compact）**：每轮循环前，若历史占用达到阈值（默认 50%），自动对中间段做 LLM 摘要，head + summary + tail 三段结构保证系统提示和最近消息不被截断。
- **被动压缩（Reactive Compact）**：捕获 `context_length_exceeded` 类错误（覆盖 Anthropic / OpenAI / Gemini 三家措辞），立即触发多轮强制压缩后重试，而非向上抛出异常。上下文溢出对调用方完全透明。
- **子 Agent 上下文隔离**：`delegate_task` 的子 Agent 拥有完全独立的上下文窗口，执行完毕只返回压缩摘要，不会污染父 Agent 的对话历史。

### 2. 工具系统以"可见性"为核心

工具的生命周期分为三个阶段，每个阶段都有独立的过滤机制：

```
注册阶段 → checkFn()       是否满足运行时依赖（如 API Key 存在）
可见阶段 → condition()     Feature Gate：按 agentDepth / metadata 动态开关
执行阶段 → PermissionContext  拦截执行，always_deny 在 LLM 见到 schema 之前就被过滤
```

这个分层设计保证了：LLM 永远不会看到它不该看到的工具，也不会被提示"某工具存在但不可用"。

### 3. 共享预算，而非孤立计数器

所有 Agent（父、子、孙）共用同一个 `SharedBudget` 实例引用。任何一个节点的 `tryConsume()` 都原子地消耗全局计数，防止 fan-out 子任务无限膨胀。JavaScript 单线程模型天然保证无竞态。

### 4. 依赖方向永远单向

循环依赖是 TypeScript 项目的常见陷阱。`delegate-tool.ts` 需要运行子 `AgentRuntime`，但不能 `import agent.ts`（会形成环）。解决方案是把 `createChild` 设计为**闭包工厂**，在 `agent.ts` 内定义后注入到 `DelegationContext`，`delegation/types.ts` 只声明函数签名，不知道 `AgentRuntime` 的存在。

---

## 二、架构分层

```
┌─────────────────────────────────────────────────────┐
│                   Public API (index.ts)              │
├─────────────────┬───────────────────────────────────┤
│  AgentRuntime   │  ChatSession                       │
│  (agent.ts)     │  (有状态多轮对话封装)                │
├─────────────────┴───────────────────────────────────┤
│            Core Loop  (agent.ts)                    │
│  proactive compress → getDefinitions(filterCtx)     │
│  → callLLM(fallback+retry) → reactive compact       │
│  → executeToolBatch → permission.check              │
│  → evalStopHooks → toolUsageSummary                 │
├───────────┬──────────────┬──────────────────────────┤
│  Adapters │  Tools       │  Services                │
│ Anthropic │  Registry    │  DreamService            │
│  OpenAI   │  file/web/   │  (auto-dream)            │
│  Gemini   │  terminal/   ├──────────────────────────┤
│   GLM     │  memory/todo │  Context                 │
│           │  delegate    │  ContextCompressor       │
│           │  permission  │  isContextLengthError    │
├───────────┴──────────────┴──────────────────────────┤
│            Delegation System                        │
│  SharedBudget · DelegationContext · BubbleCallbacks │
└─────────────────────────────────────────────────────┘
```

---

## 三、核心工程亮点

### 3.1 Reactive Compact（被动上下文压缩）

```typescript
// agent.ts — _callLLMWithReactiveCompact
try {
  return await this._callLLM(history, toolDefs);
} catch (err) {
  if (!isContextLengthError(err)) throw err;   // 只拦截上下文溢出
  await this._compressor.compressFully(history); // 多轮强制压缩（原地修改）
  return this._callLLM(history, toolDefs);       // 一次重试
}
```

`isContextLengthError` 覆盖了 Anthropic / OpenAI / Gemini / 通用四种错误格式，调用方无需感知溢出的存在。

---

### 3.2 权限状态机（Permission State Machine）

四态模型：`always_allow` · `always_deny` · `ask` · `auto`

```typescript
// 工具定义下发给 LLM 之前，always_deny 工具已被过滤掉
getDefinitions(enabledToolsets, disabledToolsets, filterCtx)
// filterCtx.permissions 的 always_deny 规则在 _filterEntry 中短路

// 执行时通过 ToolPermissionContext.check() 拦截
const ok = await permCtx.check(toolName, args);
if (!ok) return `Permission denied: ${toolName}`;
```

内置高危默认规则：`terminal` → `ask`，其余默认 `auto`，用户可通过 `PermissionConfig.rules` 覆盖。

---

### 3.3 Feature Gate（条件工具可见性）

`ToolEntry` 新增 `condition?(ctx: ToolFilterContext): boolean` 字段，在每次 `getDefinitions()` 时动态计算。典型用法：

```typescript
registerTool({
  name: 'internal_debug_tool',
  condition: (ctx) => ctx.agentDepth === 0,  // 只在根 Agent 可见
  // ...
});
```

这让工具的可用性随上下文变化而变化，而不是注册时一锤定音。

---

### 3.4 Stop Hooks（可插拔停止条件）

```typescript
const agent = new AgentRuntime({
  stopHooks: [
    // 每轮结束后评估，true → 立即停止
    async (step, history) => step.toolResults.some(r => r.name === 'write_file'),
    async (step) => step.iteration >= 10,
  ],
});
```

Stop Hooks 在每个 step（无论是否使用工具）结束后依次求值，任一返回 `true` 则停止循环。Hook 抛出异常时静默忽略，不影响主流程。

---

### 3.5 Tool Usage Summary

`ConversationResult.toolUsageSummary` 包含本次 run 中每个工具的统计：

```typescript
interface ToolUsageSummary {
  tool: string;
  callCount: number;
  totalDurationMs: number;
  errorCount: number;
  lastResult?: string;
}
```

可用于监控、调试、以及 Auto-Dream 的 consolidation 决策。

---

### 3.6 Auto-Dream（后台记忆整理）

三门控制，廉价优先：

```
Gate 1（内存）: 距上次整理 > 4h
Gate 2（内存）: 本进程 session 数 >= 3
Gate 3（磁盘）: lock 文件不存在（原子 O_EXCL 创建）
```

满足全部三门后，后台 fire-and-forget 调用 LLM 对 MEMORY.md 做去重整理。整理结果原地写回，并重置 session 计数。Lock 文件超过 30 分钟视为僵尸，自动清除。

---

### 3.7 类型化内存（Typed Memory）

四个语义分类：

| Category    | 含义                          |
|-------------|-------------------------------|
| `user`      | 用户长期偏好、个人上下文         |
| `feedback`  | Agent 自我纠正和经验教训         |
| `project`   | 项目路径、配置、决策            |
| `reference` | 外部知识（API 签名、文档片段）   |

大小限制以**警告输出**而非静默截断的方式呈现：Agent 写入超限时会收到 `⚠️ Memory entry limit reached` 提示，而不是数据丢失。

---

### 3.8 透明事件冒泡（Delegation Bubble）

子 Agent 的工具调用、每轮步骤、委托生命周期事件，通过 `DelegationBubbleCallbacks` 链逐层上浮到根 Agent：

```
子Agent.onToolStart → parentBubble.onChildToolStart → 根Agent.onChildToolStart
```

根 Agent 的 UI 层可以渲染完整的"调用树"，无需轮询或额外通信通道。

---

### 3.9 Fan-out 并发子任务

`delegate_task` 注册时设置 `parallelSafe: true`，`executeToolBatch` 会将同一 LLM 响应中的多次委托调用通过 `p-limit` 并发执行：

```typescript
// LLM 一次响应中 3 次 delegate_task → 3 个子 Agent 并行运行
// SharedBudget 全程共享，不会超额
```

不需要引入新的"parallel_delegate"工具，复用现有批处理机制即可。

---

## 四、已实现功能清单

| 模块 | 功能 |
|------|------|
| `adapters/` | Anthropic · OpenAI-compatible · Gemini · GLM（智谱）四家适配 |
| `tools/registry` | 单例注册表，checkFn + condition + 并发批执行 |
| `tools/file` | read / write / patch / search |
| `tools/web` | search（EXA/Tavily/SearXNG/DDG fallback）+ fetch |
| `tools/terminal` | bash 子进程，超时 SIGKILL |
| `tools/memory` | 类型化分类，大小限制警告，stats |
| `tools/todo` | JSON 持久化，状态/优先级格式化 |
| `tools/delegate` | 结构化委托，Fan-out，深度/预算双保险 |
| `tools/permission` | 四态权限机，glob 规则，onAsk 回调 |
| `context/compressor` | 主动 + 被动双模式压缩，多轮 compressFully |
| `delegation/budget` | SharedBudget 原子计数 |
| `services/dream` | 三门 Auto-Dream，O_EXCL 文件锁，僵尸锁检测 |
| `agent` | Stop Hooks · Tool Usage Summary · Reactive Compact · PermissionContext · FeatureGate |
| `utils/` | 指数退避重试 · 结构化日志 |

**编译状态：`tsc --noEmit` 零错误** ✅

---

## 五、下一步方向（Roadmap）

- **持久化会话**：将 history 序列化到 `sessionDir`，支持跨进程续跑
- **Streaming 子 Agent**：子 Agent 的流式输出实时转发到父 Agent
- **Tool 结果截断策略**：超过 `maxResultSizeChars` 时的智能摘要而非硬截断
- **MCP 协议适配器**：作为 MCP server/client 接入 Claude Code 生态
- **Eval 框架**：基于 Stop Hooks 构建可重放的行为测试套件
