# meta-agent-runtime 全量代码评审（2026-05-29）

**评审范围：** `packages/meta-agent-runtime/src/` 全部 256 个 TS 文件
**Commit/版本：** `package.json` v0.2.1（注意 README 仍写 0.1.0）
**评审基线：** 在上一份 `CODE_REVIEW.md`（2026-05-23）基础上做差量审查
**结果一览：** 220/220 单测通过，`tsc --noEmit` 通过；本轮新发现高优先级 8 项、中优先级 12 项

---

## 一、上一轮问题修复确认

| 编号 | 问题 | 状态 |
|---|---|---|
| P0-A | `TeamStore.writeAll()` 非原子写 `team.json` | ✅ 已改用 `atomicWriteJson`（`robotics/team/TeamStore.ts:1272`）|
| P0-B | `SessionStore._upsertIndex` 非原子写 `index.json` | ✅ 已改用 `atomicWriteJson`（`core/SessionStore.ts:82`）|
| P1-A | `sanitizeScalar` 不过滤 `\n` | ✅ `core/memory/memoryWriter.ts:130` 现在 `replace(/[\r\n]/g, ' ')` |
| P1-C | 模块加载期求值的并发/输出常量 | ✅ `ToolOrchestration.getConcurrencyLimit()`、`bash.getMaxOut()`、`toolAdapter.getMaxResultSizeChars()` 全部改为惰性 getter |
| P1-E | `_completedCount` 命名歧义 | ✅ 已重命名为 `_finishedCount` / `finishedThisSession`（`subagent/SubAgentBridge.ts:181`）|
| P2-B | `SessionStore` sort-after-slice | ✅ 已改为 sort-before-slice + 注释（`core/SessionStore.ts:221`）|

P1-B / P1-D / P2-A / P2-C / P2-D / P2-E / P2-F 仍维持现状（绝大多数属于结构性技术债，无即时风险）。

---

## 二、新发现 — 🔴 高优先级

### H1 · `web_fetch` 缺少 SSRF 防护

**位置：** `src/tools/network/web_fetch/index.ts:43-53`

```ts
const url = rawUrl.startsWith('http://') ? rawUrl.replace('http://', 'https://') : rawUrl
...
const res = await fetch(url, { signal: ctx.abortSignal, ..., redirect: 'follow' })
```

模型可控的 `url` 会直接喂给 `fetch`：
- `http://169.254.169.254/latest/meta-data/iam/security-credentials/`（AWS IMDS）
- `http://localhost:6379` / `http://127.0.0.1:9200`
- `file://`（Node `fetch` 不支持 file，但 `gopher://` 等也不在白名单里）

更糟糕的是 `redirect: 'follow'`：模型只需发出 `https://attacker.com/r`，由攻击者把 302 指向 `http://169.254.169.254/...`，即可绕过任何前置 URL 校验。

**修复思路：**
1. 限制协议为 `https:` 与显式允许的 `http:` 域；
2. 在 fetch 前做 DNS 解析，把 IP 与 RFC1918 / 169.254/16 / 127.0.0.0/8 / ::1 / fc00::/7 等私网段对照黑名单；
3. `redirect: 'manual'`，逐跳手动验证目标 IP。

### H2 · `edit_file` 替换路径会被 `$&` / `$1` 元字符破坏

**位置：** `src/tools/fs/edit_file/index.ts:41`

```ts
const updated = replaceAll
  ? content.split(oldStr).join(newStr)
  : content.replace(oldStr, newStr)        // ← 这里
```

`String.prototype.replace(string, string)` 即便 pattern 是字符串，**替换串仍会解释 `$&`、`$1`、`$$`、`$'`、$\``**：
- 若 LLM 想插入 `process.env['DOI'] = $1`，落地会变成空串（无捕获组）。
- 若内容里写 `cost = old * $&`，行为不可预期。

**修复：** 与 replaceAll 分支统一为 `content.split(oldStr).join(newStr)`，或 `content.replace(oldStr, () => newStr)`。

