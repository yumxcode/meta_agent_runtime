# meta-agent-runtime Timeout 全流程审核

> **修复状态（2026-07-27 同日）**：T1 / T2 / T3 / T5 已修复，配置文件 `timeouts` 段已接通，
> 5 个既有超时环境变量 + 5 个新增已全部登记进 `ENV_REGISTRY` 与 `docs/config-reference.md`。
> T4（drift deadline 倒挂）、T6（web_fetch 独立超时）、T7（bash 120s 上限）本次未在范围内。
> 详见文末《修复记录》。

**审核日期**：2026-07-27
**版本**：0.7.9
**基准模型**（用户给定，用于判定"合适"）：一次 LLM 调用，**首字 ≤ 30s**，之后 **≈20 token/s**
**方法**：静态枚举 + 5 个一次性探针脚本实测（含 SDK 行为、配置文件解析、工具超时装配）。探针已删除。

---

## 结论速览

**问题 1：默认值是否合适？**

绝大多数非 LLM 超时（工具 180s、锁 10s、租约 5–10 min、git 60s）是合理的。**问题集中在 LLM 调用这一层**，共 4 个真问题：

| # | 问题 | 严重度 |
|---|---|---|
| T1 | **主对话流式调用没有任何有效超时**——SDK 的 `timeout` 只覆盖到响应头，流体一旦卡住就是永久挂起（已实测证明） | **P1** |
| T2 | **compact 用非流式 + 12k max_tokens + SDK 默认 600s**，按 20 tok/s 恰好等于 600s，无余量；失败还会被 SDK 重试 2 次 → 最长 30 分钟停摆 | **P1** |
| T3 | `run_agent` 内部要等 **1,860,000 ms**，但没声明 `timeoutMs: 0`，被内核 **180,000 ms** 掐断——差 10.3 倍（已实测） | **P1** |
| T4 | DriftAgent 外层等待 20 min < 内层子代理 30 min 上限，**deadline 倒挂** | P2 |
| T5 | 多个 flash 侧调用按 20 tok/s 算**必然超时**（30s 预算 vs 需要 50–90s） | P2 |

**问题 2：能否通过配置文件设置 timeout？**

**完全不能。一个都不行。**

配置文件 `~/.meta-agent/config.json`（及项目级 `<projectDir>/.meta-agent/config.json`）的 schema 是一张 **7 个字符串字段的白名单**（`modelConfigFile.ts:74` `STRING_FIELDS`）：`mainModel` / `fallbackModel` / `flashModel` / `compactModel` / `apiKey` / `baseURL` / `tavilyApiKey`。任何其它键在解析时被**静默丢弃，且不产生任何警告**。

实测：

```
写入 config.json:
  { "mainModel":"glm-5.2", "requestTimeoutMs":120000,
    "toolTimeoutMs":60000, "timeout":90000, "LLM":{"requestTimeoutMs":120000} }
loadModelConfigFile() 解析结果:  {"mainModel":"glm-5.2"}
任何 timeout 键存活?             false
```

现状是：**部分**超时可用环境变量调，**LLM 请求超时一个都调不了**（`MetaAgentConfig`、`KernelConfig`、CLI flag 里都没有 timeout 字段——三处 grep 均为零命中）。详见下文《可配置性矩阵》。

---

## 一、LLM 调用链路：按 20 tok/s 算账

### T1（P1）主对话流式调用实际上**没有超时**

**文件**：`kernel/api/AnthropicClient.ts:158-166, 230-238`、`kernel/api/DeepSeekClient.ts:179`

两个 client 构造时都**没有传 `timeout`**，所以取 SDK 默认 600s。但关键不在数值，而在**它覆盖不到流式响应体**。

SDK 源码（`node_modules/@anthropic-ai/sdk/client.js:319-343`）：

```js
async fetchWithTimeout(url, init, ms, controller) {
  const timeout = setTimeout(() => controller.abort(), ms);
  try   { return await this.fetch.call(undefined, url, fetchOptions); }
  finally { clearTimeout(timeout); }     // ← 响应头一到就清掉
}
```

