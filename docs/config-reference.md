# 配置参考(config.json)

> 权限配置(`permissions.json`)是独立文件,不在此文档范围内。

运行时配置由 **ConfigService** 统一管理,文件名固定为 `config.json`,跨三层合并(越具体越优先):

| 层 | 路径 | 说明 |
| --- | --- | --- |
| `global` | `~/.meta-agent/config.json`(或 `$META_AGENT_HOME/config.json`) | 对所有 workspace 生效 |
| `project` | `<workspace>/.meta-agent/config.json` | 仅当前 workspace |
| `session` | 进程内存(运行期由 `config` 工具写入) | 不落盘,优先级最高 |

合并优先级:`session > project > global`,**逐字段**覆盖。
在 `resolveConfig()` 里,合并后的文件值再与调用方/CLI 参数比较,最终顺序为:**配置文件 > CLI/调用方 > Provider 内置默认**。

`config.json` 管四类键:模型 / Provider / 搜索 / **超时(`timeouts`)**。其余运行参数(thinking、maxTurns、maxTokens 等)不在文件里,通过 CLI flag 或代码传入。文件中**未知顶层键会被运行时忽略**(可顺带存放自己的 per-project 偏好,如 `ui.theme`);但 `timeouts` 段内的未知键**会告警**,以免拼错后静默失效。

> ⚠️ 优先级例外:`timeouts.*` 是**配置文件 > 环境变量 > 内置默认**(与模型键一致)。而 `TAVILY_API_KEY` 相反,是 env 优先于文件——见文末环境变量一节。

---

## 完整文件长这样(带注释版)

> ⚠️ 实际 `config.json` 必须是**纯 JSON,不能带注释**(加载器用 `JSON.parse`)。下面是带注释的说明版,复制时请删掉 `//` 注释,或直接用文末的纯 JSON 模板。