### H3 · `edit_file` 未处理 `old_string === ''`

**位置：** `src/tools/fs/edit_file/index.ts:38`

```ts
const occurrences = content.split(oldStr).length - 1
```

当 `oldStr === ''`，结果 = `content.length`（每个字符之间都有空串）。后续 `split('').join(newStr)` 会把整个文件打散重组，把 `newStr` 插到每个字符之间，产生灾难性结果。需要在入口处拒绝空 `oldStr`。

### H4 · `bash` `timeout_ms` 不校验下界 / NaN / Infinity

**位置：** `src/tools/shell/bash/index.ts:79`

```ts
const timeoutMs = Math.min(typeof input['timeout_ms'] === 'number' ? input['timeout_ms'] : 30000, 120000)
```

`typeof NaN === 'number'`，所以 `NaN`、`-1`、`Infinity` 均可穿透：
- `NaN` → `Math.min(NaN, 120000) = NaN` → execFile 解读为无超时；
- 负数 → 立即被 kill 或行为未定义。

**修复：** clamp 到 `[1000, 120000]`，并显式拒绝非有限值。

### H5 · `bash` 把整个 `process.env` 传给子进程（含 API key）

**位置：** `src/tools/shell/bash/index.ts:98`

```ts
env: process.env as NodeJS.ProcessEnv,
```

任何命令都能读到 `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` / `GITHUB_TOKEN` 等。在 sub-agent 沙箱场景下这违背最小权限：若沙箱降权目的是隔离恶意 sub-agent，env 一旦泄露则一切隔离失效。

**修复：** 提供 `permission.shellEnv: 'inherit' | 'filtered' | 'empty'` 三档，默认 `'filtered'` 过滤 `*(_API_KEY|_TOKEN|_SECRET|_PASSWORD)`。

### H6 · `DeepSeekClient` 把 `ANTHROPIC_API_KEY` 当 DeepSeek key 用

**位置：** `src/kernel/api/DeepSeekClient.ts:131-133`

```ts
const apiKey = config.apiKey
  ?? process.env['DEEPSEEK_API_KEY']
  ?? process.env['ANTHROPIC_API_KEY']
```

第三层 fallback 一定 401；用户看到的报错往往是"DeepSeek 网关错误"，要排查到这条 fallback 上需要时间。删掉最后一行即可。

### H7 · `AnthropicClient` 每次 `streamMessages` 都 `new Anthropic(...)`

**位置：** `src/kernel/api/AnthropicClient.ts:100-105`

每个 API 调用都创建新 SDK client、丢弃旧 keep-alive 连接池。一个 agentic loop 跑 30 turns，就有 30 个新 client。建议按 `(apiKey, baseURL, betaHeader)` 三元组做模块级 LRU 缓存（DeepSeekClient 同理）。

### H8 · 重试 `sleep` 不响应 `abortSignal`

**位置：** `src/kernel/api/AnthropicClient.ts:67-68, 164`

```ts
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
...
await sleep(delayMs)
```

退避最长 30s。用户按 `^C` 后还要等满才会感知中断。改造为 abortable sleep（用 `AbortSignal.timeout` 或包一层 `addEventListener('abort')`）。DeepSeekClient 中存在同等问题。

---

## 三、新发现 — 🟠 中优先级

### M1 · `DirectSession` 已死但仍被导出，README 与代码严重不一致

- `src/routing/types.ts:26` ：`SessionMode = 'agentic' | 'campaign' | 'robotics'`，**`direct` 已被移除**。
- `src/routing/SessionRouter.ts:421` 的 `_createImpl()` 仅有 agentic/campaign/robotics 三个 case，没有 `'direct'` 分支；TypeScript 类型上传入 `'direct'` 直接编译失败。
- 然而 `src/modes/DirectSession.ts` 仍然存在，`src/modes/index.ts:7` 仍然 `export { DirectSession }`。**这是 117 行死代码**。
- `README.md` 第 9 / 102 / 302 行仍然把 `direct` 列为可用模式，会误导调用方。
- `README.md` 末尾"当前包版本：0.1.0"与 `package.json` 的 `0.2.1` 矛盾。

