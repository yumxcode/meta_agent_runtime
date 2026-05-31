# meta-agent-runtime 架构技术报告

> 版本：基于代码审查后最新状态（P0/P1/P2 修复已合入）  
> 日期：2026-05-24

---

## 1. 整体架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        Public API Layer                          │
│        SessionRouter  ·  MetaAgentSession  ·  KernelSession      │
├──────────────────────────┬──────────────────────────────────────┤
│      Session Modes       │         Domain Extensions            │
│  Direct / Agentic /      │  Campaign Coordination               │
│  Campaign / Robotics     │  V&V Chain                           │
│                          │  Provenance Tracker                  │
│                          │  Unit Registry                       │
├──────────────────────────┴──────────────────────────────────────┤
│                       Kernel Layer                               │
│   KernelLoop  ·  ToolOrchestration  ·  AutoCompact              │
│   AnthropicClient  ·  DeepSeekClient  ·  PermissionPolicy        │
├─────────────────────────────────────────────────────────────────┤
│                     Persistence Layer                            │
│   SessionStore  ·  TeamStore  ·  JobStore  ·  ExperienceStore    │
│   MemoryWriter  ·  StateSnapshot  ·  RoboticsProjectStore        │
├─────────────────────────────────────────────────────────────────┤
│                    Infrastructure Layer                          │
│   atomicWriteJson  ·  Zod Schemas  ·  GitWorkspaceManager        │
│   SubAgentBridge  ·  WorkflowLoader  ·  SectionRegistry          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心设计模式

### 2.1 AsyncGenerator 事件流（Event Streaming Pattern）

系统中所有用户可见的操作都通过 `AsyncGenerator<Event>` 暴露，而非回调或 Promise。

```typescript
// KernelSession → KernelLoop → SessionRouter → 调用方
async *submitMessage(prompt): AsyncGenerator<KernelEvent> {
  // 内部 yield 事件，最后一个始终是 result 事件
}
```

**设计意图**：
- 调用方可即时消费流式文本（`text_delta`），无需等待整个响应完成。
- 事件类型构成有限状态机：`text_delta`* → `tool_use`? → `tool_result`? → `result`。
- 错误通过 `result` 事件的 `subtype` 字段传递（而非抛出异常），保证生成器总是正常结束。

### 2.2 会话后端分层组合（Composition over Inheritance）

```
RoboticsSession
  └─ inner: AgenticSession           ← API 循环和工具执行
  └─ bridge: SubAgentBridge          ← 子代理调度
  └─ store: ExperienceStore          ← 知识库
  └─ hwProfile: HardwareProfile      ← 硬件规格
  └─ gitMgr: GitWorkspaceManager     ← 工作树管理
  └─ teamStore: TeamStore            ← 团队状态
  └─ sectionRegistry: SectionRegistry ← 提示段注册
```

RoboticsSession **不继承** AgenticSession，而是持有它的实例。这让每个组件可以独立测试，也允许 RoboticsSession 在不同系统提示策略之间切换而不影响内核逻辑。

### 2.3 动态系统提示装配（SectionRegistry Pattern）

系统提示被分为静态段和动态段两部分：

```
Static Sections (S1-S6, 构建一次后 cached):
  buildStaticSystemPrompt() → 身份、能力、约束、工具使用规范

Dynamic Sections (每次 submit() 前重新计算):
  SectionRegistry + buildDynamicSections() →
    D1: 记忆注入 (Memory)
    D2: 活跃 Campaign 上下文
    D3: 用户自定义追加 (appendSystemPrompt)
    D4: 工作流状态 (W1)
    R1-R5: Robotics 专用段
```

`DANGEROUS_uncachedSystemPromptSection()` 标记某个段为每轮必须重新计算（绕过 memoization），用于需要反映最新状态的动态内容（如当前任务状态）。

### 2.4 乐观并发控制（Optimistic Concurrency in TeamStore）

`TeamStore.writeAll()` 采用读-比较-写三步乐观锁：

```typescript
// 调用方保存修改前的 updatedAt
const originalUpdatedAt = state.updatedAt

// 执行状态变更（内存操作）
state.tasks.push(newTask)
state.updatedAt = new Date().toISOString()

// writeAll 在写盘前重新读磁盘，比较 updatedAt
await this.writeAll(state, activity, originalUpdatedAt)
// 如果磁盘版本的 updatedAt ≠ originalUpdatedAt → 抛出错误，调用方重试
```

