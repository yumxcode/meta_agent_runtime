# meta-agent-runtime 代码审查报告 · 0.8.11

> **状态更新（修复轮次已完成）**
>
> 除 **P1-1（沙箱只挡写不挡读，沿用上轮决定，暂不修复）** 外，本报告列出的问题**已全部实施并验证**。
> 修复过程中通过写测试又发现了 **5 个新缺陷**（notebook_edit 路径解析、notebook_edit 输出污染、
> grep 的 rg 错误吞异常、loop-scheduler `--idle-exit-ms 0` 语义反了、memory 扫描缓存失效失灵），
> 一并修掉。
>
> **验证基线**：`tsc --noEmit` 0 错误；`vitest` **203 文件 / 2007 用例全绿**（修复前 194/1777，新增 230 个用例）；
> 连跑 3 次无 flake；`npm run build` + `check-publishable-manifest` 通过；CLI `--version` / `--help` / `env` 冒烟正常。
>
> **覆盖率**：行 67.88% → **71.04%**，分支 56.74% → **59.58%**，函数 65.19% → **67.07%**。
> 倒挂已消除，详见文末「修复记录」。

- **版本**：0.8.11（HEAD `4b16822` + 未提交的 auto-scheduler idle-exit 工作）
- **范围**：`src/` 全部模块，**排除 campaign 相关代码**（`src/campaign/`、`src/campaigns/`、`src/coordination/` 中的 Campaign* / DOESampler / ParetoAnalyzer / CapsuleBuilder 等，开发中）
- **规模**：约 81,442 行 TS（不含测试）
- **审查日期**：2026-08-10
- **上一轮**：`CODE_REVIEW.md`（0.8.7，2026-08-04）

---

## 基线验证

| 项目 | 结果 |
| --- | --- |
| `tsc --noEmit` | **0 错误** |
| `vitest run` | **194 文件 / 1777 用例 全绿**（上轮 178/1450） |
| 行覆盖率 | **67.88%** |
| 分支覆盖率 | **56.74%** |
| 函数覆盖率 | **65.19%** |
| `TODO` / `FIXME` / `HACK` | **0** |
| `@ts-ignore` / `@ts-expect-error` | **0** |
| `as any` | 15（含 campaign） |
| 空 `catch {}`（无注释吞异常） | **0** |
| `dist/`、`*.tgz` 是否入库 | **否**（`.gitignore` 正确） |

---

## 总体评价

上一轮的判断依然成立，而且**这一轮更强**：注释解释「为什么」而不是「是什么」，几乎每个非平凡分支都带着「之前的 bug 是什么、为什么不能改回去」的说明；`withFileLock` 的 owner-token + mtime 心跳、`acquireDaemonLock` 用 `link()` 做原子创建、`SessionStore` 明确写死 index→history 的加锁顺序、`Expr.ts` 同时封顶源码长度和递归深度并解释了「否则 RangeError 会被 `isDeterministicGraphError` 误判为瞬时故障」——这些都是踩过坑之后才写得出来的代码。`web_fetch` 的 SSRF 防护（DNS 预解析 + IP pin + 逐跳重定向校验）达到了生产级水准。

本轮**没有发现新的安全边界失效**。上轮 P1-1（沙箱只挡写不挡读）仍是已知且被显式接受的缺口，`DEFAULT_MAIN_SANDBOX` 依旧没有默认 `readDenyPaths`——这与文档一致，不重复计为新问题。

下面的问题分两类，请分开看：

- **第一部分（P1–P3）是 5 个具体缺陷**，每一条我都做了代码级复核或最小复现，附复现脚本与实测输出。
- **第二部分（P4）是一个结构性结论**：这份代码库的测试覆盖分布是**倒挂的**——被反复审查、反复加固的核心（kernel loop、graph runtime、persist、sandbox）覆盖率 78–88%，而**每个任务都必然走一遍的最外层 I/O 适配层**（两个 LLM wire adapter、全部文件工具、MCP HTTP 客户端）覆盖率在 3%–15%。本轮 3 个缺陷里有 2 个正好落在这些低覆盖文件里，不是巧合。

---

## 严重程度定义

| 级别 | 含义 |
| --- | --- |
| **P1** | 静默的错误行为：功能看起来正常，实际已经坏了，且不报错 |
| **P2** | 真实 bug 或语义与文档/命名不符，在特定条件下会咬人 |
| **P3** | 局部缺陷、可用性风险、诊断输出问题 |
| **P4** | 结构性 / 工程实践 |

---

# 第一部分：具体缺陷

## P1-A · MCP 凭据缺失时不跳过服务器，而是注册一个「带空凭据」的客户端

**位置**：`src/tools/mcp/mcpConfigFile.ts:110`（`interpolateEnv`）

```ts
function interpolateEnv(value: string): string | undefined {
  const result = value.replace(/\$\{([^}]+)\}/g, (_m, varName) => resolveVar(varName))
  // If the original value contained a placeholder and the result is empty,
  // the variable was missing — return undefined to signal "skip".
  return (value.includes('${') && !result.trim()) ? undefined : result
}
```

**问题**

