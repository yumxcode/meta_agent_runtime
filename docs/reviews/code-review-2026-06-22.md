# meta-agent 代码审查报告

日期：2026-06-22 · 版本：0.3.3 · 审查范围：`src/`(~57.5K LOC TypeScript)
测试基线：`vitest run` → 111 文件 / 837 用例全部通过；`grep` 全仓无硬编码密钥；非测试代码仅 1 处 TODO。

## 总体评价

代码质量很高，属于"经历过多轮系统性加固"的成熟工程。注释中保留了 H1–H5 / L2–L7 / M1–M9 / P1–P2 等修复标签,关键安全/并发路径都有单一事实源(`workspaceGuard`、`Context` 阈值、`PathWriteMutex`),边界条件防御扎实(空 `old_string`、UTF-8 跨块解码、进程组 kill、TOCTOU mtime 校验、DNS pin)。下面的发现以"残余风险/改进点"为主,**没有发现会导致功能错误的高危缺陷**。按严重度排序。

---

## 安全性(本轮重点)

### S1 [中] OS 沙箱只是"写监狱",默认放开全盘读 + 全网络
`src/sandbox/profiles/macos.ts` 以 `(allow default)` 起步,只 `(deny file-write*)` 后再放行工作区;`bwrap.ts` 用 `--ro-bind / /` 把整盘只读挂载。两者默认 **不限制读**、**不限制网络**(仅 `network:'none'` 时才断网,而默认 `DEFAULT_MAIN_SANDBOX = { allowUnsandboxedFallback: true }` 未设此项)。

后果:被托管的模型可以 `cat ~/.aws/credentials`、`~/.ssh/id_rsa`,再用 `curl` 外发。`bash` 工具已经很用心地过滤了环境变量里的密钥(`SENSITIVE_ENV_PATTERN` + 黑名单),但**磁盘上的密钥 + 出网这条更大的外泄通道仍然敞开**,与"过滤 env 密钥"所表达的防外泄意图不一致。

建议:为默认 profile 增加一组 `readDenyPaths`(`~/.ssh`、`~/.aws`、`~/.config/gcloud`、`~/.netrc` 等),并在文档里明确"沙箱是写隔离,不是读/网隔离";对无人值守 auto 模式考虑默认 `network` 收紧或显式提示。

### S2 [中] 无沙箱后端的主机上,bash 工作区监狱退化为可绕过的正则
非 auto 模式默认 `allowUnsandboxedFallback: true`(`bash/index.ts:118`)。当主机没有 bwrap/sandbox-exec 时,`createSandboxExecutor()` 返回 Noop,bash 直接裸跑,此时工作区边界**只剩** `PermissionPolicy` 里的正则启发式(`findWorkspaceViolation` / `findBashRelativeEscape`)。这些检查注释里已自认"best-effort, NOT a proof of containment",确实可被变量间接绕过,例如:

```
H=/home/user; cat $H/.ssh/id_rsa      # 不含字面 ~ 或 $HOME,逃逸
```

建议:无沙箱后端时在启动期**显著告警一次**(目前 Linux 嵌套场景有 stderr 警告,但"完全没有后端"的降级是静默的);并考虑让敏感 `execute` 在无沙箱时回到"需确认"而非静默放行。

### S3 [低] 绝对路径扫描只认白名单根目录,自定义挂载点被漏过
`looksLikeFilesystemPath`(`PermissionPolicy.ts:138`)仅当路径**首段 ∈ `KNOWN_OS_ROOT_DIRS`** 才判定为文件系统路径并送去做工作区校验。`/data1`、`/scratch`、`/nfs`、`/mnt2` 这类自定义根的绝对路径**根本不会被标记**,于是 `findWorkspaceViolation` 直接放行(在无沙箱主机上即为越界读写)。

建议:反转判定方向——凡是"看起来像绝对路径且不在工作区、也不在只读系统前缀白名单"的,一律标记;而不是只对已知根目录设防。

### S4 [低] web_fetch 没有自身的连接/空闲超时
`requestPinned`(`web_fetch/index.ts`)只挂了 `ctx.abortSignal`,没有 socket/idle 超时。慢速服务器(slowloris)可把连接挂到子代理的 `maxDurationMs`(默认 5 分钟)才被抢断,期间占用连接与带宽。

建议:给请求加 `req.setTimeout(...)` 与空闲超时,独立于上层 abort。

### S5 [低] 调试快照明文留存且无清理
`_writeDebugFile`(`MetaAgentSession.ts:569`)把每轮 req/res 负载明文写入 `~/.meta-agent/debug/<sessionId>/`,无 TTL、无上限。会话内容(可能含敏感业务数据)长期堆积在家目录。

建议:加保留上限/TTL,与 `cleanupTerminalTasks` 同样的清理纪律。