这是多进程（多 agent 实例）共享同一 `team.json` 的并发安全保障，比文件锁更轻量，比数据库事务更简单。

### 2.5 原子写入（Atomic Write Pattern）

所有关键 JSON 文件（`team.json`、`index.json`）都通过 `atomicWriteJson()` 写入：

```typescript
async function atomicWriteJson(path, data) {
  const tmp = path + '.tmp.' + randomUUID()
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tmp, path)  // 原子替换
}
```

写入临时文件后执行 `rename()`，利用操作系统的原子 rename 语义保证：要么看到旧文件，要么看到新文件，不会出现部分写入的损坏状态。

### 2.6 Zod 运行时校验（Schema Validation at Deserialization Boundaries）

所有从磁盘读取的 JSON 都经过 Zod 校验：

```typescript
// 单条：解析失败返回 null，不抛出
const state = parseOrNull(TeamStateSchema, raw)

// 批量：过滤无效条目，返回有效列表 + 丢弃计数
const { valid, dropped } = parseArrayFiltered(SessionMetaSchema, parsed)
```

**设计决策**：使用 `safeParse`（永不抛出）而非 `parse`（抛出异常），让上层代码用 `null` 检查替代 try-catch，降低错误处理复杂度。

### 2.7 惰性模块加载（Lazy Import）

```typescript
// SessionRouter._createImpl() 中
case 'robotics': {
  const { RoboticsSession } = await import('../robotics/RoboticsSession.js')
  ...
}
```

RoboticsSession 通过动态 `import()` 加载，原因：
1. 打破 RoboticsSession → TeamStore → ... → SessionRouter 的潜在循环依赖。
2. 非 robotics 用户不承担 RoboticsSession 的初始化开销。

### 2.8 工具中间件模式（Tool Instrumentation）

```typescript
// CampaignSession.registerTool()
const wrapped = this._config.runtimeContext
  ? instrumentTool(tool, this._config.runtimeContext, options)
  : tool
```

`instrumentTool()` 是装饰器模式实现：在工具执行前后插入 V&V 检查、Provenance 记录、State Snapshot 等横切关注点，调用方注册的是原始工具，执行时自动触发所有增强逻辑。

---

## 3. 关键数据流

### 3.1 单次用户交互完整流程

```
用户调用 router.submit(prompt)
  │
  ▼
SessionRouter._ensureImpl(prompt)        [首次调用]
  ├─ ModeDetector.detect()              → Haiku 侧调用 (3s timeout)
  └─ _createImpl(mode)                  → 实例化对应后端
  │
  ▼
CampaignSession.submit(prompt)
  ├─ _buildEnrichedSuffix()             → MetaAgentContextStore + CompactInstructions
  └─ engine.submitMessage(prompt)
       │
       ▼
  KernelLoop while(true):
    ├─ applyToolResultBudget()          → 截断过大的工具结果
    ├─ getMessagesAfterCompactBoundary()
    ├─ autoCompactIfNeeded()            → 可选：调用 flash 模型压缩历史
    ├─ calculateTokenWarningState()     → 检查是否触达 blocking limit
    ├─ streamMessages()/streamDeepSeekMessages()  → 流式 API 调用
    │     └─ yield text_delta/thinking_delta/tool_use ...
    ├─ runTools(toolUseRequests)        → 并发执行工具（上限 getConcurrencyLimit()）
    │     └─ yield tool_result ...
    └─ 检查 maxTurns / maxBudgetUsd → 继续或终止
  │
  ▼
yield result event
  │
  ▼
SessionStore.append()                   → JSONL 追加写入历史
```

### 3.2 工具执行并发模型

```
runTools(toolUseRequests, tools, ctx, canUseTool):
  │
  ├─ for each request:
  │    canUseTool(name, input) → 权限检查（同步/异步）
  │
  ├─ p-limit(getConcurrencyLimit()):   [默认 10，可通过 env 覆盖]
  │    并发执行所有允许的工具调用
  │
  └─ 收集所有 tool_result，拼装为下一轮的 user 消息
```

### 3.3 TeamStore 写入流程（含乐观锁）