**修复：** 删除 `DirectSession.ts` 及 `modes/index.ts` 对应导出；更新 README 模式表与版本号；CODE_REVIEW 旧文档中"117 个测试"等过时数字一并更新。

### M2 · `ModeDetector._hasActiveCampaigns` 是死代码

**位置：** `src/routing/ModeDetector.ts:442`

该私有方法定义后从未在 `detect()` / `detectSync()` 调用，但顶端 doc-comment "Layer 3：环境信号"还在描述这条路径。`CampaignStateStore.ts:279` 的注释也声称 ModeDetector 每个 session 跑一次它。两套口径不一致。

**修复二选一：**
- 在 `detectSync()` 落幕前调用，作为 agentic 的最小提升；或
- 删除方法、删除文档注释、删除 CampaignStateStore 处的反向引用。

### M3 · `toolAdapter` 的 JSON Schema 校验不完整

**位置：** `src/modes/toolAdapter.ts:54-87`

只校验 `type` / `enum` / `required` / `items` / `additionalProperties`。**忽略 `minLength` / `maxLength` / `minimum` / `maximum` / `pattern` / `format` / `oneOf` / `anyOf`。** 工具作者写在 schema 里的约束，被 kernel 默默无视；所有"安全 ID"、"非负数"、"邮箱格式"等防御都得在工具内自己重做一次。

**建议：** 引入 `ajv`（≈30KB gzip）作为 schema 校验器，或在 `validateValue` 里补齐主要关键字。

### M4 · `web_fetch` 缓存为模块级 `Map`，跨 session 共享

**位置：** `src/tools/network/web_fetch/index.ts:7`

```ts
const cache = new Map<string, { content: string; expiresAt: number }>()
```

- 同一进程下所有 `MetaAgentSession`/`SessionRouter` 共享同一缓存。
- 测试间无法隔离（与上一轮提到的 `MetaAgentContextStore._cache` 同性质）。
- 没有按 cookie/auth header 区分 → 即便未来加入凭据，立刻形成跨 session 泄漏。

**修复：** 将缓存挂载到 `RuntimeContext` 或 `MetaAgentSession`，或至少暴露 `clearWebFetchCache()` 给测试。

### M5 · `web_fetch.prompt` 参数虚假签名

**位置：** `src/tools/network/web_fetch/index.ts:35-41, 66`

`prompt: { type: 'string', description: 'What to extract from the page' }` 但代码里 `prompt` 只是被拼到返回串末尾，**没有任何抽取逻辑**。这是与 schema 描述不一致的"虚假参数"。要么实现真正的 LLM 抽取（haiku 之类的轻量模型），要么从 schema 移除。

### M6 · `PermissionPolicy` bash 路径检查只盯 `/` 开头

**位置：** `src/kernel/permissions/PermissionPolicy.ts:177`