### 安全做得好的地方(应保持)
SSRF 防御是教科书级:`validateUrl` 解析 **所有** A 记录、逐跳重定向重新校验、DNS pin 关闭二次解析(防 rebinding)、IPv4-mapped IPv6 回查、显式拒 `localhost`。auto 模式 `lockWorkspace` 强制 `allowOutsideWorkspace=false` 且覆盖 permissions.json,沙箱 fail-closed。路径校验三处调用统一走 `workspaceGuard`,杜绝漂移。

---

## 功能正确性

### F1 [低] 小上下文窗口模型下 compact 阈值可能恒为真
`calculateTokenWarningState`(`utils/Context.ts:49`):`effectiveContextWindow = contextWindow - Math.min(maxOutputTokens, 20_000)`。若某模型窗口 ≤ 该减数,`effectiveContextWindow ≤ 0`,阈值变负,`isAtCompactThreshold` 恒真,理论上每轮都触发 compact/截断。实际使用的都是大窗口模型(GLM 1M 等),不会触发,但属隐患。

建议:对 `effectiveContextWindow` 设下限(如 `Math.max(4096, …)`)。

其余核心逻辑正确性良好:`edit_file` 用 split/join 而非 `String.replace`(正确规避 `$&`/`$1` 被解释)、occurrences 计数与 replace_all 分支无 off-by-one;`AutoCompact` 的递归保护/熔断/结构化降级路径自洽;`PathWriteMutex` 的链尾清理判定(`chains.get(key) === tail`)正确,不会过早删除。

---

## 错误处理与健壮性

### R1 [低] 子代理沙箱初始化在 try 之外,fail-closed 被记成"Unhandled error"
`SubAgentRunner._run`(`SubAgentRunner.ts:253-268`)的沙箱创建(含第 259 行 fail-closed `throw` 与 264 行 `executor.create`)发生在 **外层 try(275 行)之前**。虽然 `start()` 的 `.catch`(190 行)兜底写了 terminal `failed`(任务不会卡死),但它通过 `console.error('Unhandled error in _run() catch handler')` 打印——测试输出里就刷了多条这样的"Unhandled error",而这其实是**设计内的预期降级**(嵌套 bwrap fail-closed)。

建议:把沙箱初始化移进外层 try;把"沙箱后端不可用/嵌套"归类为正常 terminal-failed,用 warn 而非"Unhandled error"日志,避免误导排障。

健壮性优点:bash 超时走进程组 `kill(-pid)` 防孤儿;写锁 try/finally 释放;`atomicWriteJson` + 每 taskId 写链串行化;子代理墙钟/轮数/预算三重断路器在代码层而非提示词层执行。

---

## 性能与资源

### P1 [低] 子任务存储是扁平全局目录,列举为 O(全部历史任务)
`listTasksForSession` / `cleanupTerminalTasks`(`SubAgentTaskStore.ts`)每次都 `readdir` 全局 `subtasks/` 并逐个读 JSON,跨所有会话。状态轮询频繁时是反复全目录读。已有 `cleanupTerminalTasks` 缓解,但仍建议按 `parentSessionId` 分子目录,或维护索引文件,避免长生命周期主机上退化。

`web_fetch` 的 50 条进程级缓存、O(n) 驱逐在 n=50 下可忽略。

---

## 可维护性与可读性

整体优秀:57.5K LOC 仅 1 处 TODO;魔法值基本提取为命名常量;关键不变量集中在单一函数。两点小建议:`KernelLoop.ts`(1463 行)、`CompactPrompt.ts`(856 行)偏大,可按职责拆分;用户可见字符串中英混排(权限重定向是中文、错误多为英文),建议统一策略。

---

## 测试

覆盖面强:837 用例覆盖 SSRF、jail 透传、fail-closed、TOCTOU、写锁等失败路径,全绿且无 flaky 迹象。建议补三处:
- 自定义根目录绝对路径越界(对应 S3);
- 小上下文窗口的 compact 边界(对应 F1);
- 显式断言"沙箱不可用 → 干净 terminal-failed 且不打 Unhandled error 日志"(对应 R1)。

---

## 接口/兼容性 与 规范一致性

提供商按文档优先级自动探测、可显式覆盖,凭据用 `...(x !== undefined && {x})` 方式转发(env 探测不被破坏),向后兼容良好;`infra/persist/schemas.ts` 保留 v1.0 legacy schema 说明,有版本意识。日志统一走 stderr 带 `[meta-agent/...]` 前缀,符合约定。

---

## 优先级建议(按性价比)

1. **S1 / S2**:补默认 `readDenyPaths` + 无沙箱后端的显著告警——这是当前最值得做的安全收口。
2. **S3 / R1**:绝对路径判定反转 + 沙箱初始化移入 try 并修正日志分级——小改动、明确收益。
3. **F1 / S4 / P1 / S5**:边界与资源治理,可排进后续迭代。
