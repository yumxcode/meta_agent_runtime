# Agent Runtime 工程化核心理念与架构实践

> 基于 hermes-agent（生产级 Python 系统）与 `@hermes/runtime`（TypeScript 运行时）的实践总结。

---

## 一、核心工程理念

### 1. 可靠性是主循环的第一属性

Agent runtime 的核心循环不同于普通服务——它在一个连续的、有状态的执行序列中，同时面对 LLM 调用失败、工具执行失败、上下文溢出、预算耗尽、外部中断这五类并发风险。任何一类未处理都会导致 agent 静默卡死、错误累积或产出无用结果。

**实践含义**：主循环的每一个 `break`、`continue`、`throw` 都必须是显式的、有原因编码的。不允许有"默认继续"的路径。

### 2. 结构化信号，不留裸文本

工具结果返回给 LLM 的方式决定了 LLM 能做多可靠的决策。裸字符串迫使 LLM 用语义理解来判断成功/失败，这引入了不确定性。

**Observation 协议**：
```json
{"status": "ok",    "content": "..."}
{"status": "error", "error_type": "execution_error", "content": "..."}
```

`error_type` 是机器可读的分支信号：`validation_error` → 修正参数重试；`execution_error` → 换策略；`permission_denied` → 不要重试，上报。LLM 不需要"理解"错误，只需要读 `status` 字段。

这个原则同样适用于记忆读取——staleness_risk 作为 `metadata` 附加在 Observation 上，而不是污染 `content`。结构化元数据让 LLM 能精确地感知风险级别，而不是从自然语言描述中猜测。

### 3. 预算是跨边界的一等资源

`max_iterations` 不应该是每个 agent 实例独立的计数器。当 agent A 委托给 agent B，B 的消耗必须从同一个预算池扣除，否则委托会变成无限制的预算放大器。

**SharedBudget**：父子 agent 共享同一个 `SharedBudget` 引用。委托前检查剩余预算，剩余不足则拒绝创建子 agent。这使整个委托树的总消耗有确定性上界。

预算不只是计数，它还是控制流依据：CompletionGuard 在 `remaining < 2` 时跳过（防无限出口循环），Checkpoint resume 时恢复剩余预算量，子 agent 的 `max_iterations` 不能超过父 agent 的剩余量。

### 4. 防御式主循环——四道熔断线

单靠 LLM 的自我纠错能力是不够的。生产 agent 需要主动识别几类系统性失效模式并强制干预：

```
熔断器          ← 连续 N 步所有工具全部失败
停滞检测        ← 连续 N 步工具调用指纹完全相同
CompletionGuard ← 出口处验收：任务是否真的完成
Stop Hooks      ← 外部注入的自定义终止条件
```

这四道防线的层次关系：熔断器和停滞检测处理"陷入死循环"；CompletionGuard 处理"提前退出"；Stop Hooks 处理"业务条件中止"。它们共同构成主循环的安全边界，缺一不可。

### 5. 记忆是基础设施，不是功能

Agent 的长期记忆如果设计为单一 K-V 存储，会面临两个根本性问题：所有记忆都常驻上下文（token 成本线性增长）或没有按需检索能力（忘记相关内容）。

**三层架构**解决了不同记忆类型的不同访问模式：

- **Layer 1（索引层）**：全局常驻，极低 token 占用。每条记忆只保留 80 字符预览，作为目录而非内容。
- **Layer 2（主题层）**：按需拉取完整内容。用于深度聚焦型操作。
- **Layer 3（日志层）**：只通过关键词搜索访问，绝不常驻上下文。用于跨会话回溯。

这个模式的核心洞察来自 Claude Code 的 CLAUDE.md 机制：不同重要程度的知识应该有不同的获取成本。

### 6. Context 是有限稀缺资源，压缩是必要能力

Context 窗口是 agent 运行时最昂贵的资源。把压缩设计为可选功能会导致生产系统在长任务中不可避免地崩溃（`context_length_exceeded`）。

**双模式压缩**：
- **主动压缩**：每轮迭代前检查 context 占用率，超过阈值时触发（例如 50%）。在崩溃前预防。
- **被动压缩**：捕获 `context_length_exceeded` 错误，立即触发多轮积极压缩，然后重试。在崩溃后恢复。