```jsonc
{
  // ── LLM:模型与 Provider 选择 ─────────────────────────────────────────────
  "LLM": {
    // 主交互模型。
    // 默认:自动探测到的 Provider 的 default 模型 ——
    //   zhipu(默认 Provider)→ "glm-5.2"
    //   deepseek            → "deepseek-v4-flash"
    //   qwen                → "qwen-plus"
    //   anthropic           → "claude-opus-4-6"
    "mainModel": "glm-5.2",

    // 回退模型:主模型无法满足请求时(如扩展思考配额超限)切换。
    // 默认:Provider 的 fallback(zhipu → "glm-4.6");若与 mainModel 相同则省略。
    "fallbackModel": "glm-4.6",

    // 快速副调用模型:模式探测 / 记忆写入 / 压缩 等轻量调用。
    // 默认:Provider 的 flash(zhipu → "glm-5.2")。
    "flashModel": "glm-5.2",

    // 压缩(长上下文摘要)专用模型。
    // 默认:= flashModel(上面那个)。
    "compactModel": "glm-5.2",

    // Provider API Key。设了就覆盖环境变量探测。
    // 默认:从环境变量按优先级自动探测 ——
    //   ZHIPU_API_KEY / ZAI_API_KEY / GLM_API_KEY  >  DEEPSEEK_API_KEY
    //   >  QWEN_API_KEY  >  ANTHROPIC_API_KEY
    "apiKey": "<your-key>",

    // Provider Base URL。
    // 默认:探测到的 Provider 的端点 ——
    //   zhipu     → "https://open.bigmodel.cn/api/anthropic"
    //   deepseek  → "https://api.deepseek.com"
    //   qwen      → "https://dashscope.aliyuncs.com/apps/anthropic"
    //   anthropic → "https://api.anthropic.com"
    "baseURL": "https://open.bigmodel.cn/api/anthropic"
  },

  // ── web_search:网页搜索 ──────────────────────────────────────────────────
  "web_search": {
    // Tavily 搜索 key(首选搜索 Provider)。等价于环境变量 TAVILY_API_KEY。
    // 默认:未设置 —— 回退到 Anthropic 原生搜索。
    "tavilyApiKey": "tvly-<your-key>"
  },

  // ── timeouts:各阶段超时(全部可选,单位 ms,除 flashTokensPerSec)────────
  // 优先级:本段 > 对应环境变量 > 内置默认。逐字段生效,不必写全。
  // 超出合法区间或类型不对的值会**告警并忽略**(不会被静默钳位)。
  "timeouts": {
    // 流式主对话:到「第一个流事件」的预算。默认 90000(90s)。
    // 按首字 30s 估算并留 3 倍余量 —— 压缩阈值附近的长上下文 prefill 会显著拉长首字。
    "llmFirstTokenMs": 90000,

    // 流式主对话:相邻两个流事件之间的最大静默。默认 60000(60s)。
    // 刻意**没有**总时长上限:maxTokens 默认 131072,按 20 tok/s 打满约 109 分钟,
    // 任何总超时都会误杀合法长生成;卡死只能靠「静默多久」判定。
    "llmIdleMs": 60000,

    // 压缩副调用(非流式,因此这个值约束整次调用)。默认 720000(12 分钟)。
    "compactMs": 720000,

    // flash 副调用的预算 = flashTtftMs + maxTokens / flashTokensPerSec,
    // 结果钳在 [30s, 180s]。默认 30000 / 20。
    "flashTtftMs": 30000,
    "flashTokensPerSec": 20,

    // 单工具全局超时。默认 180000(3 分钟),`0` 禁用。
    // 阻塞等待子代理的工具(run_agent 等)自己声明 timeoutMs:0,不受此值影响。
    "toolMs": 180000,

    // MCP 单次 RPC。默认均为 60000。
    "mcpMs": 60000,
    "mcpStdioMs": 60000,

    // LocalExecutor 单个 job 的看门狗。默认 1800000(30 分钟),`0` 禁用。
    "jobMs": 1800000,

    // 单个 auto verify 审核子代理的墙钟上限。默认 1800000(30 分钟)。
    "verifyMaxDurationMs": 1800000
  }

  // ── 任意自定义键(运行时忽略,仅供你自己的 workflow 读取)─────────────────
  // ,"ui": { "theme": "dark" }
}
```

### 兼容的扁平写法

也接受所有键放在顶层的旧式扁平格式;同名时 **grouped(`LLM.*` / `web_search.*`)优先**:

```json
{ "mainModel": "glm-4.7", "apiKey": "...", "tavilyApiKey": "tvly-..." }
```

### 纯 JSON 模板(可直接用)

```json
{
  "LLM": {
    "mainModel": "glm-5.2",
    "fallbackModel": "glm-4.6",
    "flashModel": "glm-5.2",
    "compactModel": "glm-5.2",
    "apiKey": "<your-key>",
    "baseURL": "https://open.bigmodel.cn/api/anthropic"
  },
  "web_search": {
    "tavilyApiKey": "tvly-<your-key>"
  },
  "timeouts": {
    "llmFirstTokenMs": 90000,
    "llmIdleMs": 60000,
    "compactMs": 720000,
    "flashTtftMs": 30000,
    "flashTokensPerSec": 20,
    "toolMs": 180000,
    "mcpMs": 60000,
    "mcpStdioMs": 60000,
    "jobMs": 1800000,
    "verifyMaxDurationMs": 1800000
  }
}
```

> 用 `config` 工具修改更方便,例如 `config set key=LLM.mainModel value="glm-4.7"`(默认写
> `project` 层)。模型/Provider 类键在**下一个会话**生效(当前会话启动时已解析定型)。

---

## 不在文件里的运行参数(CLI / 代码传入)及默认值

这些属于 `MetaAgentConfig`,不通过 `config.json` 设置;列出默认值供参考:

| 参数 | 默认值 |
| --- | --- |
| `thinkingConfig` | `{ type: 'adaptive' }`(主模型默认开启扩展思考) |
| `maxTokens` | `131072` |
| `maxTurns` | `Infinity`(不限) |
| `maxBudgetUsd` | `Infinity`(不限) |
| `domain` | `'generic'` |
| `systemPrompt` | 内置默认工程助手提示词 |