```ts
const absPathPattern = /(?:^|\s|['"])(\/(?:[^\s'"`$;&|()<>]+\/?)+)/g
```

- `cd ../../../etc && cat passwd`、`cd $HOME/.ssh`、`cat ~/.aws/credentials` 完全不命中。
- 只能靠 `cwd` 字段守门，但 `cwd` 默认 = `process.cwd()`。

威胁模型下"模型可信"或许接受，但应在文档/警告中明示这是已知盲点，并补一组针对相对路径越权的 unit test。

### M7 · `looksLikeFilesystemPath` 对 CJK / Unicode 路径误判

**位置：** `src/kernel/permissions/PermissionPolicy.ts:155`

```ts
if (!/^[A-Za-z0-9._\-~@]+$/.test(firstComp)) return false
```

中文桌面 home 路径形如 `/Users/张三/...`：`firstComp = 'Users'` 通过 → 走到 `KNOWN_OS_ROOT_DIRS` → OK。表面上 `张三` 这一段不在第一段，没问题。但当真实第一段含 Unicode（极少见的 `/张三/...`）会被当作"看上去不像路径"而**跳过工作区检查**。建议把校验放宽为 Unicode identifier，或将第一段不在 KNOWN_OS_ROOT_DIRS 时统一视为"可疑、需检查"。

### M8 · `SensitiveCommandPatterns` 同时存在大量误报与漏报

**位置：** `src/kernel/permissions/SensitiveCommandPatterns.ts`

漏报样例：
- `eval $(echo cm0gLXJmIC8K | base64 -d)`
- `r''m -rf /`
- 别名/函数：`alias del=rm; del foo`
- 绝对路径 `/usr/bin/rm`（依然命中 `\brm\b`，但 `git rm` 也命中 → 误报）

误报样例：
- `git rm -r src/old`
- 注释 `# 删除 rm 模块`
- 源代码字面值 `"rm -rf"`

威胁模型下作为"提醒型"防护尚可，但应在文档/代码注释里写明："此为启发式提醒、非可证明的防御"。

### M9 · `bash` 超时时丢弃已收集 stdout/stderr

**位置：** `src/tools/shell/bash/index.ts:106`

```ts
if (e.killed) return { content: `Command timed out after ${timeoutMs}ms`, isError: true }
```

子进程在被 SIGKILL 前可能已经写了 50KB stdout，模型完全看不到 → 调试体验差。建议改成：

```ts
if (e.killed) {
  const parts = [`Command timed out after ${timeoutMs}ms`]
  if (e.stdout) parts.push(trunc(e.stdout))
  if (e.stderr) parts.push(`STDERR:\n${trunc(e.stderr)}`)
  return { content: parts.join('\n'), isError: true }
}
```

### M10 · `bash` stdout / stderr 各自截到 `limit`，合计 2× `limit`

**位置：** `src/tools/shell/bash/index.ts:101-103`

不致命，但与"`META_AGENT_MAX_TOOL_OUTPUT_CHARS` 字节"的描述不符。建议先合并再截断，或文档明示这是"单流上限"。

### M11 · `AgenticSession` 直接用全局 `crypto.randomUUID()`

**位置：** `src/modes/AgenticSession.ts:25`、`src/core/MetaAgentSession.ts` 等多处

`engines.node >= 18.0.0`，但全局 `crypto` 在 Node 18 早期版本仍是行为实验性的。建议统一 `import { randomUUID } from 'node:crypto'`，与已经显式 import 的 `MetaAgentSession.ts:29` 保持一致。

### M12 · 工具异常路径双重包裹 → 错误信息可能丢失

**位置：** `src/core/MetaAgentSession.ts:494-498` × `src/runtime/instrumentTool.ts`

```ts
// MetaAgentSession._wrapTool
try { const result = await tool.call(...); ... return result }
catch (err) { return { content: `Tool error: ${...}`, isError: true } }
```

但 `instrumentTool` 内部已经 try/catch 把异常包成 `ToolResult` 返回——外层 `catch` 永远不会被命中，反而带来一层冗余包装。如果未来某天 `instrumentTool` 改成不吃异常，外层就接管错误格式，会导致用户层报错文案不连续变化。建议：明确"异常→ToolResult"只在一层完成（推荐内层）。

---

## 四、新发现 — 🟡 低优先级 / 技术债

### L1 · `systemPrompt: ''` 这条约定靠 `filter(Boolean)` 维系，脆弱

`AgenticSession` 给 KernelSession 传 `systemPrompt: ''`，又靠 `KernelLoop` 里 `[systemPrompt, appendSystemPrompt].filter(Boolean).join('\n\n')` 跳过空串。一旦 KernelLoop 改成 `=== undefined` 判定，MetaAgentSession 就会重复注入空字符串 + 双 `\n\n` 前缀。建议引入显式 builder API。