跳过条件是「**整个结果**为空」，但真实配置里凭据几乎不会单独出现，而是嵌在字面量里。模块自己的文档示例就是这个形状：

```jsonc
"headers": { "Authorization": "Bearer ${ZHIPU_API_KEY}" }   // ← 文件顶部的官方示例
"env":     { "API_KEY": "${MY_API_KEY}" }
```

当 `ZHIPU_API_KEY` 缺失时，`result` 是 `"Bearer "`，`result.trim()` 是 `"Bearer"`——非空。于是 `interpolateEnv` 返回 `"Bearer "`，`interpolateRecord` 不返回 `undefined`，`buildClient` 里的这段防线**永远不触发**：

```ts
if (cfg.headers && resolvedHeaders === undefined) {
  console.warn(`[mcp] Skipping server "${name}": missing environment variable in headers`)
  return null
}
```

结果：服务器被静默注册，`loadMcpConfig` 把它算进成功列表，`buildMcpServerInstructions` 把它写进系统提示词告诉模型「这个工具可用」，然后每一次实际调用都在远端 401。用户看到的是「MCP 时好时坏」，而不是启动时一行「缺 ZHIPU_API_KEY，已跳过」。

模块顶部的承诺是：*"Entries whose required header / env values resolve to empty strings are skipped with a warning."* 这个承诺对**最常见的写法不成立**。

**实测**（`interpolateRecord` 逐行转写，`MISSING_TOKEN` 未设置）

```
case A  {"Authorization":"${MISSING_TOKEN}"}       -> undefined          ← 正确跳过
case B  {"Authorization":"Bearer ${MISSING_TOKEN}"}-> {"Authorization":"Bearer "}   ← 漏
case C  {"API_KEY":"sk-${MISSING_TOKEN}"}          -> {"API_KEY":"sk-"}             ← 漏
```

（用真实 `loadMcpConfig` 跑同一配置：`registered = ['repro-http']`，客户端确实进了 registry。）

**建议**

判定应该落在**每个占位符**上，而不是整条字符串：

```ts
function interpolateEnv(value: string): string | undefined {
  let missing = false
  const result = value.replace(/\$\{([^}]+)\}/g, (_m, varName: string) => {
    const resolved = resolveVar(varName)
    if (!resolved) { missing = true; return '' }
    return resolved
  })
  return missing ? undefined : result
}
```

顺带把 warning 里的变量名带上（现在只说「missing environment variable in headers」，不说是哪个），排障成本差一个数量级。

---

## P2-A · `auto-scheduler --max-concurrent` 不是并发上限，是批大小；一个慢 wake 会阻塞整个 workspace

**位置**：`src/core/auto/AutoScheduler.ts:69-81`（`tickOnce`）

```ts
async tickOnce(now = Date.now(), signal?: AbortSignal): Promise<number> {
  const capacity = Math.max(0, this.maxConcurrent - this.active.size)
  if (capacity === 0) return 0
  const records = await this.store.claimDue(now, undefined, capacity)
  for (const record of records) {
    const task = this.runClaim(record, signal).finally(() => this.active.delete(task))
    this.active.add(task)
  }
  if (records.length > 0) await Promise.all([...this.active])   // ← 这里
  return records.length
}
```

**问题**

`tickOnce` 在返回前 `await` 掉了**全部** in-flight 任务，而 `run()` 又 `await tickOnce()`。所以每轮开始时 `this.active` 必然是空的：

1. `this.maxConcurrent - this.active.size` 恒等于 `maxConcurrent` —— `active.size` 的记账是死代码；
2. `maxConcurrent` 的真实语义是「**每批最多认领几个**」，不是「同时最多跑几个」；
3. **一个慢 wake 会让整批 drain 完之前，所有新到期的 wake 都排不进来**，哪怕有空闲槽位。auto 模式一次 wake 是一整个 turn，几分钟到几十分钟都正常，所以这不是理论问题。

同一个仓库里 `src/loop/daemon.ts:117-127` 对同一个模式的实现是**对的**——`inFlight` map 不阻塞、`available = maxConcurrent - inFlight.size`、循环继续 poll。两个调度器同名 flag 语义不同。

**实测**（`maxConcurrent: 4`，一个 2s 的 SLOW 在跑，300ms 时插入一个立即到期的 URGENT）

```
exit reason = idle
start SLOW  @7ms
end   SLOW  @2010ms
start URGENT@2081ms      ← 300ms 就该起跑，实际等了 1.78s，期间有 3 个空闲槽位
end   URGENT@2095ms
```

对照组（同批认领的两个 wake 确实是并行的，所以问题只在**跨批**）：

```
finish order = [ 'B@58ms', 'A@1510ms' ]
```

**建议**

照搬 `daemon.ts` 的形状：

```ts
async tickOnce(now = Date.now(), signal?: AbortSignal): Promise<number> {
  await this.store.reconcileOrphans(now)
  const capacity = Math.max(0, this.maxConcurrent - this.active.size)
  if (capacity === 0) return 0
  const records = await this.store.claimDue(now, undefined, capacity)
  for (const record of records) {
    const task = this.runClaim(record, signal).finally(() => this.active.delete(task))
    this.active.add(task)
  }
  return records.length   // 不 await；run() 的 finally 里 allSettled 收尾
}
```