`fetch` 在**收到响应头**时 resolve，此时定时器被 `clearTimeout` 清除。SSE 流的头是立刻返回的，所以从第一个字节开始，这次调用**再无任何超时约束**。

**实测证明**（本地起一个发完 3 个 SSE 事件后永久卡住的 server，client 显式设 `timeout: 2000`）：

```
client timeout = 2000ms | elapsed = 12016ms | events received = 3
outcome: NO-ABORT: still open after 12s (client timeout was 2s)
```

2 秒的超时，12 秒后流仍然开着。**对照组**：同样 2s 超时的**非流式**请求在 2014ms 正确抛出 `APIConnectionTimeoutError`——证明差异确实来自流式/非流式，而非配置错误。

再看运行时这一侧有没有兜底（`AnthropicClient.ts:234`）：

```ts
for await (const event of stream) { yieldedAny = true; ... yield event }
```

`activeAbortSignal` 只来自 `modelAdmission?.signal ?? params.abortSignal`——都不带计时器。全仓搜索确认 KernelLoop 对流消费也没有任何 idle watchdog。

**影响**：provider 网关半死（TCP 连接活着、SSE 不再推事件）时，整个 agent **无限期挂起**。auto / loop daemon 场景下无人值守，表现为"跑着跑着不动了"，没有日志、没有超时、不会重试、断路器不会触发（断路器数的是 turn 和错误，不是墙钟）。5 次重试机制也够不着——它只在请求**抛错**时生效。

**为什么不能简单加一个总超时**：主对话默认 `maxTokens = 131_072`（`config.ts:608`），按 20 tok/s 打满要 **6,554 秒 ≈ 109 分钟**。任何"总时长"上限都会误杀合法的长生成。

**建议**：加**两段式流看门狗**，而不是总超时。
- **首字超时（TTFT）**：从发起请求到第一个 `content_block_delta` / `message_start`。给定 30s 的观测值，建议默认 **90s**——长上下文的 prefill 会显著拉长首字（compact 触发点附近尤其明显），留 3 倍余量。
- **流间隔超时（idle）**：相邻两个流事件之间。20 tok/s 意味着正常情况下事件间隔在秒级；建议默认 **60s**，静默超过一分钟即判定为卡死。注意 extended thinking 期间可能有较长静默，这个值需要能配。
- 两者触发后 `abort()` 当前请求并抛可重试错误，交给已有的 5 次重试 + `buildStreamErrorRecoveryText` 恢复路径——这条路已经写好了，现在只是永远走不到。

### T2（P1）compact 的 600s 预算按 20 tok/s **恰好不够**

**文件**：`kernel/compact/CompactConversation.ts:40, 376-392, 436-452`

```ts
export const COMPACT_MAX_TOKENS = 12_000
const client = new Anthropic({ ..., maxRetries: options.maxRetries ?? 2 })   // 没有 timeout
const response = await client.messages.create({ max_tokens: COMPACT_MAX_TOKENS, ... })  // 非流式
```

非流式路径**确实**受 SDK 超时约束（已实测，见上）。SDK 对非流式还会算一道
`expectedTime = 3600000 × 12000 / 128000 = 337,500ms < 600,000ms` → 不抛错，最终 `timeout = 600_000`。

按用户模型算账：

| 项 | 时长 |
|---|---|
| 生成 12,000 token @ 20 tok/s | **600 s** |
| 首字 / prefill（compact 的输入是**整个将满的上下文窗口**，通常 10 万 token 量级） | 30 s+，实际远不止 |
| **合计** | **> 600 s** |
| **可用预算** | **600 s** |

也就是说：**在声明的 max_tokens 上限处，预算是负的**。实际摘要通常 2k–4k token（100–200s），所以平时不炸；但这个余量是靠"模型没写满"撑着的，而 robotics 的 compact 模板有 12 节、明确要求逐条列实验台账和逐字用户消息——正是最容易写长的那一档。

更糟的是 `maxRetries: 2`：一次超时会被 SDK 自动重试 2 次，每次最长 600s → **单次 compact 最长 30 分钟**才落到 `runStructuralFallback`。