```
调用方: teamStore.claim(taskId)
  │
  ├─ this.read()                        → 读 team.json（Zod 校验）
  ├─ const originalUpdatedAt = state.updatedAt
  ├─ 修改 state（内存操作）
  ├─ state.updatedAt = new Date().toISOString()
  │
  └─ this.writeAll(state, activity, originalUpdatedAt)
       │
       ├─ 重读磁盘 team.json
       ├─ 比较 diskUpdatedAt vs originalUpdatedAt
       │    ├─ 不一致 → throw 并发修改错误
       │    └─ 一致 → 继续写入
       ├─ atomicWriteJson(statePath, state)   ← 等待（critical path）
       └─ void Promise.all([board.md, tasks/*.md, ...]).catch() ← fire-and-forget
```

### 3.4 会话结束记忆写入流程

```
router.dispose()
  │
  ├─ runPostSessionMemoryWriter({
  │    client,              ← detectionClient（Haiku 或 DeepSeek flash）
  │    mode, domain,
  │    messages,            ← 完整会话历史（前 32k 字符）
  │    model: flashModel,
  │  })
  │    │
  │    ├─ buildTranscript(messages)      → 截断到 MAX_TRANSCRIPT_CHARS
  │    ├─ loadMemoryIndex()              → 现有记忆索引（MAX_EXISTING_INDEX_CHARS）
  │    ├─ client.messages.create()       → withTimeout(8000ms)
  │    ├─ extractJson(response)          → 解析 {"memories": [...]}
  │    └─ for each proposal:
  │         ├─ normalizeProposal()       → 类型校验 + sanitizeScalar（防 YAML 注入）
  │         ├─ 重复检查（filename + name）
  │         ├─ writeFile(memoryFile)
  │         └─ appendFile(MEMORY.md 索引)
  │
  ├─ impl.dispose()                      ← RoboticsSession 清理工作树等
  ├─ deleteTodosForSession(sessionId)
  └─ deleteJobsForSession(sessionId)
```

---

## 4. 持久化层设计

### 4.1 存储目录结构

```
~/.meta-agent/
├── memory/
│   ├── MEMORY.md              ← 记忆索引（append-only）
│   └── *.md                   ← 各条记忆文件（YAML frontmatter + Markdown body）
├── sessions/
│   ├── index.json             ← 最多 50 条会话元数据（atomicWriteJson）
│   └── <sessionId>/
│       └── history.jsonl      ← 消息历史（append-only JSONL）
└── jobs/
    └── <sessionId>/
        └── <jobId>.json       ← 工程任务状态

<projectDir>/.meta-agent/
├── team.json                  ← 团队状态（atomicWriteJson + 乐观锁）
├── board.md                   ← 任务看板（fire-and-forget）
├── tasks/                     ← 各任务详情 .md（fire-and-forget）
├── handoffs/                  ← 任务交接记录（fire-and-forget）
└── activity.md                ← 操作日志（fire-and-forget）

<projectDir>/
└── AGENT.md                   ← 工作流定义（WorkflowLoader 读取）
```

### 4.2 写入策略分类

| 数据 | 写入方式 | 原因 |
|------|----------|------|
| `team.json` | `atomicWriteJson` + 乐观锁 | 多进程共享，必须防损坏和冲突 |
| `sessions/index.json` | `atomicWriteJson` | 防会话列表损坏 |
| `history.jsonl` | `appendFile`（追加） | 只增不改，天然原子；避免全量重写 |
| `*.md` 视图文件 | fire-and-forget | 可再生（重新从 team.json 渲染），不阻塞关键路径 |
| `memory/*.md` | `writeFile` + append MEMORY.md | 记忆文件一写不改；索引追加 |

### 4.3 Schema 版本与向前兼容

- `TeamState.schemaVersion: '1.0'`（字面量类型，Zod 严格匹配）。
- `parseOrNull()` 在 schema 不匹配时返回 `null`，调用方将其视为「尚无数据」而非错误，避免版本迁移崩溃。
- `parseArrayFiltered()` 逐条校验，单条损坏不影响整批（用于 session index 加载）。

---

## 5. 提供商抽象层

### 5.1 消息规范化管道

```
KernelMessage（内部格式）
  │
  ├─ normalizeMessagesForAPI()          → Anthropic SDK 格式
  │    └─ getMessagesAfterCompactBoundary()  → 跳过 compact 标记之前的消息
  │
  └─ normalizeMessagesForDeepSeek()     → OpenAI 兼容格式（system 消息提取）
```