`--once` 路径需要单独保留「跑完再退」的语义（`await Promise.allSettled([...this.active])` 放到 CLI 侧），否则 `--once` 会变成即发即弃。

顺带：`hasLiveWork()` 里的 `if (this.active.size > 0) return true` 在当前实现下**永远为 false**（调用点 `active` 已排空）。修完上面这条它才真正开始起作用——这也说明 idle-exit 逻辑目前是靠 store 里的 `claimed` 状态兜底的，改并发模型时要一起验证。

---

## P2-B · DeepSeek/OpenAI 协议流解析假设 `id` + `name` 一定出现在该 tool_call 的首个 delta 里

**位置**：`src/kernel/api/DeepSeekClient.ts:443-470`（`processStreamInner`）

```ts
if (!toolBlockByCallIdx.has(tcIdx)) {
  const blockIdx = nextBlockIdx++
  toolBlockByCallIdx.set(tcIdx, blockIdx)
  yield {
    type: 'content_block_start',
    index: blockIdx,
    content_block: {
      type: 'tool_use',
      id:   tc.id ?? `call_${tcIdx}`,        // ← 只读一次
      name: tc.function?.name ?? '',          // ← 只读一次
      input: {},
    } as never,
  }
}
```

**问题**

`id` 和 `name` 只在**第一次见到这个 index** 时读取，之后没有任何修补路径：`KernelLoop.ts:1078-1084` 在 `content_block_start` 时把 name 存进累加器，`finaliseAccumulator`（`:505-508`）直接用它建 `tool_use` 块，中间没有 `content_block_delta` 能改 name。

OpenAI 的 chunk 协议并不保证首个 delta 就带齐 `id`/`name`——常见但非强制。一旦不带：

- **name 变成 `''`** → `ToolOrchestration` 里 `toolByName.get('')` 落空，这一轮工具调用整批失败；
- **id 变成合成的 `call_0`** → 这个 id 会作为 `tool_call_id` 回传给服务端，服务端找不到对应的 tool call，直接 400。

两种都是「模型明明输出了正确的工具调用，运行时把它弄丢了」，而且错误信息指向的是工具名/工具 id，完全看不出根因在流解析。

**实测**（`processStreamInner` 的 tool_calls 分支逐行转写）

```
A) id+name 在首个 delta（常见形状）
   { id: 'call_abc', name: 'bash', args: '{"cmd":"ls"}' }        ← 正确

B) 首个 delta 只有 type，id+name 在第二个 delta（协议同样合法）
   { id: 'call_0',   name: '',     args: '{"cmd":"ls"}' }        ← 全丢

C) name 分片流式下发
   { id: 'call_abc', name: 'ba',   args: '{"cmd":"ls"}' }        ← 截断
```

**建议**

按 index 累积，在 `finish_reason` 或 index 首次出现**且信息齐备**时才 emit `content_block_start`：

```ts
const acc = new Map<number, { blockIdx: number; id?: string; name: string; started: boolean }>()
// 每个 delta：合并 tc.id / 追加 tc.function.name
// 首次拿到非空 name 时才 yield content_block_start
// arguments 先缓存，start 之后再统一 flush
```

**这个函数目前完全没有测试**（`DeepSeekClient.ts` 行覆盖率 **6%**，`src/kernel/api/__tests__/` 只有 `AnthropicAuth.test.ts` 和 `StreamWatchdog.test.ts`）。根因之一是 `processStream` / `processStreamInner` **没有导出**，没有测试缝。建议把 `processStreamInner` 导出为纯 generator（输入 chunk 序列，输出 StreamEvent 序列），上面三种 chunk 形状就是三个表驱动用例。

---

## P3-A · grep 工具的 `multiline` 在 rg / JS 两条路径下语义不同

**位置**：`src/tools/fs/grep/index.ts:61` 与 `:86`

```ts
if (input['multiline']) args.push('-U', '--multiline-dotall')   // rg 路径
...
const regex = new RegExp(pattern, (input['case_insensitive'] ? 'i' : '') + (input['multiline'] ? 'm' : ''))
```

`rg --multiline-dotall` = 「`.` 匹配换行」；JS 的 `'m'` = 「`^`/`$` 匹配行首行尾」。这是两个**不同**的东西，JS 的对应物是 `'s'`（dotAll）。

后果：同一个 `pattern + multiline:true`，在装了 ripgrep 的机器上和没装的机器上给出不同结果——而工具描述（`multiline: 'Multiline mode. Default: false'`）没说明是哪一种。模型据此写出的跨行正则在 fallback 路径上静默不匹配。

**建议**：`'m'` → `'s'`；工具描述改成 `'Multiline mode: . matches newlines. Default: false'`。

---

## P3-B · grep 的 Node fallback 会被模型提供的正则**同步**卡死，超时保护形同虚设

**位置**：`src/tools/fs/grep/index.ts:86-115`

rg 路径有 `timeout: 30000`。fallback 路径没有：