两种模式共用同一个 `ContextCompressor`，但触发条件和激进程度不同。

### 7. 崩溃恢复是产品功能，不是运维工具

对于长时运行任务（数十分钟到数小时），进程崩溃是概率性必然事件。没有 checkpoint 机制意味着每次崩溃都要从头重来，用户体验灾难性。

**Checkpoint 的两个关键设计点**：
1. **原子写入**：先写 `.tmp`，成功后 rename 到 `.json`。确保不产生半写的损坏文件。写入失败静默吞掉——checkpoint 失败绝不能传播为 agent 失败。
2. **结构化恢复上下文**：resume 时注入的不是一段描述性文字，而是精确的 todo 快照（`✓ done / → in_progress / ○ pending`）。LLM 能从任务级别精确续接，而不是重新探索。

### 8. Prompt 是分层组合物，不是配置字符串

硬编码系统提示是小规模原型的写法。生产系统的系统提示需要响应三个维度的变化：运行环境（哪个项目，什么规范）、可复用规程（技能库）、任务特定标准（验收条件）。

**四层组装管线**（外到内，内层权重高）：
```
base prompt     → 角色定义、工具使用规范（不变）
AGENTS.md 层    → 环境感知：~/.hermes/ → 项目根 → cwd
Skills 层       → 复用规程：git 工作流、测试策略、代码审查步骤...
Spec 层         → 任务验收：criteria + outcomes + constraints
```

这个分层结构使得：同一个 base agent 在不同项目中自动加载不同的行为规范；用户无需修改代码就能注入项目级 agent 指令。

注意：AGENTS.md 注入前需要扫描提示注入威胁（hidden div、invisible unicode、override 指令等）。外部文件是潜在的攻击面。

### 9. Provider 无关性是架构约束，不是设计目标

把 LLM 调用与特定 SDK 绑定会在提供商切换时产生大范围修改。更重要的是，不同提供商在 tool_use 格式、流式返回、错误类型上存在实质差异，这些差异必须被封装，而不是渗透到主循环。

**Adapter 模式**：主循环只调用 `adapter.call(history, toolDefs, opts)`，不感知 provider 差异。每个 adapter 内部处理：消息格式转换、工具定义转换、流式 delta 拼接、错误类型归一化。Fallback 链（`[primary, ...fallbacks]`）在 adapter 层之外、retry 逻辑之上组合，互不耦合。

---

## 二、核心架构实践

### 2.1 History 作为单一真实来源

Agent 主循环不维护显式状态机。`history: Message[]` 数组本身就是完整的执行状态：

```
system(提示)
user(任务)
[user(memory_index)]          ← Layer 1 注入
assistant(思考 + tool_calls)
tool(结果1)
tool(结果2)
assistant(思考 + tool_calls)
...
assistant(最终回复)
```

这个设计的核心优点：上下文压缩是对 `history` 的原地 splice 操作，checkpoint 保存的是 `[...history]` 的快照，resume 时直接恢复。所有状态衍生自 history，没有隐藏的副作用状态。

### 2.2 工具注册表的自发现模式

工具文件在模块顶层调用 `registry.register()`。注册表不维护显式的工具文件列表——而是扫描目录，检测含有顶层 `register` 调用的文件并动态 import。

```python
# Python: AST 扫描（tools/registry.py）
def _module_registers_tools(module_path) -> bool:
    tree = ast.parse(source)
    return any(_is_registry_register_call(stmt) for stmt in tree.body)
```

```typescript
// TypeScript: 动态 import 触发注册（src/index.ts）
export const loadFileTools = async () => import('./tools/file-tools.js');
```

**效果**：添加新工具只需要一个文件，零中央清单修改。工具的可用性由 `checkFn`（前置条件，如 API key 是否存在）和 `condition`（运行时 Feature Gate，如 agent 深度限制）两层独立控制。

### 2.3 停滞检测的指纹算法

```typescript
private _stepFingerprint(toolCalls: ParsedToolCall[]): string {
  const normalized = toolCalls
    .map((tc) => ({ name: tc.name, args: tc.args }))
    .sort((a, b) => /* 按 name+args 排序 */);
  return JSON.stringify(normalized);
}
```