**好消息**：`AutoCompact.ts:154-167` 有确定性的结构截断兜底，所以不会丢会话，只会停摆。

**建议**（按性价比排序）：
1. **改成流式**（`stream: true` + 累积文本）。SDK 自己的报错文案就是 "Streaming is strongly recommended for operations that may take longer than 10 minutes"。改完后配合 T1 的 idle watchdog，行为才真正正确。
2. 若暂不改流式：显式给 compact client 传 `timeout`（建议 **900_000**）并把 `maxRetries` 降到 **1**——600s×3 的最坏情况比"一次给足"更糟。
3. 顺带考虑把 `COMPACT_MAX_TOKENS` 从 12k 降到 **6k**。12k token 的摘要本身就偏离了"压缩"的初衷，且下一轮它要整段进上下文。

### T5（P2）flash 侧调用的 30s 预算普遍不足

**文件**：`core/flash/FlashClient.ts:56`（`DEFAULT_TIMEOUT_MS = 30_000`，非流式，超时返回 `null`）

按 30s 首字 + 20 tok/s 逐个核算：

| 调用点 | maxTokens | 需要 ≈ 30s + n/20 | 现有 timeout | 判定 |
|---|---|---|---|---|
| `postSessionExtract.ts:126` 知识抽取 | 1,200 | **90 s** | 30 s | ❌ 差 3 倍 |
| `PrinciplePromotion.ts:105,168` 原则晋升 ×2 | 1,000 | **80 s** | 30 s | ❌ 差 2.7 倍 |
| `QueryAnalyzer.ts:288` 查询分析 | 250 | 42.5 s | 8 s | ⚠ 见下 |
| `experience_write` 抽象原则 | 120 | 36 s | 30 s | ⚠ 临界 |
| `RoboticsSession.ts:1420` 相关性判定 | 60 | 33 s | 30 s | ⚠ 临界 |
| `AgenticBackendFactory.ts:151` 改动摘要 | 120 | 36 s | 30 s | ⚠ 临界 |

需要区别对待：

- **`QueryAnalyzer` 是刻意的，不算缺陷**。它是 8s 硬中止 + 5s 软等待预算的双层设计，注释写明"不阻塞当前轮，超时就走启发式回退"（`QueryAnalyzer.ts:65-79`）。这是正确的"尽力而为"语义。
- **其余都是真的欠预算**。`postSessionExtract` 和 `PrinciplePromotion` 要生成 1,000–1,200 token 的结构化 JSON，30s 在给定假设下**必然超时**，且失败是**静默的**（返回 `null` → 走回退/跳过）。后果是"知识沉淀悄悄不工作了"——正是 README 主打的机制，而且没有任何日志。

**缓解因素**：flash 模型实际吐字速度通常远高于 20 tok/s（100+ 很常见），所以现实中未必触发。但把预算定在"只有快模型才够"的位置，本身就是脆弱的。

**建议**：
1. `FlashClient.query()` 改为**按 maxTokens 推导默认超时**，而不是一刀切 30s：
   `timeoutMs ?? clamp(TTFT_BUDGET + maxTokens / TOKENS_PER_SEC * 1000, 30_000, 180_000)`，其中两个常量可配（默认 30s / 20 tok/s，正好对齐用户给的观测）。这样新增调用点自动拿到合理预算，不需要每处手填。
2. 超时时**打一条 warn**（当前完全静默），至少让"知识抽取连续失败"能被发现。

---

## 二、非 LLM 层的 timeout 问题

### T3（P1）`run_agent` 被内核超时掐断，实测差 10.3 倍

**文件**：`tools/agent/run_agent/index.ts:8-31, 43, 94`、`kernel/tools/ToolExecution.ts:189-192`

```ts
const effectiveTimeoutMs = tool.timeoutMs ?? getToolTimeoutMs()   // 默认 180_000
```

实测装配结果：

```
run_agent.timeoutMs          = undefined   (⇒ 内核默认 180000 ms)
run_agent internal MAX_WAIT  = 1860000 ms
```