---

## 环境变量(独立机制,**不在任何文件中**)

环境变量**不从配置文件读取**,也没有 `.env` 自动加载(代码里没有 dotenv)。它们由
**RuntimeEnv**(`src/infra/env/RuntimeEnv.ts`)在**每次访问时直接读 `process.env`**,
解析/默认值/范围都集中在该模块的 `ENV_REGISTRY`。

设置方式 = 进程环境本身:shell `export FOO=bar`、启动器、CI secrets、systemd unit、
容器 env 等。`config` 工具**不能**改环境变量(它只写 `config.json` 的三层)。

与 `config.json` 有重叠的两类:
- `TAVILY_API_KEY` ↔ `web_search.tavilyApiKey`:解析顺序为 `调用方 > 环境变量 > 配置文件`(env 优先于文件)。
- Provider 凭证(`ZHIPU_API_KEY`/`DEEPSEEK_API_KEY`/`QWEN_API_KEY`/`ANTHROPIC_API_KEY`):由 Provider Registry 解析,参与 Provider 自动探测,属于凭证而非普通配置,不在下表。


### 超时类(10 个,**均可被 `config.json` 的 `timeouts` 段覆盖**)

这一组的优先级与其它环境变量相反:**配置文件 > 环境变量 > 内置默认**。它们由
`src/core/timeouts.ts` 解析(不走 RuntimeEnv 的访问器),`ENV_REGISTRY` 只负责登记文档。

| 环境变量 | 配置键 | 默认 | 区间 | 说明 |
| --- | --- | --- | --- | --- |
| `META_AGENT_LLM_FIRST_TOKEN_TIMEOUT_MS` | `timeouts.llmFirstTokenMs` | `90000` | [1e3, 3.6e6] | 流式调用到第一个流事件的预算 |
| `META_AGENT_LLM_IDLE_TIMEOUT_MS` | `timeouts.llmIdleMs` | `60000` | [1e3, 3.6e6] | 流式调用相邻事件间的最大静默;**无总时长上限** |
| `META_AGENT_COMPACT_TIMEOUT_MS` | `timeouts.compactMs` | `720000`(12 分钟) | [1e4, 3.6e6] | 压缩副调用(非流式,约束整次调用) |
| `META_AGENT_FLASH_TTFT_MS` | `timeouts.flashTtftMs` | `30000` | [1e3, 6e5] | flash 推导预算的首字部分 |
| `META_AGENT_FLASH_TOKENS_PER_SEC` | `timeouts.flashTokensPerSec` | `20` | [1, 1e4] | flash 推导预算的吐字速率假设 |
| `META_AGENT_TOOL_TIMEOUT_MS` | `timeouts.toolMs` | `180000`(3 分钟) | [0, 3.6e6] | 单工具全局超时,`0` 禁用 |
| `META_AGENT_MCP_TIMEOUT_MS` | `timeouts.mcpMs` | `60000` | [1e3, 6e5] | 单次 HTTP MCP RPC |
| `META_AGENT_MCP_STDIO_TIMEOUT_MS` | `timeouts.mcpStdioMs` | `60000` | [100, 6e5] | 单次 stdio MCP RPC(也可在 mcp 配置文件里 per-server 覆盖) |
| `META_AGENT_JOB_TIMEOUT_MS` | `timeouts.jobMs` | `1800000`(30 分钟) | [0, 8.64e7] | LocalExecutor 单 job 看门狗,`0` 禁用 |
| `META_AGENT_VERIFY_MAX_DURATION_MS` | `timeouts.verifyMaxDurationMs` | `1800000`(30 分钟) | [1e4, 3.6e6] | 单个 auto verify 审核子代理的墙钟上限 |

