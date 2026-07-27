# Meta-Agent Runtime 健壮性与稳定性代码审查

- 日期：2026-06-11
- 版本：`@meta-agent/runtime` 0.2.10
- 范围：全代码库（约 4.7 万行非测试 TS），重点为核心运行时路径、持久化/并发、子代理与作业生命周期、工具层与安全边界
- 方法：逐文件精读核心模块（kernel、stores、subagent、tools、sandbox、permissions、CLI 关停路径），其余模块按危险模式（裸 JSON.parse、定时器、进程信号、无界增长）做定向扫描；所有结论均经过二次读码确认

> **修复状态（2026-06-11）**：以下全部条目（H-1~H-2、M-1~M-6、L-1~L-8）均已修复并验证
> —— typecheck 通过，533 项单元测试全部通过（含为 H-2 新增的 cronStore 回归测试）。
> 例外：L-8 的 `.fuse_hidden*` 文件被宿主进程占用暂无法删除（已加入 .gitignore，
> 持有进程退出后可手动清理）。各修复处代码注释带有 `H?-fix` / `M?-fix` / `L?-fix` 标记。

## 总体评价

代码质量明显高于平均水平。原子写（write-then-rename）、LRU 上限、熔断器、abort 信号贯穿、dispose 链、SSRF DNS 钉扎（pinned lookup）、流错误恢复等防御措施系统性落地，且注释中保留了历次修复编号（P0/P1/S/H/M/L），可见已经过多轮加固。本次审查仍发现 2 个高危、6 个中危问题，集中在「跨进程并发」和「少数未走统一持久化助手的路径」上。

---

## 高危（建议立即修复）

### H-1 `SessionStore.loadHistory`：单行损坏导致整个会话历史丢失

`src/core/SessionStore.ts:305-332`

```ts
const parsed = raw.split('\n').filter(Boolean)
  .map(line => JSON.parse(line) as ConversationMessage)  // ← 无逐行容错
return buildResumedHistory(parsed)
} catch { return [] }                                     // ← 整体吞掉
```

history.jsonl 采用 `appendFile` 追加（`append()`，第 275 行）。批量消息一次写入可能超过 PIPE_BUF，进程在写入中途崩溃 / 磁盘满会留下半行 JSON。恢复时任意一行 `JSON.parse` 抛错都会被外层 catch 捕获并返回 `[]`——一行坏数据令全部历史静默蒸发，且与 `persist/readJsonFile` 的 `.corrupt` 隔离策略不一致。

修复建议：逐行 try/catch，跳过坏行并 `console.warn` 计数；可选地把坏行写入 `history.jsonl.corrupt` 以便排查。这是一处几行的改动，收益极大。

### H-2 `cronStore.nextIntervalMs`：固定时刻的 cron 表达式被解释为「每分钟」

`src/tools/system/cronStore.ts:39-70`

注释声称 `0 0 0 * * *`（每日一次）映射为 86 400 000 ms，但实际代码：

```ts
if (sec && sec !== '*' && !sec.startsWith('*/')) {
  return 60_000   // ← "0 0 0 * * *" 的 sec='0' 走到这里
}
```

任何秒位为固定值的表达式（即所有"每天 X 点"、"每小时整点"类任务）都会变成每 60 秒触发一次——每日任务实际执行 1440 次/天。对接外部副作用（通知、写盘、API 调用）时后果严重。

另外：回调为 async 且无重入保护，执行时间超过间隔时会并发堆叠。

修复建议：要么接入一个轻量 cron 解析库（croner 等），要么明确拒绝不支持的表达式形态（抛错），不要静默降级为每分钟；为回调加 `running` 标志防重入。

---

## 中危

### M-1 `withFileLock`：陈旧锁回收存在双重获取竞态

`src/core/persist/index.ts:152-195`

回收路径为 stat → 比较 mtime → `unlink` → 重试 `open('wx')`。两个进程可同时判定锁陈旧：A unlink 后立即创建新锁，B 随后 unlink 的可能是 A 刚创建的合法锁，于是 A、B 同时进入临界区——这正是该锁要防止的 TeamStore 丢更新场景。

修复建议：回收时不直接 unlink，而是把陈旧锁 `rename` 到随机名（rename 原子性保证只有一个进程成功），成功者再创建新锁；或在锁文件内写入持有者 id，unlink 前校验。

### M-2 `SessionStore` index.json：跨进程读-改-写丢更新

`src/core/SessionStore.ts:415-429`

`_upsertIndex` 是无锁的 read → merge → `atomicWriteJson`。两个并行 CLI 会话（同一机器很常见）在每个 turn 末尾都会重写 index，彼此覆盖对方的 upsert——会话从 picker 中消失。原子写只防"损坏"，不防"丢更新"。代码库里已经有现成的 `withFileLock`，包一层即可。

### M-3 `HttpMcpClient`：fetch 无超时、响应体无大小上限

`src/tools/mcp/HttpMcpClient.ts:100-177`

所有 `fetch` 均未传 `AbortSignal`，也未限制 `res.text()` 体积。挂死的 MCP 服务器会让工具调用一直阻塞到内核 3 分钟兜底超时（且超时仅放弃等待，底层连接继续占用）；恶意/异常服务器可返回任意大的响应体直接打爆内存。`mcp_call` 工具上下文里有 `ctx.abortSignal`，建议贯穿传入，并对响应体做流式上限（如 10 MB）。

### M-4 bash 工具：超时只杀直接子进程，孙进程成为孤儿