`run_agent` 内部 `MAX_WAIT_MS = DEFAULT_SUB_AGENT_MAX_DURATION_MS + 60_000` = 31 分钟，但工具定义里**没有 `timeoutMs: 0`**，所以内核 3 分钟就把它掐了。

对照——同类工具都做对了：

| 工具 | `timeoutMs` | 是否正确 |
|---|---|---|
| `research_dispatch/index.ts:108` | `0` | ✅ |
| `paper_search/index.ts:63` | `0` | ✅ |
| `experiment_dispatch/index.ts:48` | `0` | ✅ |
| **`run_agent`** | **未声明** | ❌ |

`run_agent` 恰恰是委派指引里推荐的**同步委派主路径**（"依赖结果 → 用同步 `run_agent`"）。

**影响**：任何超过 3 分钟的同步子代理，父 agent 拿到的是 `Tool timed out`，而**子代理仍在后台跑**（内核只是不再等，还会计入 `maxTimedOutRunningTools` 断路器，默认 3 次就触发 auto 模式熔断）。父 agent 永远看不到结果，可能重复派发。

顺带：`core/types.ts:296-297` 的注释写 "bounded by the sub-agent's own 5-min wall-clock cap"，而实际 `DEFAULT_SUB_AGENT_MAX_DURATION_MS = 30 * 60 * 1000` = 30 分钟。注释过期。

**建议**：给 `run_agent` 加 `timeoutMs: 0`（一行），并修正 `core/types.ts` 的注释。全仓扫描确认只有 `run_agent` 一个工具会同步等待子代理终态，所以这是完整修复。

### T4（P2）DriftAgent 的 deadline 倒挂

**文件**：`core/auto/learn/DriftAgent.ts:128-155` vs `core/auto/verify/VerifyJudge.ts:232, 253`

```ts
// DriftAgent — spawn 时没传 maxDurationMs ⇒ 内层用默认 30 min
const MAX_WAIT_MS = 10 * 2 * 60 * 1000     // 外层只等 20 min  ← 倒挂
```

```ts
// VerifyJudge — 写法正确
maxDurationMs: limits.maxDurationMs,
const MAX_WAIT_MS = limits.maxDurationMs + 60_000    // 外层 = 内层 + 60s
```

`core/roles/reviewer.ts:76` 的 `spawnAndWait` 也用的是正确写法（`DEFAULT_SUB_AGENT_MAX_DURATION_MS + 60_000`）。**只有 drift 这一处倒挂**。

**影响**：drift 判定在 20 分钟处放弃并返回 `skip('drift agent returned no usable result')`，而 drift 子代理会继续跑到 30 分钟——继续烧预算，它的 `experience_write` 仍会落盘，但裁决已经被丢弃。航向校正静默失效 10 分钟。

`10 * 2 * 60 * 1000` 这个写法本身也可疑，像是从 `10 * 60 * 1000` 手工翻倍留下的痕迹。

**建议**：对齐 VerifyJudge——显式传 `maxDurationMs`，外层用 `maxDurationMs + 60_000`。

### T6（P3）`web_fetch` / `web_search` 没有自己的超时

**文件**：`tools/network/web_fetch/index.ts:311`（只有 `req.on('error', reject)`，无 `req.setTimeout`）、`tools/network/web_search/index.ts:69,141`

两者都只依赖 `ctx.abortSignal`（由内核 180s per-tool 超时驱动）和字节上限（`MAX_CONTENT * 2`）。

**影响**：黑洞主机（接受连接后不响应）会占住一个工具槽整整 3 分钟。不致命——abortSignal 确实接好了，最终会被回收——但对一个网络工具来说，独立的连接超时（~10s）+ 总超时（~60s）是更合适的粒度。

**建议**：`req.setTimeout(10_000)` 处理连接/首字节，外加 60s 总预算；两者可配。

### T7（P3）`bash` 的 120s 硬上限对构建类命令偏紧

**文件**：`tools/shell/bash/index.ts:10-12`

```ts
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000     // 模型即使显式传更大值也会被 clamp
```