```ts
const regex = new RegExp(pattern, ...)          // pattern 直接来自模型
...
for (const entry of await readdir(dir, ...)) {
  if (... || Date.now() - startedAt > FALLBACK_MAX_MS || ...) { stoppedEarly = true; break }
  ...
  if (regex.test(await readFile(full, 'utf-8'))) matchedFiles.push(full)   // ← 同步阻塞
}
```

`FALLBACK_MAX_MS` 只在**循环每次迭代开头**检查一次；`regex.test()` 本身是同步的，一旦发生灾难性回溯，事件循环被独占，这个检查根本轮不到执行，`_ctx.abortSignal` 也无法生效——整个 agent 进程（含所有心跳、锁续期）一起冻住。

**实测**：`pattern = '(a+)+$'`，内容是 41 个字符的普通文本

```
regex.test() blocked for 86909 ms on a 41 char string
```

87 秒，单线程完全无响应。而 `withFileLock` 的 staleMs 默认 30s、`heartbeat` 默认 10s——**期间持有的锁会被别的进程判定为死亡并抢走**，这就从「一次搜索变慢」升级成「跨进程互斥失效」。

**建议**（任选，从便宜到彻底）

1. 对 fallback 路径的 pattern 做长度 + 嵌套量词的保守拒绝（`(x+)+`、`(x*)*`、`(x|x)*` 这几类）；
2. 把 fallback 的匹配放进 `worker_threads`，主线程可 `terminate()`；
3. 最省事：fallback 不可用时直接返回明确错误，要求安装 ripgrep——反正 `isRgAvailable()` 已经在了，把「没有 rg 就只能降级」这件事说清楚比默默降级成一个能卡死进程的实现更好。

---

## P3-C · 刚 `expired` 的 wake 还要再等 7 天才被 `prune` 删除（未提交代码）

**位置**：`src/core/auto/AutoContinuationStore.ts`（工作区未提交改动）

`expireStale()` 写 `updatedAt = now`，`prune()` 的条件是 `now - record.updatedAt < olderThanMs` 就跳过（默认 7 天）。而 `runAutoSchedulerCommand` 里的调用顺序正好是 `expireStale()` → `prune()`：

```ts
const expired = await store.expireStale().catch(() => [])
const pruned  = await store.prune().catch(() => 0)
```

所以本次刚标记为 expired 的记录，`prune` 一条都删不掉，要等 7 天后的某次启动。这条改动的动机在注释里写得很清楚——「28 条记录，27 条早已结束，每次 poll 都在锁里全量重读」——但**这个动机没有被这次改动解决**：队列长度不会因为 expire 而下降。

**建议**：给 `expireStale` 写入的记录保留原 `updatedAt`（或另加 `expiredAt` 字段，`prune` 用 `fireAt` 作为过期基准）。同时建议为 `prune` 的 retention 单独开一个更短的默认值——terminal 记录的价值是审计，7 天对「done」合理，对「expired」偏长。

---

## P3-D · `EngineeringToolRegistry.toString()` 对 entry pair 做默认排序

**位置**：`src/tools/registry/EngineeringToolRegistry.ts:212-213`

```ts
for (const [cap, fMap] of [...this.map.entries()].sort()) {
  for (const [level, entry] of [...fMap.entries()].sort()) {
```

`Array.prototype.sort()` 无比较器时把每个元素 `String()` 化——这里元素是 `[key, value]` 二元组，会变成 `"capability,[object Object]"`。外层碰巧按 capability 排对了；内层 `level` 是数字 fidelity，字符串序会给出 `0, 1, 10, 2`。

同文件的 `list()`（`:163`）和 `fidelitiesFor()`（`:180`）都写了正确的比较器，只有诊断输出这条漏了。纯 cosmetic，但两行就能修：`.sort((a, b) => a[0].localeCompare(b[0]))` / `.sort((a, b) => a[0] - b[0])`。

---

# 第二部分：结构性结论

## P4-A · 覆盖率倒挂：加固最狠的地方覆盖最好，每次都走的地方几乎没测

整体 67.88% 行 / 56.74% 分支，这个数字本身不难看。问题是**分布**。

**按目录**（已剔除 campaign）：

| 覆盖率 | 目录 | 说明 |
| --- | --- | --- |
| 88.6% | `src/modes` | |
| 87.2% | `src/sandbox` | 上轮重点加固，效果明确 |
| 82.1% | `src/loop`（5437 行） | graph runtime 主体，很扎实 |
| 78.4% | `src/kernel`（2250 行） | |
| 75.2% | `src/infra` | persist / 锁 |
| 69.3% | `src/core` | |
| 61.8% | `src/subagent` | |
| 57.0% | `src/robotics`（2539 行） | |
| **45.6%** | **`src/tools`（1586 行）** | ← 模型每一步都在用 |
| 38.0% | `src/validation` | V&V hook，README 的招牌特性之一 |

**按文件**，把「每个任务都必然执行」的路径单独拎出来：