DeepSeek 使用 OpenAI 兼容 API，`system` 消息需要从 messages 数组提取到独立字段，Anthropic API 则通过独立的 `system` 参数传递。两套规范化器保证内核只维护一种内部格式。

### 5.2 thinking 模式适配

- 主模型使用 `thinkingConfig: { type: 'adaptive' }`（自动决定是否使用扩展思考）。
- fallback 模型切换时，thinking blocks 从消息历史中剥离（`stripThinkingBlocksFromMessages()`），避免将 Anthropic 专有格式发送到不支持的模型。
- `fallbackBetas`/`fallbackThinkingConfig` 允许 fallback 模型使用不同的 beta 特性配置。

### 5.3 重试策略

```typescript
// AnthropicClient / DeepSeekClient 中的指数退避
retryCallback(attempt, maxRetries, retryDelayMs, errorStatus)
→ yield api_retry event（供 UI 显示重试状态）
```

- 默认 `maxRetries: 3`，支持可配置。
- 重试事件通过 `KernelEvent` 传递给调用方，UI 层可展示「API 重试中...」提示。

---

## 6. 子代理系统架构

```
RoboticsSession
  │
  └─ SubAgentBridge
       │
       ├─ SubAgentTaskStore          ← 任务注册表（Map<taskId, SubAgentTask>）
       │
       └─ _drainStartQueue()         ← 调度循环
            │
            ├─ p-limit(concurrencyLimit)
            │
            └─ SubAgentRunner.run(task)
                 │
                 ├─ GitWorkspaceManager.createWorktree(branch)
                 ├─ new AgenticSession(worktreeConfig)
                 ├─ session.submit(task.prompt)
                 ├─ 收集 intermediateResults（工具调用结果）
                 └─ GitWorkspaceManager.cleanupWorktree(branch)
```

**隔离策略**：每个子代理在独立 Git 工作树（worktree）中运行，拥有独立的文件系统视图，主 agent 和子 agent 之间的文件修改互不干扰，完成后通过 git merge 合并。

**通信机制**：
- 子代理状态通过 `SubAgentTaskStore` 共享（同进程内 Map）。
- 主 agent 通过 `get_sub_agent_status`、`get_sub_agent_intermediate` 工具轮询进度。
- `finishedThisSession` 计数（含成功+失败），用于调度统计。

---

## 7. 系统提示工程架构

### 7.1 静态 vs 动态分离

```typescript
// 只构建一次（会话初始化）
const staticPrompt = buildStaticSystemPrompt()  // S1-S6: 身份、角色、规则

// 每次 submit() 前重新计算
const dynamicSuffix = buildDynamicSections({
  mode: 'robotics',
  modeExtensions: [R1, R2, R3, R4, R5, W1],
  ...
})
engine.setAppendSystemPrompt(dynamicSuffix)
```

### 7.2 Robotics 动态段缓存策略

```
R1 (机器人身份): memoized — agentMode 分类后缓存
R2 (经验知识):   每次重算 — ExperienceStore 随时间增长
R3 (当前任务):   uncached (DANGEROUS_) — 实时任务状态
R4 (安全限制):   memoized — 硬件配置不变
R5 (恢复上下文): memoized after init — 只在会话开始时生效
W1 (工作流状态): uncached — 阶段随任务进展变化
```

`DANGEROUS_uncachedSystemPromptSection` 命名中的 `DANGEROUS` 前缀是一个刻意的代码异味标记，提示维护者：这个段的每次重算有实际计算成本，应谨慎使用。

---

## 8. 并发与线程安全模型

JavaScript/Node.js 是单线程事件循环，但以下场景需要协调：

| 场景 | 机制 |
|------|------|
| 同一 KernelSession 重复 submit() | `_submitInFlight` 布尔标志（同步检查） |
| 多进程写 team.json | 乐观锁（`checkUpdatedAt`）+ `atomicWriteJson` |
| 并发工具调用 | `p-limit(getConcurrencyLimit())` 限流 |
| 并发子代理 | `SubAgentBridge` 内部 `p-limit` |
| 会话 index 并发写 | `atomicWriteJson`（单写者语义） |
| 记忆文件写入 | 基于文件名唯一性的 dedup（存在则跳过） |