`npm install`、`cargo build`、`pytest` 全套、Docker 构建都会超过 120s。模型无法突破这个上限，只能拆命令或改用 `job` 机制（`META_AGENT_JOB_TIMEOUT_MS` 默认 30 分钟）。auto 模式下这会表现为反复重试同一条构建命令然后触发 stall 断路器。

**建议**：把 `MAX_TIMEOUT_MS` 提到 **600_000**，并让它可配（env + 配置文件）。默认 30s 保持不变是对的——大多数命令是快的。

---

## 三、完整 timeout 清单

### LLM 调用层

| 位置 | 默认值 | 覆盖范围 | 可配置 | 评价 |
|---|---|---|---|---|
| 主对话（流式，Anthropic/GLM/Qwen） | SDK 600s | **仅响应头** | ❌ 无 | **T1** 实质无超时 |
| 主对话（流式，DeepSeek/OpenAI 协议） | SDK 600s | **仅响应头** | ❌ 无 | 同上 |
| 主对话重试 | `DEFAULT_MAX_RETRIES = 5`，退避 1s→30s | — | `config.maxRetries`（代码） | 合理 |
| compact（非流式） | SDK 600s，`maxRetries: 2` | 端到端 | ❌ 无 | **T2** 无余量 |
| FlashClient 侧调用 | 30s | 端到端 | 每调用点代码写死 | **T5** 多处欠预算 |
| QueryAnalyzer | 8s 硬中止 / 5s 软等待 | 端到端 | ❌ | 刻意设计，合理 |

### 工具层

| 位置 | 默认值 | 可配置 |
|---|---|---|
| 全局 per-tool | **180s**（`0` 禁用） | `META_AGENT_TOOL_TIMEOUT_MS` + `tool.timeoutMs` |
| `bash` | 30s，clamp [1s, **120s**] | 模型传 `timeout_ms`（**T7** 上限偏低） |
| `powershell` | 30s，上限 120s | 模型传 `timeout_ms` |
| `grep` 回退路径 | rg 探测 2s / 执行 30s / `FALLBACK_MAX_MS` 10s | ❌ |
| `web_fetch` / `web_search` | 无（继承 180s） | ❌（**T6**） |
| MCP HTTP | **60s** | `META_AGENT_MCP_TIMEOUT_MS`（**未登记，见下**） |
| MCP stdio | **60s** | `META_AGENT_MCP_STDIO_TIMEOUT_MS` + mcp 配置文件 `timeoutMs` |
| `run_agent` | 继承 180s，内部想等 1860s | ❌（**T3**） |
| `cron_create` 校验执行 | 30s | ❌ |

### 子代理 / 网关层

| 位置 | 默认值 | 可配置 |
|---|---|---|
| 子代理墙钟 | **30 min** | 每次 spawn 的 `maxDurationMs` |
| 子代理轮询间隔 | **30 min**（`types.ts:281`） | 每次 spawn 的 `pollIntervalMs` |
| verify judge 墙钟 / 外层等待 | 30 min / +60s | `META_AGENT_VERIFY_MAX_DURATION_MS` |
| drift agent 内层 / 外层 | 30 min / **20 min** | ❌（**T4** 倒挂） |
| role reviewer 外层 | 内层 + 60s | `spawnOptions.maxWaitMs` |
| 子代理 destroy 等待 | 10s | ❌ |

### Loop / Graph / 基础设施层

| 位置 | 默认值 | 可配置 |
|---|---|---|
| Graph activation 租约 TTL / 心跳 | 10 min / 10s | `activationLeaseTtlMs` |
| Transition 求值 | 30s | ❌ |
| Graph agent 节点墙钟 | 图里声明，lint 下限 5 min | 图定义 |
| 输出契约修复段 | min(120s, 剩余) | ❌ |
| Host admission 租约 / 轮询 | 5 min / 50ms | 构造参数 |
| daemon 锁 fresh / 心跳 | 5 min / 60s | ❌ |
| Wake claim TTL | 10 min | ❌ |
| 文件锁 timeout / stale | **10s / 30s** | `withFileLock` 参数 |
| Job 执行看门狗 | 30 min | `META_AGENT_JOB_TIMEOUT_MS` |
| Campaign 监控轮询 / 上限 | 5s / 24h | `pollIntervalMs` |
| git 操作（快照/worktree） | 60s | ❌ |