关键点：排序后再序列化，避免并发 fan-out 调用因顺序不同产生误判。检测到相同指纹时：N-1 轮注入警告（给 LLM 自我纠错机会），第 N 轮硬停止。

### 2.4 CommitmentGuard 的出口设计

```typescript
// 没有工具调用时的出口逻辑
if (llmResponse.toolCalls.length === 0) {
  // ...记录 step...

  if (await this._evalStopHooks(step, history)) break;  // 外部条件

  if (guards && this._sharedBudget.remaining >= 2) {
    const feedback = await this._evalCompletionGuards(...);
    if (feedback !== null) {
      history.push({ role: 'user', content: feedback });
      continue;  // 注入反馈，继续迭代
    }
  }

  break;  // 所有 guard 通过，自然结束
}
```

`remaining >= 2` 的守卫是关键细节：防止 guard 的"继续迭代"指令在预算耗尽时产生无限循环。预算即将耗尽时，让 agent 以当前回复自然退出。

### 2.5 委托树的预算传递

```typescript
// 子 agent 创建时的预算限制
const maxChildIter = Math.min(
  input.max_iterations ?? defaultChildIter,
  this._sharedBudget.remaining,  // 不能超过父 agent 剩余量
);

if (maxChildIter <= 0) {
  return { success: false, error: 'Shared budget exhausted' };
}

// 子 agent 持有同一个 sharedBudget 引用
const childInit: ChildAgentInitOptions = {
  sharedBudget: this._sharedBudget,  // 共享，不复制
  // ...
};
```

子 agent 的所有消耗直接反映在父 agent 的预算视图中。这使得 `listCheckpoints()` 返回的 `budgetUsed` 是整个委托树的真实总消耗。

### 2.6 三层记忆的 token 经济学

| 层 | 常驻 context | token 成本 | 访问延迟 | 用途 |
|---|---|---|---|---|
| Layer 1 索引 | 总是 | ~200-400 tokens | 零 | 记忆目录，快速定向 |
| Layer 2 主题 | 按需 | 完整文件大小 | 一次文件读取 | 深度上下文加载 |
| Layer 3 日志 | 从不 | 零 | 关键词搜索 | 跨会话历史回溯 |

Layer 1 的注入位置是 `history[1]`（system 消息之后，用户输入之前），以 `[user, assistant]` 消息对的形式注入，利用了 LLM 的 "assistant prefill" 语义——让 LLM 把记忆索引视为自己已经知晓的背景，而不是用户提供的信息。

### 2.7 Checkpoint 的原子性保证

```typescript
async write(data: CheckpointData): Promise<void> {
  await fs.mkdir(this.dir, { recursive: true });
  const target = this.filePath(data.runId);
  const tmp    = `${target}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, target);  // 原子性：rename 是 O(1) 的文件系统操作
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* 清理失败忽略 */ }
    throw err;
  }
}
```

同一个 runId 的多次写入覆盖同一文件。`list()` 通过读取所有 `.json` 文件（排除 `.tmp.json`）提供历史视图，即使某些 checkpoint 文件损坏也不影响其他记录（逐个 try/catch）。

### 2.8 Prompt 组装的懒加载策略

```typescript
private async _assembleSystemPrompt(): Promise<string> {
  if (this._systemPromptCache !== null) return this._systemPromptCache;

  const depth = this._delegationInit?.depth ?? 0;
  if (depth > 0) {
    // 子 agent 跳过组装：避免重复 I/O，避免重复注入 AGENTS.md
    this._systemPromptCache = this._config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    return this._systemPromptCache;
  }

  // 并行加载各层（AGENTS.md + Skills 互不依赖）
  const [agentsMd, skills] = await Promise.all([
    loadAgentsMd({ workDir }),
    loadSkills({ config: skillsConfig, workDir }),
  ]);

  // ...组装并缓存
}
```

第一次 `run()` 时付 I/O 代价，之后从缓存返回。子 agent 复用父 agent 已构建的 context 而不重复组装，这在深度委托场景下节省了大量文件系统操作。

### 2.9 适配器层的错误归一化

不同 provider 用不同方式表达相同的错误类型（context 超长、rate limit、认证失败），必须在 adapter 层归一化为统一的错误分类，主循环才能做统一的处理决策：

```typescript
// 各 adapter 内部：将 provider 特定错误转换为标准错误类型
// AnthropicAdapter: 'context_length_exceeded'
// OpenAIAdapter:    message.includes('maximum context length')
// GeminiAdapter:    status === 400 && reason === 'RESOURCE_EXHAUSTED'