| 覆盖率 | 文件 | 这是什么 |
| --- | --- | --- |
| **3.6%** | `tools/mcp/HttpMcpClient.ts` | 所有远程 MCP 调用 |
| **6%** | `kernel/api/DeepSeekClient.ts` | OpenAI 协议 wire adapter（DeepSeek/Qwen） |
| **8.8%** | `tools/fs/notebook_edit/index.ts` | |
| **9.5%** | `tools/fs/read_file/index.ts` | **模型用得最多的工具** |
| **12.5%** | `tools/fs/write_file/index.ts` | |
| **12.5%** | `tools/fs/append_file/index.ts` | |
| **14.3%** | `tools/shell/powershell/index.ts` | Windows 唯一 shell 路径 |
| **14.6%** | `kernel/api/AnthropicClient.ts` | **Anthropic 协议 wire adapter — 默认 provider Zhipu/GLM 走的就是它** |
| **14.4%** | `loop/daemon.ts` | 长周期 loop 的调度进程 |
| **10.8%** | `robotics/team/TeamWatcher.ts` | |
| **14.0%** | `robotics/ExperienceWorkingSet.ts` | 「每轮挑 ≤4 条相关经验注入」——README 的核心机制 |
| **0%** | `core/memory/memoryProposal.ts` | 跨会话记忆的提案生成 |
| 32.2% | `infra/git/GitWorkspaceManager.ts` | isolated_write 子代理的分支隔离 |
| 46.3% | `tools/network/web_fetch/index.ts` | SSRF 防护逻辑本身只覆盖一半 |
| 53.9% | `tools/mcp/mcpConfigFile.ts` | ← P1-A 就在这里 |

对照：`sandbox/`（上一轮 P1 重灾区）87.2%，`kernel/loop/KernelLoop.ts` 85%，`loop/graph/` 80%+。

**这说明什么**

测试是跟着**审查**走的，不是跟着**风险**走的。被写进审查报告的模块拿到了回归用例，没被点名的模块——恰好是最外层、最脏、最依赖外部协议的那一层——没有。本轮 5 个缺陷里，P1-A（53.9%）、P2-B（6%）、P3-A/B（57.1%）三处都落在低覆盖文件里。

而且这些文件的共同点是**难测**：wire protocol 适配器要构造 chunk 序列、MCP 客户端要 mock HTTP、文件工具要 mock fs。难测 → 没测 → bug 藏在里面 → 表现为「provider 有时候抽风」「MCP 时好时坏」这类最难归因的现象。

**建议**（按投入产出排序）

1. **给两个 wire adapter 建测试缝**。`processStreamInner`（DeepSeek）和 AnthropicClient 的对应函数导出为纯 generator，用表驱动的 chunk 序列测：正常、tool_call id/name 延迟到达、name 分片、usage chunk 缺失、`finish_reason` 提前、空 choices 保活帧。这一项同时直接修掉 P2-B，是 ROI 最高的。
2. **文件工具补一层行为测试**。`read_file` / `write_file` / `append_file` / `edit_file` 在真实 tmpdir 上跑：workspace 越界、符号链接逃逸、`replace_all` 计数、并发写 mutex、超大文件截断。这些工具的**边界检查**已经很扎实（`workspaceGuard` 是单一真相源，写得很好），但「检查对了之后实际干了什么」没测。
3. **`HttpMcpClient` 用本地 http server 打一遍**。SSE 帧解析、`Mcp-Session-Id` 回显、超时、body 超限取消——这四条都是有明确失败模式的逻辑，现在一条没测。
4. `loop/daemon.ts` 的锁竞争（两个 daemon 抢同一 workspace、锁文件损坏、跨主机 stale 判定）值得几个用例——这段逻辑写得很小心，正因为小心才值得钉死。

---

## P4-B · 有 eslint 指令，没有 eslint

`src/` 里有 7 处 `// eslint-disable-next-line`（`web_fetch/index.ts:277`、`DeepSeekClient.ts:260`、`KernelLoop.ts:455` 等），但仓库里没有任何 eslint 配置，`package.json` 也没有 lint script。这些指令目前是纯注释。

不是必须装 eslint——`tsc --strict` + 这个代码库的注释纪律已经挡掉了大部分东西。但**现状是最差的一种**：读代码的人会以为有 lint 在跑。要么补上配置，要么把这些死指令删掉。

---

## P4-C · `.gitignore` 里的 `src/core/auto_orch/` 是个陷阱

```
.gitignore:40:src/core/auto_orch/
```

`git check-ignore -v src/core/auto_orch/foo.ts` 确认命中。这是 v1 auto_orch 引擎退役时留下的清扫规则，当时是对的。但它现在的效果是：**任何人以后在这个路径下新建文件，`git status` 都不会提示，`git add .` 也加不进去**。

`vitest.config.ts` 里对应的排除注释已经写了「stub 文件真的删掉了，没什么可跳过的了」——`.gitignore` 这条应该一起删。

---

## P4-D · 工作区里 5 个 tarball（约 12 MB）

`meta-agent-runtime-0.8.5/6/7/10/11.tgz` 都在仓库根目录。`.gitignore` 里有 `*.tgz`，所以没入库，但它们占着工作目录、会被 `glob`/`grep` 工具扫到、也会被 agent 自己的文件列举看到。建议 `npm pack` 输出到 `build/` 或直接清掉旧版本。