**这一层没有发现问题**——租约 > 心跳、TTL > 轮询间隔的层级关系都是对的，文件锁 10s/30s 的比例也合理。

---

## 四、可配置性矩阵（问题 2 的完整答案）

| 层级 | 配置文件 | 环境变量 | 代码参数 | 硬编码 |
|---|---|---|---|---|
| **LLM 请求超时（含 compact / flash）** | ❌ | ❌ | ❌ | ✅ 全部 |
| 工具全局超时 | ❌ | ✅ `META_AGENT_TOOL_TIMEOUT_MS` | ✅ `tool.timeoutMs` | — |
| bash / powershell | ❌ | ❌ | 模型入参（上限硬编码） | 上限 120s |
| MCP | ❌ | ✅ ×2 | ✅ mcp 配置文件 per-server | — |
| 子代理 / verify / drift | ❌ | 部分（verify 有，drift 无） | ✅ spawn 参数 | drift 外层 |
| Job | ❌ | ✅ | — | — |
| 锁 / 租约 / graph | ❌ | ❌ | 部分 | 多数 |

三点值得单独指出：

1. **配置文件对 timeout 零支持，且静默丢弃**。`STRING_FIELDS` 白名单外的键连一条 warning 都不给。用户写了 `"toolTimeoutMs": 60000` 会以为生效了，实际什么都没发生。**建议至少对未知键打一条 warn**——这个成本极低，收益是消除一整类"我明明配了"的困惑。
2. **`META_AGENT_MCP_TIMEOUT_MS` 是未登记的环境变量**。它在 `tools/mcp/HttpMcpClient.ts:48` 用自己的 `envInt` 读取，**没有走 `RuntimeEnv`**，因此既不在 `ENV_REGISTRY`（`infra/env/RuntimeEnv.ts:258-290`）里，也不在 `docs/config-reference.md` 里。实测两处 grep 命中数均为 0。用户无从知道它存在。
3. **`docs/config-reference.md` 只文档化了 2 个 timeout 环境变量**（`META_AGENT_TOOL_TIMEOUT_MS`、`META_AGENT_JOB_TIMEOUT_MS`），而实际存在 4 个（另有 `META_AGENT_MCP_STDIO_TIMEOUT_MS`、`META_AGENT_VERIFY_MAX_DURATION_MS`）+ 1 个未登记的。

---

## 五、建议的落地顺序

| 优先级 | 项 | 工作量 | 说明 |
|---|---|---|---|
| **P1** | T3 给 `run_agent` 加 `timeoutMs: 0` | 一行 | 影响主路径同步委派，改动零风险 |
| **P1** | T1 流式两段看门狗（TTFT + idle） | 中 | 唯一能修"无限挂起"的手段；恢复路径已存在 |
| **P1** | T2 compact 改流式，或显式 timeout 900s + maxRetries 1 | 小-中 | 先做后者止血，再做前者 |
| **P2** | T4 drift deadline 对齐 VerifyJudge | 小 | 照抄现成正确写法 |
| **P2** | T5 FlashClient 按 maxTokens 推导超时 + 超时告警 | 小 | 一处改动覆盖全部 8 个调用点 |
| **P3** | T7 bash `MAX_TIMEOUT_MS` 提到 600s | 一行 | |
| **P3** | T6 web_fetch/web_search 独立超时 | 小 | |
| **P3** | 配置文件支持 timeout 段 + 未知键告警 | 中 | 见下 |

### 关于"配置文件支持 timeout"的具体建议

现有 schema 是扁平字符串白名单，加数值字段需要扩展 `coerce`。建议加一个独立的 `timeouts` 段，避免污染现有字段：