注意：`getConcurrencyLimit()`、`getMaxOut()`、`getMaxResultSizeChars()` 都是惰性 getter（函数调用而非模块加载时的常量），这样测试可以通过设置环境变量后再调用来覆盖默认值，避免了因模块缓存导致的测试隔离问题。

---

## 9. 测试架构

```
src/kernel/__tests__/
├── KernelSession.test.ts         ← 会话生命周期、并发保护
├── KernelLoop（通过 KernelSession）← 终止原因、fallback 切换
├── AutoCompact.test.ts           ← compact 触发条件
├── CompactPrompt.test.ts         ← compact 提示构建
├── Context.test.ts               ← token 计数、blocking limit
├── FallbackAndBetas.test.ts      ← fallback 模型切换逻辑
├── PermissionPolicy.test.ts      ← 权限策略
└── ToolOrchestration.test.ts     ← 工具并发执行

src/subagent/__tests__/
└── SubAgentBridge.test.ts        ← 子代理调度、concurrency
```

**测试隔离策略**：
- 所有测试使用 mock LLM 客户端（不发真实 API 请求）。
- `MetaAgentContextStore.resetForTest()` / `CampaignStateStore.resetAllForTest()` 在每个测试前清空全局单例，防止状态污染。
- 惰性 getter 支持通过 `process.env` 在每个测试用例中独立设置并发限制和输出上限。

---

## 10. 安全设计

### 10.1 工作区沙箱
- 所有文件系统操作限定在 `workspaceRoot` 内（`workspaceGuard.ts`），路径遍历攻击（`../`）在工具层被拦截。

### 10.2 Git 命令注入防护
- `branchForTask()` 对分支名做正则校验：`/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/`
- 非法字符（如 `;`、`&`、空格）直接 throw 错误，不落入 `git checkout -b <input>` 命令。

### 10.3 YAML Frontmatter 注入防护
- `sanitizeScalar()` 将所有 `\r` 和 `\n` 替换为空格，防止 LLM 返回的字符串（如 `"value\ntype: injected"`）在写入 YAML frontmatter 时注入额外字段。

### 10.4 模型侧调用隔离
- `SessionRouter._detectionClient` 是专用的轻量 Anthropic 客户端（3s 超时，1 次重试），与主会话客户端完全独立，侧调用（模式检测、记忆提取）的消息不会污染主会话历史。
- 非 Anthropic 提供商（DeepSeek、Qwen）时，`_detectionClient` 设为 `null`，ModeDetector 自动退到正则启发式检测，避免向非 Anthropic 端点发送 Haiku 模型请求（404 失败）。

### 10.5 记忆写入边界
- `allowedTypesForMode()` 按会话模式白名单过滤记忆类型，campaign 模式不能写 `robot_lessons`，agentic 模式不能写 `campaign_lessons`，防止跨模式污染。

---

## 11. 关键技术决策总结

| 决策 | 选择 | 理由 |
|------|------|------|
| 内核语言 | TypeScript（重写 CC 的 JS 内核） | 类型安全、IDE 支持、与现有 TS 代码库对齐 |
| 流式 API | `AsyncGenerator` | 背压控制优于 EventEmitter；与 `for await...of` 自然组合 |
| 持久化格式 | JSONL（历史） + JSON（索引/状态） | JSONL 追加只增不改；JSON 适合结构化状态 |
| 原子写入 | write-then-rename | 利用 OS 原子 rename，比文件锁简单，跨平台 |
| 并发控制 | 乐观锁（team.json） + 布尔标志（会话级） | 多进程用乐观锁，单进程内用简单标志 |
| 运行时校验 | Zod v4 `safeParse` | 永不抛出，`null` 语义清晰；过滤损坏数据而非崩溃 |
| 子代理隔离 | Git worktree | 文件系统级隔离；利用 git 的成熟合并工具 |
| 模式检测 | Haiku 侧调用 + 正则启发式 fallback | 准确性优先，无 API Key 时优雅降级 |
| 工具执行 | p-limit 并发 + 权限策略前置 | 防止工具风暴；权限在执行前检查，不在执行后回滚 |
| 提示工程 | 静态/动态分离 + SectionRegistry | 静态部分可被提供商侧缓存（prompt caching）；动态部分按需重算 |
| 提供商支持 | 环境变量优先级检测 | 零配置切换；不依赖配置文件 |