---

# 上一轮遗留项状态

| 编号 | 状态 |
| --- | --- |
| P1-1 沙箱只挡写不挡读 / 默认无 `readDenyPaths` | **仍然存在，且是显式接受的**。`DEFAULT_MAIN_SANDBOX = { allowUnsandboxedFallback: true }`（`bash/index.ts:98`）依旧没有 `readDenyPaths`。`sandbox/__tests__/` 里的 DOCUMENTED GAP 用例在，缺口是可见的。不重复计。 |
| P1-2 `tools.bash.sensitive` 被静默忽略 | **已修**。`PermissionPolicy.ts:466+` 现在用显式的 shell 特判 + 注释说明为什么 shell 的 `sensitive` 语义是「命中 pattern 才问」。 |
| 其余 #3–#13 | 抽查 `withFileLock` 心跳、`atomicWriteJson` 的 tmp 清理、`readJsonFile` 带时间戳的 quarantine、`childProcessEnv` 统一凭据策略、`workspaceGuard` 单一真相源——**均已落地且有对应回归用例**。 |

`childProcessEnv.ts` 这一条特别值得点名：把 bash 工具里的 env 过滤提升为「所有子进程的唯一凭据策略」，并在注释里写清楚 `StdioMcpClient` 曾经把完整 `process.env` 交给第三方二进制——这是本轮读到的最好的一处修复。

---

# 附录：复现脚本

## A. P1-A（MCP 凭据插值）

```js
function resolveVar(n) { return process.env[n] || '' }
function interpolateEnv(value) {
  const result = value.replace(/\$\{([^}]+)\}/g, (_m, v) => resolveVar(v))
  return (value.includes('${') && !result.trim()) ? undefined : result
}
function interpolateRecord(rec) {
  const out = {}
  for (const [k, v] of Object.entries(rec)) {
    const r = interpolateEnv(v); if (r === undefined) return undefined; out[k] = r
  }
  return out
}
delete process.env.MISSING_TOKEN
console.log(interpolateRecord({ Authorization: '${MISSING_TOKEN}' }))         // undefined ✓
console.log(interpolateRecord({ Authorization: 'Bearer ${MISSING_TOKEN}' })) // {Authorization:'Bearer '} ✗
```

## B. P2-A（调度器跨批阻塞）

```ts
const store = new AutoContinuationStore(mkdtempSync(join(tmpdir(), 'sched-')))
await store.schedule({ sessionId: 'SLOW', fireAt: Date.now() - 1000, reason: 'slow', historyMessageCount: 0 })
const sched = new AutoScheduler(store, async rec => {
  log.push(`start ${rec.sessionId}@${Date.now() - t1}ms`)
  await sleep(rec.sessionId === 'SLOW' ? 2000 : 10)
  log.push(`end   ${rec.sessionId}@${Date.now() - t1}ms`)
  return 'done'
}, { pollIntervalMs: 50, maxConcurrent: 4, idleExitMs: 300 })
setTimeout(() => void store.schedule({ sessionId: 'URGENT', fireAt: Date.now(), ... }), 300)
await sched.run(ac.signal)
// start SLOW@7ms / end SLOW@2010ms / start URGENT@2081ms  ← 3 个空闲槽位，等了 1.78s
```

## C. P2-B（tool_calls 流解析）

见正文表格；把 `processStreamInner` 的 tool_calls 分支逐行转写后，用三种合法 chunk 形状驱动即可，无需网络。

## D. P3-B（fallback grep 卡死事件循环）

```js
const re = new RegExp('(a+)+$')
const t0 = Date.now()
setTimeout(() => console.log('timer', Date.now() - t0), 100)   // 永远不会在 test() 期间打印
re.test('a'.repeat(40) + '!')
console.log('blocked', Date.now() - t0, 'ms')                  // 实测 86909 ms
```

---

# 优先级建议

| 顺序 | 项目 | 理由 |
| --- | --- | --- |
| 1 | **P1-A** MCP 凭据插值 | 两行改动，消除一整类「MCP 时好时坏」的排障；官方示例就是受影响的形状 |
| 2 | **P2-B + P4-A.1** 导出 `processStreamInner` 并表驱动测试 | 一次投入同时修掉缺陷和 6% 覆盖率的根因 |
| 3 | **P2-A** 调度器并发语义 | 语义与 flag 名不符；照抄 `daemon.ts` 即可，注意 `--once` 的收尾 |
| 4 | **P3-B** grep fallback 卡死 | 会拖垮跨进程锁，但触发需要模型给出病态正则，概率低 |
| 5 | **P3-A / P3-C / P3-D** | 各自几行 |
| 6 | **P4-A.2/3** 文件工具 + HttpMcpClient 测试 | 结构性还债，可以分批 |
| 7 | **P4-B / C / D** | 清扫 |

---

# 修复记录

## 一、原报告列出的问题