```jsonc
{
  "mainModel": "glm-5.2",
  "timeouts": {
    "llmFirstTokenMs":  90000,    // T1 首字超时
    "llmIdleMs":        60000,    // T1 流间隔超时
    "compactMs":       900000,    // T2
    "flashTtftMs":      30000,    // T5 —— 与 flashTokensPerSec 一起推导每次调用的预算
    "flashTokensPerSec":   20,
    "toolMs":          180000,    // 覆盖 META_AGENT_TOOL_TIMEOUT_MS
    "bashMaxMs":       600000     // T7
  }
}
```

优先级沿用现有约定（配置文件 > 环境变量 > 内置默认），并在 `ENV_REGISTRY` 与 `docs/config-reference.md` 里补齐全部 5 个环境变量。

---

*本报告的关键结论均有实测支撑：SDK 流式/非流式超时行为差异（本地 stalling server，2s 超时下流 12s 未中止 vs 非流式 2014ms 正确中止）、配置文件丢弃全部 timeout 键、`run_agent` 装配后 `timeoutMs === undefined` 且内部等待 1,860,000 ms。探针脚本已删除，工作区保持干净。未做的部分：真实 provider 的长连接行为（无 API key），因此 T1 的"无限挂起"是基于 SDK 源码 + 本地复现的推断，而非对真实网关的观测。*

---

## 修复记录（2026-07-27）

### 一、默认值修改

| 项 | 改动 |
|---|---|
| **T1** 流式无超时 | 新增 `kernel/api/StreamWatchdog.ts`：包装流迭代器，**首字 90s + 流间隔 60s** 两段预算，超时先 `abort()` 当前请求再抛 `StreamTimeoutError`。两条流式路径（Anthropic/GLM/Qwen 与 DeepSeek/OpenAI）各自改用**每次尝试独立的 `AbortController`**，从父信号转发，这样看门狗能只中止本次请求而不破坏调用方信号。`isRetryableError` 认这个错误。**刻意不加总时长上限**——`maxTokens` 默认 131,072，按 20 tok/s 打满 109 分钟，任何总超时都会误杀合法长生成。 |
| **T2** compact 预算 | 显式 `timeout: timeout('compactMs')` = **720,000ms（12 分钟）**；同时把 SDK `maxRetries` 从 2 降到 **1**——三次 12 分钟会让无人值守跑停摆 36 分钟才落到结构截断兜底。 |
| **T3** `run_agent` 被掐断 | 加 `timeoutMs: 0`，并修正 `core/types.ts` 里"5-min wall-clock cap"的过期注释（实际 30 分钟）。 |
| **T5** flash 静默超时 | `FlashClient` 默认超时改为**按 maxTokens 推导**：`flashTtftMs + maxTokens/flashTokensPerSec×1000`，钳 `[30s,180s]`。删掉 7 处硬编码的 `timeoutMs: 30_000`。失败**不再静默**——`query()` 的 catch 现在打 warn（含 model / maxTokens / 实际超时值）。QueryAnalyzer 的显式 8s 保留，它是刻意的"不阻塞当前轮"设计。 |

推导后的实际预算：知识抽取（1200 tok）30s → **90s**；原则晋升（1000 tok）30s → **80s**；小调用（120 tok）30s → **36s**。

**T1 的重试语义分两种，是有意为之**：首字超时时 `yieldedAny === false`，走客户端自身的 5 次重试；流中途卡死时已有输出渲染过，重放会重复，因此抛给 KernelLoop 的 stream-error 恢复路径（`buildStreamErrorRecoveryText`）。这两条恢复路径**在此之前都不可达**——它们只在抛错时触发，而卡死的流从不抛错。

### 二、配置文件支持 timeout

新增 `src/core/timeouts.ts` 作为唯一解析点，**配置文件 `timeouts` 段 > 环境变量 > 内置默认**，逐字段、跨三层（session > project > global）合并。

```jsonc
{ "LLM": { "mainModel": "glm-5.2" },
  "timeouts": { "llmFirstTokenMs": 90000, "llmIdleMs": 60000, "compactMs": 720000,
                "flashTtftMs": 30000, "flashTokensPerSec": 20, "toolMs": 180000,
                "mcpMs": 60000, "mcpStdioMs": 60000, "jobMs": 1800000,
                "verifyMaxDurationMs": 1800000 } }
```