// 主循环只需判断：
if (isContextLengthError(err)) {
  // 触发 Reactive Compact，对所有 provider 行为一致
}
```

`isRetryableError()` 同样是 adapter 层的约定：速率限制、网络超时可以重试；认证失败、schema 错误不应重试（会浪费时间和预算）。

---

## 三、设计取舍的关键决策记录

### 为什么 Observation 用 JSON 字符串而非结构化对象传递

工具结果最终被序列化为 `Message.content: string` 传给 LLM。保持 Observation 为 JSON 字符串（而非在 TypeScript 类型系统中传递对象）的原因：统一了工具返回路径——无论是从 registry.dispatch() 返回，还是从 checkpoint 恢复，还是从 session log 重读，格式始终一致。解析只在需要时（onToolComplete 回调、error flag 判断）按需调用 `parseObservation()`。

### 为什么 CompletionGuard 在 stop hooks 之后评估

Stop hooks 代表"必须停止"的强制条件（例如：检测到危险操作，外部信号中止）。CompletionGuard 代表"应该继续"的建议条件（任务未完成的反馈）。逻辑优先级：强制停止 > 建议继续。如果顺序反了，stop hook 会被 CompletionGuard 的 continue 覆盖，产生安全漏洞。

### 为什么 AGENTS.md 加载使用层次遍历而非单一文件

项目通常是嵌套的：monorepo 根目录有全局 AGENTS.md，子包目录有更具体的指令。层次加载（外到内）使具体覆盖一般，而不是简单替换。这和 `.gitignore`、`.editorconfig` 的解析模式一致——用户已经熟悉这个心智模型。

### 为什么 Skills 支持关键词自动匹配而非只有显式 include

`include` 需要调用者提前知道有哪些 skill。`keywords` 允许基于任务内容的动态发现：task 包含 "docker" → 自动加载 docker-management skill。这使 Skills 系统在无需配置的情况下也能工作，降低了使用门槛。

---

## 四、与生产系统（hermes-agent Python）的对照

| 关注点 | hermes-agent Python | @hermes/runtime TypeScript |
|---|---|---|
| 工具发现 | AST 扫描 `tools/*.py`，顶层 `register()` 调用自注册 | 动态 import 触发注册，`loadAllTools()` 批量初始化 |
| 记忆系统 | FTS5 SQLite 会话搜索 + MEMORY.md + skills 目录 | 三层：buildMemoryIndex + TopicStore + SessionLogger |
| Prompt 组装 | `prompt_builder.py`：persona + skills_index + context_files + memory | 四层：base + AGENTS.md + Skills + Spec |
| 注入防御 | `_CONTEXT_THREAT_PATTERNS` 扫描 AGENTS.md/SOUL.md | `InjectionGuard`：扫描 AGENTS.md / Skills / Spec 三类外部文件 |
| Provider 支持 | OpenRouter 路由（200+ 模型），直连各 provider | Adapter 模式：Anthropic/OpenAI/Gemini/GLM |
| 多平台交付 | Telegram/Discord/Slack/WhatsApp/Signal gateway | 不在 runtime 层（上层关注） |
| 调度/自动化 | 内置 cron + webhook 触发器 | 不在 runtime 层（上层关注） |
| 测试覆盖 | ~3000 pytest，`scripts/run_tests.sh` CI 对齐 | tsc --noEmit 编译验证 |
| 配置隔离 | Profile 系统（`HERMES_HOME` env var，`get_hermes_home()`） | `sessionDir`, `memoryPath`, `workDir` per-instance |

**核心差异**：Python 系统是端到端的 agent 产品（含 UI、gateway、调度），TypeScript runtime 是纯粹的 agent 执行引擎（不含 I/O 层）。两者在核心设计理念上高度一致；TypeScript 版本在类型安全、结构化错误处理、checkpoint 机制上做了更系统的强化。

---

*文档版本：2026-04-20 | 对应代码：packages/runtime/src/*