### L2 · `SessionRouter._impl as any` Duck-typing

**位置：** `src/routing/SessionRouter.ts:319-338`

用 `as any` 检查 robotic 后端的 `pendingExperiences` / `pendingPhysicalAnchors`。建议改成 `RoboticsBackendCapabilities` 接口让 RoboticsSession 显式 implement。

### L3 · `process.env` 多处直接读取，测试隔离差

`PermissionPolicy.ts`、`bash/index.ts`、`AnthropicClient.ts`、`DeepSeekClient.ts`、`toolAdapter.ts`、`config.ts` 都散落 `process.env[...]`。整体测试时无法干净覆盖，"在 .env 里 export 一次"等隐性副作用难追踪。建议集中到 `loadRuntimeEnv()` 工厂在启动时一次性快照。

### L4 · `edit_file` 未使用 `FileStateCache`

Kernel 已经透传 `ctx.readFileState`，但 `edit_file` 没读取它做 read-before-write 一致性检查。如果模型 read_file 后被并发工具改动，写入会覆盖、产生"LLM 静默丢改"。CC 内部用 `file_state_guard` 防御这一典型 footgun。

### L5 · 工具执行管线缺整体图

`PermissionPolicy → schema parse → V&V hook before → tool.call → V&V hook after → provenance → context modifier` 这条链路散落在 4 个文件里，没有单一文档讲解。建议在 `docs/` 加一张时序图，再用文档链接的方式从各文件指向它。

### L6 · 文档矩阵混乱

根目录现存：
- `README.md`
- `meta-agent-architecture.md`
- `REPORT_ARCHITECTURE.md`
- `REPORT_FUNCTIONAL.md`
- `CODE_REVIEW.md`
- `sandbox_architecture_plan.svg`
- `docs/` 目录还有更多

文档间相互引用关系不清晰，CODE_REVIEW 旧文档里"117 个测试"等数字已落后实际（本轮 220）。建议统一收口到 `docs/` 并补 `docs/README.md` 充当索引。

---

## 五、架构层面观察

### 5.1 持久化层质量稳定
`atomicWriteJson` + `persist/schemas.ts` 的 `parseArrayFiltered` 组合，把上一轮的多处"非原子写"问题彻底解决。仍有少量 `*.md` 类视图文件用普通 `writeFile`，但都是渲染副产品。

### 5.2 三 Session 共性持续未抽象
`DirectSession`（已死）、`AgenticSession`、`CampaignSession`、`RoboticsSession` 仍各自实现：构造器初始化、`registerTool` 转 KernelTool、`_submitInFlight` guard。约 60-80 行可以下沉到 `BaseSession`。

### 5.3 静态 Map / 模块级状态依然遍布
`web_fetch.cache`、`todo_write.todoStore`、`SubAgentTaskStore` 旧版残留、`MetaAgentContextStore._cache` 等都是"测试无法干净 reset"的状态。建议未来引入 `RuntimeScope` 概念，把这类全局态绑到 session 生命周期。

### 5.4 ModeDetector 文档与实现脱节
L3（环境信号）只在文档里有，code 里没调用；`hasTools` 信号在 `detectSync` 中混入"agentic 兜底"但实际并未促升级；提示词中 `direct` 已经不在合法集合内，但 `LLM_SYSTEM_PROMPT` 里几个 example 仍隐含三段决策树，整体可读性下降。

---

## 六、安全面汇总