| 编号 | 状态 | 落地方式 |
| --- | --- | --- |
| **P1-1** 沙箱只挡写不挡读 | **按上轮决定不修** | `DEFAULT_MAIN_SANDBOX` 保持原样；`sandbox/__tests__/` 里的 DOCUMENTED GAP 用例继续让缺口在测试套件里可见 |
| **P1-A** MCP 凭据插值 | ✅ 已修 | 逐占位符判定缺失；warning 现在指名变量与字段 |
| **P2-A** 调度器并发语义 | ✅ 已修 | `dispatchDue()` 不再阻塞；`tickOnce()` 保留「跑完再退」给 `--once` |
| **P2-B** tool_calls 流解析 | ✅ 已修 | 按 index 累积 id/name；导出 `processStreamInner` 作为测试缝 |
| **P3-A** grep multiline 语义 | ✅ 已修 | JS fallback `'m'` → `'s'`（dotAll），与 rg 对齐 |
| **P3-B** grep fallback ReDoS | ✅ 已修 | 嵌套量词拒绝 + 单文件 2MB 上限 |
| **P3-C** expired 记录的 prune 时钟 | ✅ 已修 | 按 `fireAt` 计龄，不再被 `expireStale` 重置 |
| **P3-D** Registry.toString 排序 | ✅ 已修 | 补上显式比较器 |
| **P4-A** 覆盖率倒挂 | ✅ 已修 | 四层全补，见下 |
| **P4-B** 死 eslint 指令 | ✅ 已清 | 3 处（非 campaign）改成解释「为什么需要这个 cast」的真实注释 |
| **P4-C** `.gitignore` 的 auto_orch 陷阱 | ✅ 已删 | 留注释说明为什么不能再加回来 |
| **P4-D** 根目录 5 个 tarball | ⏸ 未动 | 属于你的发布产物，不擅自删除；建议 `npm pack --pack-destination build/` |

## 二、修复过程中新发现的 5 个缺陷

写测试的价值不在于覆盖率数字，而在于这一节。

### N-1 · `notebook_edit` 校验的路径和写入的路径不是同一个文件（同 P1 级）

`src/tools/fs/notebook_edit/index.ts`

它用 `assertInsideWorkspace(p, …)` 校验，然后 `stat/readFile/writeFile` 直接吃**原始** `p`。
Node 把相对路径解析到 `process.cwd()`，所以只要 `cwd !== workspaceRoot`（`-w <dir>` 运行的常态），
**校验的文件和写入的文件就是两个不同的文件**。

`workspaceGuard` 的文档里写得清清楚楚，这正是 `resolveInsideWorkspace` 被造出来的原因，其他每个 fs 工具都已经迁过去了 ——
只有这个漏了。顺带 `writeMutex.acquire(p)` 也用的原始路径，于是 `nb.ipynb` 和 `./nb.ipynb` 会拿到两把不同的锁。

已改用 `resolveInsideWorkspace`，全流程走 canonical path。

### N-2 · `notebook_edit` 替换代码单元后保留旧输出

同文件。原来是 `cell.outputs = cell.outputs ?? []` —— **保留**旧源码的输出，同时把 `execution_count` 设成 `null`。
于是单元格一边声称「从未执行」，一边展示着执行结果，而且那结果属于已经被替换掉的代码。
下一次 `read_file` 读这个 notebook 的是 agent 自己，它会看到对不上的代码和输出。

已改为清空 outputs；切成 markdown 时按 nbformat 要求删掉 `outputs` / `execution_count`（原来会留下，产出不合法的 notebook）。

顺带修了 `insert` 模式不校验索引的问题：`splice(-1, 0, x)` 会静默插到倒数第二位，`splice(99, 0, x)` 会静默追加到末尾。

### N-3 · grep 把 ripgrep 的错误重新抛出，导致整个工具调用崩溃

`src/tools/fs/grep/index.ts`。catch 只处理 `status === 1`（无匹配），其余 `throw err`。
rg 对**非法正则**退出码是 2 —— 模型写错一个正则，得到的不是一条可读的错误、而是一次工具调用异常。
已改为返回 `isError: true` 并带上 rg 的 stderr。

### N-4 · `loop-scheduler --idle-exit-ms 0` 的语义和 `auto-scheduler` 相反

`src/loop/daemon.ts`。`now() - idleSince >= 0` 在第一个空闲 tick 就成立，所以 `0` 的实际效果是**立刻退出**。
而 `auto-scheduler` 的同名 flag 和 `cli/args.ts` 的帮助文本都写着 `0 = stay up`。
同一个 flag 名在两个子命令下行为相反，其中一个还和自己的帮助文本矛盾。

已统一为 `0 = 关闭 idle 退出`，并给 LOOP RUNTIME 段补上帮助文本。

### N-5 · memory 扫描缓存的失效判据在真实文件系统上不成立

`src/core/memory/findRelevantMemories.ts`。缓存键是目录的 `mtimeMs` —— 毫秒精度。
实测这台 ext4：**连续 5 次创建文件，只产生 2 个不同的 mtime**。

后果：同一毫秒内写入的第二个 memory 文件，在整个 30s TTL 内**完全不可见** ——
一轮对话结尾写下的经验，下一轮召回时不存在。