`src/tools/shell/bash/index.ts:193-196`

`execFile('bash', ['-c', cmd], { timeout })` 超时只对 bash 本体发 SIGTERM；`bash -c` 启动的管道/后台子进程不在同一进程组被杀（未用 `detached: true` + 负 pid kill）。被模型反复触发长命令超时后，机器上会累积孤儿进程（典型如 `npm install`、训练脚本）。bwrap 沙箱路径因 `--unshare-pid` 略好，noop/macOS 路径完全暴露。

修复建议：`spawn` + `detached: true`，超时/abort 时 `process.kill(-pid, 'SIGKILL')`。

### M-5 `SubAgentBridge.spawnSubAgent`：父信号已处于 aborted 时被忽略

`src/subagent/SubAgentBridge.ts:373-380`

```ts
if (opts.abortSignal) {
  opts.abortSignal.addEventListener('abort', forwardAbort, { once: true })
```

对已 aborted 的信号，`addEventListener` 永远不会触发（规范行为），缺少 `if (opts.abortSignal.aborted) abortController.abort()` 前置检查。用户中断当轮后，竞态窗口内提交的 spawn 仍会照常排队并运行。SubAgentRunner 的构造函数（170 行附近）处理了这一情形，Bridge 这层漏了。

### M-6 `CampaignStateStore`：互斥仅限进程内；eval 缓存不感知文件截断

`src/coordination/CampaignStateStore.ts`

`_withLock` 是进程内 Promise 链，`completeTask`/`failTask` 的 reload→mutate→write 在多进程 worker 场景下仍会丢更新（注释也只承诺"same process"）。若未来 worker 以独立进程运行（部署形态变化时容易被忽略），需换 `withFileLock`。另外 `getEvaluations` 的增量 offset 缓存只处理 `size > offset`：evaluations.jsonl 被删除重建（目录清理、同 id 重建）后 offset 大于文件长度，将永远读不到新数据且无告警。建议 `size < offset` 时重置缓存。

---

## 低危 / 建议

- **L-1** `SubAgentRunner._writeTerminal`（543-569）：readTask 判终态 → writeTask 之间存在窗口，`cancelTask` 的 cancelled 写入可被 runner 的 completed 覆盖。写链只序列化"写"，不序列化"读-判-写"。建议把 read+decide+write 包进同一链节。
- **L-2** web_fetch（276-293）：响应超过 `MAX_CONTENT*2` 后停止缓存 chunk 但不 `res.destroy()`，恶意服务器可拖住带宽/连接直到工具超时。读够即销毁流。
- **L-3** `SubAgentRunner._run`（247-340）：`sandboxHandle` 在外层 try 之前创建，create 成功后若 `_resolveToolsWithSandbox` 等中间步骤抛错（概率低），handle 不会被 destroy。把 create 移进 try 或用更早的 finally。
- **L-4** `CampaignMonitor` 的 `setInterval(async ...)`（121）与 cronStore 同样无 tick 重入保护；store 锁能兜底正确性，但慢 tick 会堆叠 I/O。
- **L-5** `JobManager._transition`（428-450）：非终态转移的持久化是 fire-and-forget（带重试），进程在 running→completed 间崩溃依赖 `reattach` 标记 failed——逻辑闭环成立，但依赖调用方记得 reattach；`loadSession` 已覆盖，建议文档强调。
- **L-6** KernelLoop 反应式 compact 分支（836）用 `[...mutableMessages]` 复制赋给 `state.messages`，与其余路径"共享同一引用"的约定不一致；当前因 `continue` 后立即重建无实际影响，但属于易碎的隐式不变量，建议统一。
- **L-7** PermissionPolicy 的 bash 绝对路径扫描（152-169）是尽力而为的启发式：相对路径、`~`、变量展开均可绕过（真正边界由沙箱承担，符合设计），但反向误伤存在——`/usr/bin/python3 x.py` 这类合法用法会被拒。建议白名单放行常见只读系统路径或在拒绝消息中提示改用相对路径。
- **L-8** 仓库卫生：`src/` 下散落大量 `.fuse_hidden*` 文件（FUSE 删除残留），建议清理并加入 `.gitignore`；`esbuild` 作为构建工具应移入 devDependencies（当前在 dependencies，会被下游安装）。

---

## 值得肯定的设计（保持）

- `core/persist` 统一的原子写 + `.corrupt` 隔离 + 跨进程文件锁，绝大多数 store 都走该路径。
- web_fetch 的 SSRF 防御是教科书级：协议白名单、全地址族私网分类、IPv4-mapped IPv6 递归校验、重定向逐跳重验、DNS 钉扎（custom lookup）封死 rebinding 窗口。
- API 客户端：自有指数退避 + 抖动、`yieldedAny` 防重放、流错误注入对话恢复（KernelLoop step 12b）、PromptTooLong 反应式 compact、fallback 模型墓碑标记。
- 防失控三件套：同签名重复计数、ABAB 振荡守卫、预算/轮次/钱包上限。
- 资源生命周期：Bridge/Runner/Session 的 dispose 链完整，CLI 关停带 15s 硬退出保险丝，定时器普遍 `unref()`。

## 修复优先级建议

1. H-1（几行改动，防数据丢失）与 H-2（行为错误，影响所有定时任务）
2. M-2 / M-5（各 ~3 行，修跨进程丢会话与中断泄漏）
3. M-3 / M-4（网络与进程资源边界）
4. M-1 / M-6（并发正确性，随多进程化优先级上升）