| 向量 | 状态 | 说明 |
|------|------|------|
| 路径遍历（绝对路径） | ✅ 已防护 | `workspaceGuard` + `realpath` 检查 |
| 路径遍历（相对路径） | ⚠️ M6 | 只检测 `/` 开头，相对路径靠 `cwd` 守门 |
| Shell 注入 | ✅ 无风险 | 全部使用 `execFileAsync` |
| Git 选项注入 | ⚠️ P2-E 未修 | `task.branch` 未 allowlist |
| YAML 注入 | ✅ 已防护 | sanitizeScalar 已过滤 `\n` |
| SSRF | 🔴 H1 | web_fetch 完全无防护 |
| 命令凭据泄漏 | 🟠 H5 | bash 透传整个 process.env |
| TOCTOU（edit_file） | ⚠️ L4 | 未使用 FileStateCache |
| 模型 String.replace 元字符 | 🔴 H2 | `$&` / `$1` 被解释 |
| API key 错路提供商 | 🟠 H6 | DeepSeek 兜底到 ANTHROPIC_API_KEY |

---

## 七、测试 / 构建

- `npm test` **220/220 通过**（4.1.7，约 3.5s）。
- `npm run typecheck` 通过，无 TS 错误。
- 测试覆盖空白（上一轮列出仍未补齐）：
  - `TeamStore.claim()` 并发认领
  - `CampaignStateStore.completeTask()` 多实例并发
  - `GitWorkspaceManager.pruneStaleWorktrees()`
  - 任何 SSRF / 沙箱越权 / `edit_file` 元字符场景

---

## 八、建议修复优先级

| 优先级 | 编号 | 预计工时 |
|--------|------|----------|
| 🔴 立即 | H2：`edit_file` 替换分支用 split/join | 5 分钟 |
| 🔴 立即 | H3：拒绝 `old_string === ''` | 5 分钟 |
| 🔴 立即 | H4：`timeout_ms` clamp + 非有限值拒绝 | 10 分钟 |
| 🔴 立即 | H6：删掉 `DeepSeekClient` 的 `ANTHROPIC_API_KEY` 兜底 | 5 分钟 |
| 🔴 立即 | M1：删 `DirectSession` 死码 + 更新 README/版本号 | 30 分钟 |
| 🟠 近期 | H1：`web_fetch` SSRF 防护（DNS 解析 + IP 黑名单） | 1-2 小时 |
| 🟠 近期 | H5：bash env 三档过滤策略 | 1 小时 |
| 🟠 近期 | H7：SDK client 三元组缓存 | 30 分钟 |
| 🟠 近期 | H8：abortable retry sleep | 30 分钟 |
| 🟠 近期 | M2：删 `_hasActiveCampaigns` 死码或补 Layer 3 调用 | 30 分钟 |
| 🟡 计划 | M3：补齐 schema 校验或引入 ajv | 半天 |
| 🟡 计划 | M4 / 5.3：模块级缓存绑定到 RuntimeScope | 半天 |
| 🟡 计划 | L4：`edit_file` 用 FileStateCache 做 TOCTOU 防御 | 半天 |
| 🟡 计划 | L1：消除"systemPrompt:''"约定，引入显式 builder | 半天 |

---

## 九、总体评价

代码库整体质量**优**，工程严谨度明显高于普通开源 agent runtime：
- 持久化、并发、错误恢复都有可见的设计；上一轮发现的 P0/P1 问题在两周内被几乎全部消化。
- 测试覆盖广（24 个 test file / 220 cases），routing、kernel loop、compact 这些关键路径都有覆盖。
- 文档量大（README、3 份 REPORT、架构 MD、SVG），用心程度突出。

但存在**两个系统性短板**：
1. **网络/外部输入面防御不足。** Web fetch SSRF、bash env 透传、edit_file 字符串元字符这些都属于"假设模型可信，所以不查"的设计取舍。一旦威胁模型变化（如 prompt injection 攻击 → 让模型自己写 SSRF URL），整个安全面会瞬间瓦解。
2. **代码-文档-类型三方不同步。** `direct` 模式、`_hasActiveCampaigns` 死码、`prompt` 虚假参数、版本号 0.1.0 vs 0.2.1，都是"曾经做过、又一半撤回"的迹象。建议设立一次"文档 vs 实现"对账，并在 PR 模板里加 checkbox。

修完本轮 H 系列 + M1 / M2 后，runtime 可以放心被外部应用集成。