- 接线点在 `resolveConfig()`——每个入口（CLI / SessionRouter / 各 Session / 嵌入方）都会调它且带 `projectDir`，所以深处的调用点（API client、ToolExecution、MCP）不必在签名里穿配置。按 scope 幂等。
- `META_AGENT_MCP_TIMEOUT_MS` 从私有 `envInt` 改走统一解析器，**首次进入 `ENV_REGISTRY` 和文档**。
- **非法值告警而非静默钳位**：`"toolMs": -1` 若被钳成 `0` 会**禁用**工具超时，是危险的重新解释，所以一律拒绝并告警。`timeouts` 段内的未知键也告警（顶层未知键仍按原约定忽略，供存放自定义偏好）。
- `RuntimeEnv` 的三个超时访问器标记 `@deprecated` 但保留（嵌入方可能直接调用）。

**实测优先级**（探针，已删除）：

```
  25000   llmIdleMs         global file  → 25000
 600000   compactMs         project wins → 600000
  90000   toolMs            project file → 90000
  45000   llmFirstTokenMs   env var      → 45000
  60000   mcpMs             default      → 60000
PRECEDENCE OK (file > env > default, per-field, layered)
```

### 三、过程中发现并修掉的两个自身缺陷

实现看门狗时测试抓到两个问题，都值得记录：

1. **`await iterator.return()` 会永久挂起**。对一个正卡在未决 `await` 里的 generator 调 `return()`，返回的 promise 永不 settle（generator 无法被恢复去跑它的 `finally`）。原实现 `await` 了它——那会把 60 秒超时变成永久挂起，**正好是这个模块要解决的那个场景**。改为 fire-and-forget（真正的中止由 `onTimeout` → `ctrl.abort()` 完成）。三个测试用例最初就是卡在这里超时失败的。
2. **缓存最终结果破坏了 env 的 live-read 契约**。`RuntimeEnv` 文件头明确写着"每次访问直接读 `process.env`，不做快照"，因为测试和嵌入方会在 import 之后设 env。我最初缓存了整张解析后的表，导致既有测试 `VerifyJudge > applies env overrides` 失败。改为**只缓存文件层**（那才是有磁盘 I/O 成本的部分），env 每次实时读，十个字段的重新合并可以忽略不计。

另有一处**诚实更正**：我给看门狗加了 `void pending.catch(...)` 来"防止 orphan 的 `next()` 变成 unhandledRejection"，但回退验证显示测试照样通过——`Promise.race` 本身就会给两个 promise 都挂上 handler，所以那个崩溃场景并不存在。这行代码保留为显式保险，注释已改写为不再声称它修了一个真实 bug，对应测试也标注为"锁定不变量，防止未来把 race 换成手写计时器时回归"。

### 四、验证结果

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | **0 error** |
| `vitest run` | **163 文件 / 1271 用例全绿**（修复前 159/1233） |
| `tsx examples/mock-test.ts` | **11/11** |
| `npm run build` | **成功** |
| 端到端优先级探针 | **通过**（见上表） |

新增测试 38 个：`core/__tests__/Timeouts.test.ts`（20，含优先级/解析/推导/live-env/文件层缓存）、`kernel/api/__tests__/StreamWatchdog.test.ts`（10，含**用真实 SDK + 本地 stalling server** 验证看门狗在 SDK 超时够不到的地方生效）、`tools/__tests__/BlockingToolTimeouts.test.ts`（3）。

### 五、本次未做

- **T4** drift deadline 倒挂（外层 20min < 内层 30min）——用户未列入本次范围。改法现成：照抄 VerifyJudge 的 `maxDurationMs + 60_000`。
- **T6** `web_fetch` / `web_search` 独立超时（现依赖 180s 工具超时）。
- **T7** `bash` `MAX_TIMEOUT_MS` 120s 上限（构建类命令偏紧）。