**flash 副调用的实际预算是推导出来的**,不是固定值:
`flashTtftMs + maxTokens / flashTokensPerSec × 1000`,再钳到 `[30s, 180s]`。
按默认值,1200 token 的知识抽取拿到 90s,1000 token 的原则晋升拿到 80s,120 token 的小调用拿到 36s。
显式传入 `timeoutMs` 的调用点(如 QueryAnalyzer 的 8s)不受推导影响。

### 其它环境变量

| 环境变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `META_AGENT_HOME` | string | `~/.meta-agent` | 所有持久化状态的根目录 |
| `META_AGENT_AUTO_COMPACT_WINDOW` | int | 模型窗口(未设) | 覆盖压缩计算用的上下文窗口(tokens) |
| `META_AGENT_AUTOCOMPACT_PCT_OVERRIDE` | float (0,1] | `0.65` | 触发自动压缩的窗口占比 |
| `META_AGENT_LONG_CONTEXT_AUTOCOMPACT_THRESHOLD` | int | 关闭(未设) | 提前压缩的硬 token 上限 |
| `DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT` | flag | 关闭 | 关闭自动压缩 |
| `META_AGENT_MAX_OUTPUT_TOKENS` | flag | 未设 | 设置后固定 max output tokens 并禁用自动升档 |
| `META_AGENT_MAX_TIMED_OUT_RUNNING_TOOLS` | int | `3` | auto 模式超时仍运行工具的熔断上限 |
| `META_AGENT_MAX_TOOL_USE_CONCURRENCY` | int | `10` | 工具并发上限,范围 [1,64] |
| `META_AGENT_KEEP_TERMINAL_JOBS` | int | `200` | 内存中保留的终态 job 数(LRU) |
| `META_AGENT_IGNORE_USER_PERMISSIONS` | flag | 关闭 | 忽略磁盘权限配置(hermetic 模式) |
| `META_AGENT_MAX_TOOL_OUTPUT_CHARS` | int | `102400`(100 KiB) | bash 工具输出上限,范围 [1KiB,1MiB] |
| `META_AGENT_MAX_TOOL_RESULT_CHARS` | int | `204800`(200 KiB) | 回传给模型的工具结果上限,范围 [1KiB,1MiB] |
| `META_AGENT_CLI_MAX_VISIBLE_CHARS` | int | `50000` | CLI 截断阈值,范围 [10k,2M] |
| `META_AGENT_MAX_RESUME_MESSAGES` | int | 不限(全量) | 恢复会话时逐条加载的消息上限;超出则把更早历史折叠成一条摘要。未设 = 全量加载 |
| `META_AGENT_MAX_RESUME_BYTES` | int | `67108864`(64 MiB) | 恢复时读取历史文件的字节上限(安全护栏) |
| `META_AGENT_WEB_FETCH_UA` | string | 内置 Chrome UA | web_fetch 的 User-Agent |
| `META_AGENT_TRUST_FAKE_IP` | flag(=`1`) | 关闭 | 允许伪造客户端 IP 头(仅测试) |
| `META_AGENT_SEARCH_PROVIDER` | string | 自动(未设) | 固定 web_search Provider(如 `tavily`) |
| `TAVILY_API_KEY` | string | 未设置 | Tavily key(= `web_search.tavilyApiKey`) |
| `META_AGENT_CAMPAIGN_EVAL_CACHE` | int | `32` | Campaign 评估缓存容量 |
| `META_AGENT_MAX_CONCURRENT_SUB_AGENTS` | int | `4`(auto 模式 `3`) | 子代理并发上限 |
| `META_AGENT_MAX_QUEUED_SUB_AGENTS` | int | `64` | 子代理排队上限(范围 [0,10000]) |
| `META_AGENT_SUB_AGENT_START_DELAY_MS` | int | `50` | 每个排队子代理启动前的错峰延迟(ms) |
| `META_AGENT_MAX_TOTAL_SUB_AGENT_BUDGET_USD` | float | 不限(auto 模式 `5`) | 子代理总预算上限(USD) |

> 注:此表的默认值抄自当前代码;Provider 默认模型/这些常量若改动,本文档需同步。