它同时是一个 flaky 测试的根因：`memoryPrefetch.test.ts` 的失效用例只在机器足够快时失败
（我是在开启覆盖率插桩、跑得更快的那次跑出来的）。**一个真实 bug 长得像测试噪声**，是最糟的一种信号。

先试了纳秒 mtime（`stat({ bigint: true }).mtimeNs`）—— 不行，文件系统根本不携带这个精度。
最终改为：**目录 `.md` 条目清单**（确定性地捕获增删改名）+ mtime（原地覆写）+ 30s TTL（外部手改）三层。
多出来的一次 `readdir` 比它保护的「读+解析每个文件」便宜几个数量级。

已做变异验证：去掉 listing 判据，新用例立刻变红。

## 三、覆盖率倒挂：修复前后

| 文件 | 修复前 | 修复后 |
| --- | --- | --- |
| `tools/mcp/HttpMcpClient.ts` | 3.6% | **97.6%** |
| `kernel/api/DeepSeekClient.ts` | 6% | **89.2%** |
| `tools/fs/notebook_edit/index.ts` | 8.8% | **97.6%** |
| `tools/fs/read_file/index.ts` | 9.5% | **85.7%** |
| `tools/fs/write_file/index.ts` | 12.5% | **100%** |
| `tools/fs/append_file/index.ts` | 12.5% | **93.8%** |
| `loop/daemon.ts` | 14.4% | **84.8%** |
| `kernel/api/AnthropicClient.ts` | 14.6% | **91.0%** |
| `tools/registry/EngineeringToolRegistry.ts` | 5.6% | **83.3%** |
| `tools/mcp/mcpConfigFile.ts` | 53.9% | **83.1%** |
| `tools/fs/grep/index.ts` | 57.1% | **91.2%** |
| `tools/fs/edit_file/index.ts` | 90.7% | **93.0%** |

| 目录 | 修复前 | 修复后 |
| --- | --- | --- |
| `src/tools` | 45.6% | **65.0%** (+19.3) |
| `src/kernel` | 78.4% | **88.1%** (+9.7) |
| `src/loop` | 82.1% | **83.5%** (+1.4) |
| **整体（行）** | 67.88% | **71.00%** |
| **整体（分支）** | 56.74% | **59.52%** |

倒挂消除了：现在「每个任务都必走的路径」全部在 84%–100% 区间，不再低于被反复审查的核心。

### 新增测试文件

| 文件 | 用例 | 覆盖什么 |
| --- | --- | --- |
| `kernel/api/__tests__/DeepSeekStream.test.ts` | 23 | 表驱动 chunk 序列：tool_call id/name 延迟到达、name 分片、args 先于 name、并行调用、usage 归一化、事件顺序 |
| `kernel/api/__tests__/DeepSeekRetry.test.ts` | 15 | 请求构造、no-replay、重试分类、abort 监听器不泄漏 |
| `kernel/api/__tests__/AnthropicStream.test.ts` | 20 | 同上（默认 provider GLM 走这条路） |
| `tools/fs/__tests__/fsTools.test.ts` | 41 | read/write/append/edit：符号链接逃逸、`<workspace>-backup` 兄弟目录、`$&`/`$1` 字面插入、TOCTOU、写锁、相对路径解析 |
| `tools/fs/__tests__/notebookAndGrep.test.ts` | 38 | notebook 单元操作 + grep 双路径（含强制 fallback） |
| `tools/mcp/__tests__/HttpMcpClient.test.ts` | 21 | 真实本地 http server：SSE 帧、session-id 回显、单飞握手、404 重握手、body 超限 |
| `tools/mcp/__tests__/mcpConfigFile.test.ts` | 23 | 插值全路径 + 加载器 |
| `tools/registry/__tests__/EngineeringToolRegistry.test.ts` | 18 | 注册/查找/排序 |
| `loop/__tests__/daemonLock.test.ts` | 24 | 锁竞争：损坏锁、跨主机 stale、token 校验、并发抢锁、idle/aborted 退出 |
| `core/auto/__tests__/AutoSchedulerConcurrency.test.ts` | 6 | 并发上限、跨批响应性、abort 排空、rejection 不逃逸 |
| `core/memory/__tests__/memoryPrefetch.test.ts`（增补） | +1 | 同毫秒写入的缓存失效 |

### 变异验证

不是「能编译」，是「把实现改回去，新测试确实变红」：

| 改回去的实现 | 结果 |
| --- | --- |
| `run()` 用 `tickOnce`（每批 drain） | 「新到期 wake 立刻起跑」变红 ✅ |
| tool_calls 快照一次 id/name | 5 个用例变红 ✅ |
| 缓存去掉 listing 判据 | 同毫秒失效用例变红 ✅ |

## 四、新增的一个环境变量

`META_AGENT_DISABLE_RIPGREP=1` —— 强制 grep 走 Node fallback。
已登记进 `ENV_REGISTRY`。两个真实用途：在没装 rg 的机器上复现结果；以及让 fallback 可测 ——
在任何装了 ripgrep 的开发机/CI 上它都是不可达代码，这正是它当初能藏住一个会冻住进程 87 秒的同步正则的原因。
