# meta-agent-runtime 架构评审 · 2026-08-18

基线 v0.8.19（`9b8fe04`）· 范围 `src/` 全量：414 个非测试文件 / 227 个测试文件 / 126,079 行
上一轮全量评审：[`CODE_REVIEW_2026-08-14.md`](CODE_REVIEW_2026-08-14.md)（v0.8.16 · 20 项已修复）

四个视角：**结构性架构问题 / 并发与状态一致性 / 安全与权限边界回归 / 演进与可维护性**。

> **状态：19 项发现中 16 项已修复（含全部 3 项 P1）。** 修复清单与验证见文末〈修复记录〉。
> 剩余 3 项（D2 超大文件拆分、D3 `cli/` 测试补齐、A2 执行循环统一抽象）是多日工作量，本轮只出方案不动刀。

---

## 总体判断

上一轮把「按工具名触发安全检查」换成了「按声明触发」，这个改动是对的，而且**保持住了**：`bash`、`powershell`、`cron_create` 三条路径今天仍然全部带 `commandField`，默认表里的兜底声明也还在（`PermissionPolicy.ts:94-96`）。

这一轮我关注的是另一类东西：**哪些不变量是靠约定维持的，而不是靠构造保证的**。这份代码库的注释质量很高——几乎每处非显然的写法都留了因果记录——但注释不是编译器。本轮 14 项发现里，超过一半的模式是同一个：*控制存在、当前正确、但它的正确性依赖于每个新增调用方自觉遵守一条没有任何机制检查的规则*。

三个具体的：`readJsonFile` 把「文件不存在」和「读不了」合并成同一个返回值（null），这个语义在 GraphStore 的事件溯源层上会放大成「整个 graph 实例假性损坏」；`journalPrunedThrough` 是进程内存计数器却承担持久化职责，导致 CLI 场景下 journal 目录**实际上永远不会被裁剪**；工作区 jail 的路径扫描只检查工具自己枚举的 `pathFields`，忘记枚举等于零检查、零告警——和 v0.8.16 那个「忘了改名字就豁免全部控制」是同一个形状。

好消息先说完：**文件级依赖图零环**（1805 条相对 import，Tarjan SCC = 0）。对一个 12 万行、26 个顶层模块的 TypeScript 项目，这不是自然发生的，说明分层是被认真维护的。这条不变量值得用 CI 锁住，见 §5。

---

## 一、架构层面的结构性问题

### A1 · `core` 反向依赖 `modes`，是分层里唯一的方向倒置 — P2

依赖图上 `core → modes` 只有一条边，但它很关键：

```
src/core/MetaAgentSession.ts:64
  import { AgenticSession } from '../modes/AgenticSession.js'
```

而 `modes → core` 有 17 条边。也就是说 `core`（最底层业务层）为了一个 facade 的接线，反向 import 了它的上层。目录级因此存在环：

```
campaign → coordination → core → modes → campaign
```

文件级没有环（`MetaAgentSession → AgenticSession → core/types` 不闭合），所以今天不会炸。但它意味着：

- `core` 无法作为独立单元被消费或测试——拉一个 `core/config` 就把 `modes` 整棵子树拖进来；
- `import` 顺序在 ESM 下开始有意义。一旦将来 `modes/AgenticSession.ts` 顶层出现对 `core` 某个常量的求值，就会拿到 TDZ 里的 `undefined`，而且症状是运行期偶发的 `undefined is not a function`，极难定位。

**建议**：`MetaAgentSession` 通过构造注入或工厂函数接收内层引擎（`config.innerSessionFactory`），把 `import` 反转成由 `modes/index.ts` 或 `routing` 装配。改动面小于 30 行。

### A2 · 五套并行的执行循环，边界只写在注释里 — P2

当前同时存在：

| 循环 | 位置 | 行数 | 状态载体 |
|---|---|---|---|
| `KernelLoop` | `kernel/loop/` | 1943 | 内存消息数组 |
| `GraphKernel` | `loop/graph/runtime/` | 628 | 事件溯源 + journal |
| `SubAgentRunner` | `subagent/` | 995 | 内存 + bridge 台账 |
| `AutoScheduler` / `AttachedAutoScheduler` | `core/auto/` | — | 文件锁 + claim 记录 |
| `CampaignMonitor` | `coordination/` | 528 | 静态方法 + 文件 |

外加 `SessionRouter`（800 行）在其上做模式分发。这些不是重复实现——它们的持久化模型和失败语义确实不同——但**没有任何共享的抽象把"什么是一次执行"表达出来**。结果是每个循环各自重新解决了取消传播、超时、预算、崩溃恢复，五份互不相同的答案。

具体成本已经能看到：`AutoContinuationStore`（claim + TTL + 目录锁）和 `GraphStore`（lease + fence token + journal）解决的是同一个「跨进程独占一个待办」问题，两套实现、两套测试、两套 bug 面。

**建议**：不要现在做大统一重构。做一件小事——写一份 `docs/architecture/execution-models.md`，把这五个循环的**持久化等级、取消语义、崩溃后行为**列成一张表。目前这些信息散在五个文件的头注释里，任何人要回答「auto 模式下杀掉进程会发生什么」都得读五处。

### A3 · 死代码与历史残留 — P3

- **`src/cc-kernel/`** — 全目录只有 `KernelBridge.ts`（14 行 re-export shim，标 `@deprecated`）。全仓库**零引用**（`src/index.ts` 也不导出它），但仍被 `tsc` 编译进 `dist/`。直接删。
- **`src/core/persist/`** — 两个纯 `export *` 转发文件（4 行 + 2 行），指向 `infra/persist`。但仓库里两个路径都在用：`coordination/CampaignStateStore.ts:30`、`robotics/PrincipleStore.ts:5` 走 `core/persist`，`loop/graph/runtime/GraphStore.ts:11` 走 `infra/persist`。同一个模块两个 import 路径，grep「谁在用文件锁」会漏一半。
- **`src/campaign/` 与 `src/campaigns/`** — 单复数两个目录，前者是引擎（1705 行），后者是插件注册（634 行）。命名上无法区分，`campaigns → campaign` 的 4 条边只能靠读代码判断方向。建议改名为 `campaign/` 与 `campaign-plugins/`。
- **`src/index.ts`** 仍导出 `KernelBridge` 别名（`@deprecated`）。0.x 版本，可以直接摘掉。

### A4 · 两个工具重名：`progress_note` — P2

```
src/tools/ui/progress_note/index.ts:24        name: 'progress_note'
src/robotics/tools/progress_note/index.ts:6   name: 'progress_note'
```

两份**不同实现**共用同一个模型可见名。`tools/ui/index.ts` 的 `createUiTools()` 和 `robotics/tools/index.ts:190` 的 robotics 工具集都会注册它。工具注册用 `Map<string, MetaAgentTool>`（`MetaAgentSession.ts:455`），后注册者静默覆盖前者——没有告警，没有测试断言这两者不会同框。

即使今天的注册路径恰好互斥，这也是一颗定时雷：任何一次「robotics 会话也需要 UI 工具」的合理需求都会让模型的 `progress_note` 调用悄悄换一个实现，而错误表现在别处。

**建议**：(a) robotics 那个改名为 `robotics_progress_note`；(b) 在工具注册处加一条断言——重名即抛，而不是覆盖。`web_search` 是同文件内的两处 `name:`（`tools/network/web_search/index.ts:186` 与 `:208`，一个是内部 schema），不是真重名。

---

## 二、正确性与并发/状态一致性

### B1 · `readJsonFile` 把「文件不存在」和「读不了」合并成 null，在事件溯源层放大成假性损坏 — **P1**

`infra/persist/index.ts:49-59`：

```ts
try {
  raw = await readFile(filePath, 'utf-8')
} catch {
  // ENOENT / unreadable — treat as "no record". Expected, stay silent.
  return null
}
```

`EACCES`、`EIO`、`EMFILE`、`ELOOP` 全部被当成「这条记录不存在」。这个语义在小型 store 上只是数据静默丢失的风险，在 `GraphStore` 上会变成硬故障：

```
GraphStore.reconcileLocked() (:748)
  usableCheckpoint = usable(readJsonFile(checkpointJson)) ?? usable(readJsonFile(checkpointPrevJson))
  → 两次读都瞬时失败（EMFILE）→ usableCheckpoint = null
  → journal = readJournalRangeLocked(1, lastSequence)
  → 但序号 1..N 已被 writeCheckpointLocked 裁剪删除
  → readJournalRangeLocked (:820) 抛 `graph journal sequence gap at 1`
```

**磁盘上数据完好，进程报告 journal 损坏。** 触发条件不是理论上的：`reconcileLocked` 每次事务都要顺序打开 checkpoint + 全部未 checkpoint 的 journal 文件 + 每个 running activation 的投影文件，`EMFILE` 在并发 subagent 场景下完全够得着。

同一个 `readJsonFile` 语义还有一处更隐蔽的：`readLastSequenceLocked` (:800) 读 `journalSequenceJson` 失败时静默回退到目录扫描，扫描结果可能低于真实值，随后 `atomicWriteJson` 把这个错误值**写回**计数器文件。

**修复**：`readJsonFile` 区分 `ENOENT`（返回 null）与其它错误（抛出），和 `withFileLock` 里对 `stat` 已经做的处理保持一致（`:266-272` 那段注释把理由写得很清楚，只是没有推广到读路径）。这是一个 5 行改动，但会改变约 40 个调用点的失败语义——需要逐个确认哪些真的想吞掉错误，建议加 `{ tolerateUnreadable?: boolean }` 让想吞的显式声明。

### B2 · `journalPrunedThrough` 是内存计数器，导致 CLI 场景下 journal 实际永不裁剪 — **P1**

`GraphStore.ts:110` + `:899-906`：

```ts
private journalPrunedThrough = 0            // ← 进程内存，从不从磁盘恢复

if (pruneThrough > this.journalPrunedThrough) {
  let deleted = 0
  for (let seq = this.journalPrunedThrough + 1;
       seq <= pruneThrough && deleted < HOUSEKEEPING_BATCH;   // HOUSEKEEPING_BATCH = 500
       seq++) {
    await deleteJsonFile(this.journalPath(seq)).catch(() => undefined)
    this.journalPrunedThrough = seq
    deleted++
  }
}
```

`deleted++` 对**已经不存在的文件**也计数（`deleteJsonFile` 吞 ENOENT）。所以每个新进程的第一个 checkpoint 只能从序号 1 重新走一遍，每次 500 个 no-op。

算一下：`CHECKPOINT_INTERVAL = 50`，即每 50 条 journal 事件触发一次 checkpoint，每次最多推进 500。一个已经累积了 N 条历史事件的实例，新进程需要 `N/500` 次 checkpoint、也就是 `N/10` 条新事件，才能把游标追回到真正可删的位置。

- N = 5,000 时：需要 500 条新事件才开始真正裁剪。一次典型 CLI run 未必产生这么多。
- N = 50,000 时：需要 5,000 条。**基本等于永不裁剪。**

`meta-agent loop` 的每次 CLI 调用都是新进程，所以这不是边缘场景，是默认场景。后果是 `.loop/<id>/graph/journal/` 单调增长，而每次 `readLastSequenceLocked` 的目录扫描回退路径（:808）也随之变慢。

**修复**：把 `prunedThrough` 写进 checkpoint 记录（`GraphCheckpoint` 加一个字段），或者启动时从 `journalDir` 的最小现存序号推导。前者更准，一行字段 + 一行读取。

### B3 · `pruneSettledIntentsLocked` 只对删除数限流，不对读取数限流 — P2

`GraphStore.ts:920-930`：

```ts
for (const id of ids) {
  if (deleted >= HOUSEKEEPING_BATCH) break
  const intent = await readJsonFile(path)          // ← 每个都读
  if (!intent || intent.status === 'prepared') continue   // ← 不计入 deleted
  if (now - intent.createdAt < INTENT_RETENTION_MS) continue  // ← 不计入 deleted
  await deleteJsonFile(path); deleted++
}
```

`INTENT_RETENTION_MS` 是 7 天。所以在实例运行的头 7 天里，`deleted` 永远是 0，`break` 永不触发，**每次调用都要读完目录里的每一个 intent 文件**——而且是在持有 `withTransaction` 全局锁的临界区内。这个函数的头注释说它是为了修复「recoverPrepared 每 tick 列出所有 intent 导致线性退化」，但它自己就有同样的退化。

**修复**：把预算改成「检查数」而非「删除数」，并记住上次扫到的位置。

### B4 · `withFileLock` 的心跳不校验持有权 — P2

`infra/persist/index.ts:286-289`：

```ts
const keepAlive = setInterval(() => {
  const now = new Date()
  void utimes(lockPath, now, now).catch(() => {})   // ← 不检查锁文件里的 ownerToken
}, heartbeatMs)
```

`finally` 块（:301-305）正确地做了「读 token → 确认是我的 → 才 unlink」，但心跳没有对称的检查。场景：进程 A 因为 SIGSTOP / 长 GC / 磁盘挂起而漏掉了三拍心跳，B 判定 stale 并 rename 接管；A 恢复后，它的 `setInterval` 继续对**同一个路径**执行 `utimes`——刷新的是 B 的锁。

后果不是互斥失效（那在 A 被判 stale 时就已经发生了），而是**故障被掩盖**：A 会一直帮 B 续租，直到 A 进程退出。如果 A 卡死不退，B 的锁会被无限续期，B 自己崩溃后没有任何进程能判定它 stale。

`GraphStore.withTransaction` 用的是 `staleMs: 15 分钟`，心跳间隔 5 分钟——两拍余量，A 只要卡 10 分钟就够。

**修复**：心跳里读一次 token 再 `utimes`（多一次 read，5 分钟一次，可忽略），或者持有一个 fd 并用 `futimes`——后者更干净但 rename 接管后 fd 仍指向旧 inode，反而是正确行为。

### B5 · `reconcileLocked` 每次事务做全量深比较，O(state) 常数偏大 — P2

`GraphStore.ts:756-765`，每一次 `withTransaction` 都会：

1. 逐个 `readJsonFile` 所有 running activation 的投影文件（心跳覆盖，:741-747）；
2. `JSON.stringify(diskState) !== JSON.stringify(state)` —— 对整个 State 快照做两次序列化 + 字符串比较；
3. `JSON.stringify(diskInstance) !== JSON.stringify(instance)` —— 同上；
4. `writeCheckpointLocked` 里再 `readJsonFile(specJson)` 读一次完整 graph spec（:865）。

第 2/3 步还依赖**键序稳定**才能得出正确结论。键序来自 `structuredClone`/对象字面量的构造顺序，今天稳定，但任何一次「用 `{...a, ...b}` 重排字段」的改动都会让比较永远返回 true，退化成每次事务多两次全量写——而且没有任何测试会失败。

**修复**：至少把 spec 缓存起来（它是 frozen 的，`graphHash` 就是它的身份）。深比较可以换成先比长度再比字符串，或者干脆去掉——`atomicWriteJson` 本来就是幂等的，省下的那次写换来两次序列化并不划算。

### B6 · 事务不可重入，唯一的防线是命名约定 — P3

`withTransaction` → `withFileLock` 不可重入。嵌套调用会阻塞 60 秒然后抛超时。代码用 `*Locked` 后缀标记「必须在事务内调用」的方法，`CommitCoordinator` 里 10 处 `store.withTransaction` 全部是顶层调用——**当前无违规**。

但这条约定没有任何机制检查。加一个运行期的 `#depth` 计数器、在嵌套时立刻抛出明确错误（而不是死等 60 秒），成本大约 5 行，能把一类「偶发 60 秒卡死」变成「第一次跑就报错」。

### B7 · `SubAgentBridge._bridgesBySessionId` 是进程级静态 Map — P3

`SubAgentBridge.ts:257`。构造时注册（:380），`_dispose` 时删除（:578），生命周期是对的。但它连同 §A2 提到的其它模块级可变单例（`mcpClients`、`mcpAppPresenter`、`cronStore`、`web_fetch` cache、`modelCallAdmission` provider、`ConfigService._session`、`timeouts._fileOverrides`）一起，构成上一轮已记录的已知边界：**同进程内无法安全运行两个独立 runtime 实例**。

这一轮没有恶化，但也没有收敛。对一个以 `@meta-agent/runtime` 名义发布的**库**来说，这是公共 API 契约的一部分，应该写进 README 而不是只留在评审文档里。

---

## 三、安全与权限边界（v0.8.16 回归复查）

### 保持住的（复查通过）

| 上轮修复 | 现状 |
|---|---|
| P0-2 声明驱动的命令扫描 | ✅ `commandField` 三处判断仍在（`:299/:524/:530`），默认表兜底仍在（`:94-96`） |
| P0-1 `cron_create` 走 `runShellCommand` | ✅ 且在授权时刻闭包捕获 jail/grants/sandbox handle（`cron_create/index.ts:99-104`），注释把理由写清楚了 |
| P1-1 沙箱凭证默认拒绝 | ✅ `sandboxPolicyConfig` 仍在，双层（OS 沙箱 + kernel jail）授权仍在 |
| P1-2 按值形态脱敏 | ✅ `secretRedaction` 由 `runShellCommand` 统一施加 |
| SSRF / DNS 重绑定 pinning | ✅ `web_fetch` 的 `createPinnedLookup` + 每跳重定向重校验完好 |
| 用户 `permissions.json` 双向权威 | ✅ `userSensitiveOverride` 逻辑正确（`:551-553`） |

### C1 · 工作区 jail 的路径扫描是「按字段枚举订阅」的，忘记枚举 = 零检查零告警 — **P1（结构性，非当前可利用）**

`findWorkspaceViolation` 的第三段（`PermissionPolicy.ts:519-526`）：

```ts
const fields = permission.pathFields ?? []
for (const field of fields) { ... }
```

一个没有 `permission` 声明、又不在 `DEFAULT_TOOL_PERMISSIONS`（只有 12 条）里的工具，合并结果是 `{}`：

- `requiresWorkspace` 为 `undefined` → `jailActive = ... && permission.requiresWorkspace !== false` → **true**（看起来 jail 生效了）
- `pathFields` 为 `undefined` → `?? []` → **循环体一次都不执行**
- `sensitive` 为 `undefined` → `needsApproval = permission.sensitive === true` → **false**（不需要审批）

也就是说：**jail 显示为激活，实际检查零个字段，且不需要审批**。这和 v0.8.16 那个 P0-2 是同一个形状——控制的订阅方式是显式枚举，漏了就静默豁免。

我逐个核对了当前所有工具，**今天没有可利用的缺口**：

- 8 个 fs 工具全部既有 `pathFields` 声明，**又**在工具内部二次调用 `resolveInsideWorkspace`（`tools/fs/*/index.ts` 全覆盖）——纵深防御到位；
- 唯一「无声明 + 有路径型输入」的是 `read_mcp_resource`（`uri`），但它读的是 MCP 服务器资源，不落文件系统；
- `memory_write` 的 `filename` 经 `sanitizeFilename`（`memoryProposal.ts`）用 `[^a-z0-9]+ → _` 清洗，穿越不可能；
- `memory_delete` → `deleteMemoryEntry(filename)` 里的 `join(memoryDir, filename)` **没有清洗**，但工具层 `deleteToolFactory` 在 `resolve()` 返回 null 时拒绝入队（`:63-69`），而 `resolve` 是对 `listMemoryEntries()` 的精确匹配——靠「存在性校验」而非「清洗」挡住。这个不变量在工具里，不在被保护的函数里，脆。

**建议**（按性价比排序）：

1. `deleteMemoryEntry` 自己加一行 `basename(filename)`——保护应该在被保护的函数里；
2. 把「无 `pathFields` 且 `category` 为 `write`/`execute`」变成**启动期的一条告警**（甚至开发模式下抛错），而不是静默通过。让漏声明变得吵闹；
3. 长期：让 `pathFields` 的默认值不是 `[]` 而是「扫描所有字符串输入」，声明 `pathFields` 是**收窄**而非**开启**。语义反转之后，忘记声明的后果从「零检查」变成「过度检查」——从静默漏洞变成吵闹的误报。

### C2 · `child_process` 仍有 8 处 `infra/exec` 之外的 import，上轮建议的 lint 规则未落地 — P2

上一轮结论原文：*「加一条 lint 规则，禁止在 `infra/exec/` 之外 import `child_process`。这是防止这类问题第三次出现的最低成本手段。」* 该规则未实施。当前分布：

| 位置 | argv 来源 | env | 评估 |
|---|---|---|---|
| `infra/exec/runShellCommand.ts` | 模型 | `buildChildEnv` | ✅ 唯一硬化入口 |
| `tools/mcp/mcpConfigFile.ts:317` | 配置文件 | `buildChildEnv('filtered', cfg.env)` | ✅ 凭证已过滤（无 OS 沙箱，可接受） |
| `tools/fs/grep/index.ts` | 固定 argv（rg） | 继承 | ⚠️ 见下 |
| `infra/git/GitWorkspaceManager.ts:293` | 固定 argv（git） | **完整继承** | ⚠️ 见 C3 |
| `core/auto/AutoWorktreeCoordinator.ts` | 固定 argv（git） | **完整继承** | ⚠️ 同上 |
| `core/auto/verify/JudgeSnapshot.ts` | 固定 argv（git） | **完整继承** | ⚠️ 同上 |
| `robotics/team/TeamStore.ts` | 固定 argv（git） | **完整继承** | ⚠️ 同上 |
| `cli/mcpAppsHost.ts:9` | 配置 | — | 需单独确认 |
| `sandbox/detect.ts` | 固定 argv + 3s 超时 | 继承 | ✅ 探测用，可接受 |

规则本身没问题（固定 argv 无 shell 可注入），漏的是**第二半**：env。

### C3 · git 子进程继承完整 `process.env`，且输出不脱敏 — P2

`GitWorkspaceManager.ts:297-303`：

```ts
const { stdout } = await execFileAsync('git', args, {
  cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
})   // ← 没有 env
```

没传 `env` 意味着完整继承：所有 provider key、`GITHUB_TOKEN`、`AWS_*`。上一轮把这条记为「已知边界 #2」，但记录的范围是「auto 模式 push 的接线方式」——实际范围比这大：**所有 git 调用，包括 robotics 团队模式和 `JudgeSnapshot`**。

第二半是输出：`getTaskDiff()`（:134）返回的 stdout **不经 `redactSecrets`**，而 `git_diff_subagent` 工具（`:46-50`）把它直接拼进工具结果送进模型上下文。如果 subagent 在自己的分支上提交了一个含凭证的配置文件，`git diff` 会把它原样带进上下文 → 日志 → lineage。

`runShellCommand` 对所有调用方统一脱敏正是为了消除这类「工具忘了这一步」，但 git 路径不走它。

**建议**：`_gitIn` 加 `env: buildChildEnv('filtered')`（git 需要的是 `PATH`/`HOME`/`GIT_*`，`buildChildEnv` 已保留），返回前过一次 `redactSecrets`。约 4 行，覆盖 4 个文件里的全部 git 调用——如果先把它们收敛到 `GitWorkspaceManager._gitIn` 的话，这也正是 C2 那条 lint 规则的价值。

### C4 · `execFileSync` 4 处同步阻塞事件循环 — P3

`sandbox/detect.ts`（2 处，带 3s 超时，缓存结果，可接受）、`GitWorkspaceManager.ts:56`、`AutoWorktreeCoordinator.ts:120`、`JudgeSnapshot.ts:75`。后三处是 `git rev-parse`，通常毫秒级——但在网络文件系统或大仓上会阻塞整个事件循环，包括正在流式输出的模型响应和所有并发 subagent。都有异步等价物，改动成本低。

---

## 四、演进与可维护性

### D1 · `SchedulerRegistry.ts` 含 2 个裸 NUL 字节，git 判定为二进制文件 — P2

```
src/core/auto/SchedulerRegistry.ts  →  file(1) 报告 "data"，不是文本
第 3253 字节：createHash('sha1').update(`${host}<NUL>${resolve(workspace)}<NUL>${pid}`)
```

模板字面量里写的是**真实的 U+0000 控制字符**，而不是转义 `\0`。后果都是工具链层面的，但很实际：

- `git diff` / `git log -p` 输出 `Binary files differ`——这个文件的改动**在 code review 里不可见**；
- `grep -rn` 默认跳过它（我在本轮扫描中就必须为它单独处理），任何全仓搜索会静默漏掉它；
- 任何做换行规整、编码转换、或 `.gitattributes` 文本处理的工具都可能悄悄删掉这两个字节——而它们参与 sha1 计算，**调度器身份哈希会静默改变**，表现为「重启后所有 scheduler 记录变成孤儿」。

同一模式在 `GitWorkspaceManager.ts:153` 也有（`${taskId}\x00${branchName}`），但那处写的是转义序列 `\x00`，源码是纯文本，没问题。

**修复**：把两个字符替换成 `\0` 转义。这是本报告里唯一一个「三秒钟能修完」的条目，建议顺手就做。

### D2 · 超大文件集中在最复杂的模块 — P2

| 文件 | 行数 | 性质 |
|---|---|---|
| `loop/graph/distill/GraphDistiller.ts` | 2073 | 图蒸馏，`docs/reviews/` 里已有 4 份专门审计 |
| `kernel/loop/KernelLoop.ts` | 1943 | 主循环，14 个 step、6 类中止原因 |
| `cli/repl.ts` | 1746 | REPL |
| `subagent/SubAgentBridge.ts` | 1536 | 并发准入 + 预算 + 生命周期 |
| `robotics/RoboticsSession.ts` | 1519 | — |

`GraphDistiller` 有 4 份历史审计（`graph-loop-audit-2026-07-19/-21/-20`、`distill-root-cause-analysis-2026-07-19`）——反复出问题的地方和最大的文件是同一个，这不太可能是巧合。

`KernelLoop` 的中止路径尤其值得单独拆：`aborted_streaming` / `aborted_tools` / `phase_hook_abort` / `phase_hook_fail` / `auto_runtime_limit` / `interrupt` 六种终止语义交织在同一个 1943 行的函数体里，`signal.reason` 的字符串比较散落在至少 5 处（:1253/:1259/:1299/:1423/:645）。

### D3 · `cli/` 测试覆盖显著偏低，而它包含一个 HTTP 服务器 — P2

| 模块 | 源码行 | 测试行 | 比值 |
|---|---|---|---|
| `kernel` | 9,863 | 6,796 | 0.69 |
| `tools` | 6,307 | 3,877 | 0.61 |
| `core` | 13,721 | 5,963 | 0.43 |
| `loop` | 16,148 | 6,788 | 0.42 |
| `subagent` | 4,593 | 1,755 | 0.38 |
| `robotics` | 10,349 | 3,370 | 0.33 |
| **`cli`** | **10,518** | **1,682** | **0.16** |

`cli/` 里有 `mcpAppsHost.ts`（714 行，一个带 CSP 策略、`/rpc` 端点和资源白名单的 HTTP 服务器），上一轮在它里面修了 3 个问题（P2-2/P2-3/P3-6）。0.16 的覆盖比意味着那 3 个修复大部分没有回归锁。

### D4 · 文档已成为一个需要治理的资产 — P3

66 个 md / 14,830 行，其中 `docs/reviews/` 有 **30 份**历史评审。没有索引，没有「哪些结论仍然有效 / 已被后续推翻」的标记。`CODE_REVIEW.md` 同时存在于仓库根和 `docs/reviews/`（内容不同）。

对一个由 agent 频繁读取上下文的项目，这不只是整洁问题——过期的评审结论会被当成现状读进 prompt。建议 `docs/reviews/INDEX.md`，每份一行：日期 / 基线版本 / 结论状态（已修复 / 部分有效 / 已过时）。

> **2026-09-03 更新：根目录重名问题已解决。** 两份根目录评审归档为
> [`CODE_REVIEW_2026-08-14.md`](CODE_REVIEW_2026-08-14.md) 与
> [`CODE_REVIEW_2026-09-02.md`](CODE_REVIEW_2026-09-02.md)；索引由
> [`docs/README.md`](../README.md) 承担（而非另建 `INDEX.md`），已补齐至覆盖 `docs/` 全部文件。
> 「结论状态」标注仍未做——本条的这一半依然有效。

### D5 · 公共 API 面无版本化策略 — P3

`src/index.ts` 306 行、72 个 export 块，导出了从 `MetaAgentSession` 到 `DimensionalConsistencyChecker` 到 `BASE_DIMENSIONS` 的一切。0.x 版本下这没有兼容性义务，但它决定了**什么不能改**——而目前没有任何标记区分「这是稳定契约」和「这只是恰好被导出了」。

`package.json` 的 `files` 字段里有一条值得注意的：`"docs/自动模式/自动调度器.md"`——单独把一个中文路径的文档打进 npm 包。`.npmignore` 上一轮已改成指向 `files` 的说明，这条是有意的，但路径里的中文会在部分 Windows npm 客户端上出问题，值得确认。

---

## 五、优先级汇总

| # | 条目 | 严重度 | 位置 | 修复量 |
|---|---|---|---|---|
| B1 | `readJsonFile` 吞掉非 ENOENT 错误 → graph 假性损坏 | **P1** | `infra/persist/index.ts:49` | 小改 + 40 处调用点确认 |
| B2 | `journalPrunedThrough` 内存化 → journal 实际永不裁剪 | **P1** | `GraphStore.ts:110,899` | 2 行 |
| C1 | jail 路径扫描按字段枚举订阅，漏声明 = 零检查零告警 | **P1**(结构) | `PermissionPolicy.ts:519` | 告警：小；语义反转：中 |
| A1 | `core → modes` 分层倒置 | P2 | `MetaAgentSession.ts:64` | ~30 行 |
| A2 | 五套执行循环无共享抽象 | P2 | 跨模块 | 先出文档 |
| A4 | `progress_note` 工具重名，注册静默覆盖 | P2 | 两处 | 改名 + 注册断言 |
| B3 | intent 清理不限流读取，且在临界区内 | P2 | `GraphStore.ts:920` | 小 |
| B4 | 文件锁心跳不校验持有权 | P2 | `infra/persist/index.ts:286` | 3 行 |
| B5 | `reconcileLocked` 全量深比较 + 重复读 spec | P2 | `GraphStore.ts:756` | 小 |
| C2 | `child_process` lint 规则未落地（上轮遗留） | P2 | 8 处 | 一条 lint 规则 |
| C3 | git 子进程继承完整 env + 输出不脱敏 | P2 | `GitWorkspaceManager.ts:297` | ~4 行 |
| D1 | `SchedulerRegistry.ts` 裸 NUL 字节 → git 视为二进制 | P2 | `:3253` | **3 秒** |
| D2 | 超大文件（2073/1943/1746/1536/1519） | P2 | — | 大 |
| D3 | `cli/` 覆盖比 0.16，含 HTTP 服务器 | P2 | — | 中 |
| A3 | 死代码：`cc-kernel/`、`core/persist` shim、单复数目录 | P3 | — | 小 |
| B6 | 事务不可重入，无机制检查 | P3 | `GraphStore.ts:585` | 5 行 |
| B7 | 模块级单例阻止同进程多实例 | P3 | 8 处 | 记入 README |
| C4 | 4 处 `execFileSync` 阻塞事件循环 | P3 | — | 小 |
| D4/D5 | 文档治理 / 公共 API 版本化 | P3 | — | 小 |

### 建议的 CI 护栏（按性价比排序）

这一轮的发现里有 6 项是「约定没有机制保障」。四条 CI 检查能覆盖其中大部分，总成本远低于逐个修复：

1. **依赖环检查** — 现在是 0，这是难得的好状态。加一条 `madge --circular src/` 或本次用的 Tarjan 脚本，把它锁住。同时可以断言 `core/**` 不 import `modes/**`（A1 修完之后）。
2. **`child_process` import 白名单** — 上一轮就建议了，仍未落地（C2）。一条 ESLint `no-restricted-imports` 即可。
3. **工具名唯一性断言** — 在工具注册处（`MetaAgentSession.registerTool` / `SubAgentBridge.setToolRegistry`）重名即抛（A4）。也可以做成一个测试：枚举所有 `create*Tool` 工厂，断言 name 集合无重复。
4. **权限声明完整性测试** — 遍历所有工具，断言 `category` 为 `write`/`execute` 的必须声明 `pathFields` 或 `commandField`（C1）。这条测试如果早存在，v0.8.16 的 P0-1 会在写出来的当天就红。

---

## 方法与局限

**做了什么**：全量 `src/` 结构扫描；用 Tarjan SCC 对 414 个非测试文件的 1,805 条相对 import 做了文件级与模块级的环检测；逐个核对了 §三 里 v0.8.16 的 6 项安全修复；对 `GraphStore`/`CommitCoordinator`/`PermissionPolicy`/`runShellCommand`/`withFileLock`/`MetaAgentSession` 做了逐行阅读；对全部 60+ 个工具核对了权限声明覆盖；对 §C1 提到的每一条潜在路径穿越（`memory_write`、`memory_delete`、`read_mcp_resource`、fs 工具组）做了到写入点为止的追踪。

**验证状态**：
- `tsc --noEmit` — **干净**（exit 0）。
- `vitest run` — **未能执行**。`node_modules` 是在 macOS 上安装的，评审沙箱是 Linux，`rolldown` 的原生绑定不匹配（`Cannot find module '@rolldown/binding-wasm32-wasi'`）。请在本机跑一次作为基线；上一轮记录是 2177 passed / 218 files，本轮测试文件数已增至 227。

**没做什么**：`GraphDistiller.ts`（2073 行）和 `cli/repl.ts`（1746 行）只做了结构层面的观察，没有逐行审查——如果要单独深挖，`GraphDistiller` 是我会先看的那个，理由见 D2。

---

## 修复记录（同日）

48 个文件，+402 / −762 行。`tsc --noEmit` 干净；`vitest run` **2282 passed / 230 files，0 失败**。

### 已修复

| # | 条目 | 做法 |
|---|---|---|
| **B1** | `readJsonFile` 吞掉非 ENOENT 错误 | ENOENT 返回 null，其余抛出。枚举式调用点（11 处）显式声明 `tolerateUnreadable: true` 并保留告警——「容忍」不等于「隐藏」。单条权威读取一律走抛出语义 |
| **B2** | journal 裁剪游标内存化 | `prunedThrough` 写进 `GraphCheckpoint`（可选字段，兼容旧 checkpoint）；旧 checkpoint 从现存 journal 最小序号推导——精确而非保守，否则等于没修 |
| **C1** | jail 路径扫描漏声明即静默豁免 | ① `deleteMemoryEntry` 自己加 `basename()`——保护放在被保护的操作上，而不是调用方的校验步骤里；② `warnIfJailIsInert()` 在声明了 write/execute 却不指定任何扫描字段时告警；③ 配套测试强制执行 |
| **B3** | intent 清理不限流读取 | 预算从「删除数」改为「检查数」，加轮转游标；不再在事务锁内读完整个目录 |
| **B4** | 文件锁心跳不校验持有权 | 心跳前读 token 确认仍属于自己；不是自己的就 `clearInterval` 停跳，不再替接管者续租 |
| **B5** | `reconcileLocked` 每次事务全量深比较 | 仅在本次调用确有重放（`repaired > 0`）时才对账。`GraphKernel.tick` 单次就调用 `snapshot()` 4 次以上，其中多数重放零事件 |
| **B6** | 事务不可重入且无检测 | 用 `AsyncLocalStorage` 而非深度计数器。**这条在实施中抓到了真实反例**：计数器版本让 `GraphV2Runtime` 测试失败——`Promise.allSettled` 里的并行事务被误判成嵌套。并行（各自排队、都能推进）与嵌套（自锁死等 60 秒）的区别正是异步上下文，计数器表达不了 |
| **C2** | `child_process` lint 规则未落地 | 落地为测试而非 lint（`npm test` 本来就跑）。白名单 6 条，每条写明理由 |
| **C3** | git 子进程继承完整 env + 输出不脱敏 | 新增 `infra/exec/runGit.ts` 作为唯一 git 入口：`buildChildEnv('filtered')` + `redactSecrets`（含异常里的 message/stdout/stderr）。四个消费方用 `_file: 'git'` 字面量类型的本地适配器接入，调用点零改动，且「从这里跑别的东西」变成编译错误。机器可解析的输出（`ls-files -z`、`rev-parse` 路径）显式标 `raw: true` |
| **C4** | `execFileSync` 阻塞事件循环 | git 的三处收敛到 `runGitSync`（仍同步，但已统一硬化）；`sandbox/detect` 的两处保留——带 3s 超时且结果缓存 |
| **A1** | `core → modes` 分层倒置 | `MetaAgentSession.ts` 从 `core/` 移到 `modes/`——它本来就是 `AgenticSession` 的 facade。7 个引用方跟随。`core → modes` 边归零 |
| **A3** | 死代码 | 删除 `src/cc-kernel/`（全仓零引用）与 `src/core/persist/` 转发 shim（24 个引用方改指 `infra/persist`，消除同一模块两个 import 路径）；`scripts/build-cli.js` 的 `@meta-agent/cc-kernel` external 一并清理 |
| **A4** | `progress_note` 重名 | 不改名（会动模型可见行为）。改为测试锁定：单个装配好的工具集内不得重名（真正的 bug 类），跨代码库重名必须登记在 `KNOWN_POLYMORPHIC` 并写明为何两者永不同框 |
| **D1** | `SchedulerRegistry.ts` 裸 NUL 字节 | 改为 `\0` 转义。哈希值不变，文件恢复为文本，`git diff` 重新可读 |

### 新增的 4 条 CI 护栏

`src/__tests__/ArchitecturalInvariants.test.ts` — 每条都对应一次已经付出过代价的 bug：

1. **文件级 value-import 无环**（类型导入排除，它们在运行期已擦除）
2. **`child_process` 白名单**
3. **工具名唯一性**（单工具集内 + 跨库重名登记）
4. **mutating 工具必须给 jail 留下可扫描的东西**

外加针对性回归测试：`readJsonFileErrors.test.ts`（4 例）、`JournalPruneCursor.test.ts`（5 例，含 B6 重入）。

**四条护栏都做了变异验证**——逐条重新引入对应的 bug，确认测试确实失败，再复原确认通过。这一步值得单独说：护栏 1 第一版**没有抓到**故意注入的 `core → modes` 环。原因是它的 import 正则用了宽松的 `[\s\S]*?`，遇到 `export type Foo = …` 会把 `export` + `type ` 认成类型导入，然后惰性匹配一路吞到**下一条语句**的 `from`——那条真实的 import 既被消费又被误判成类型导入。也就是说，那一版护栏对整个 `core/config.ts` 是盲的，却报告「图是干净的」。改成严格的 import-clause 文法后才真正生效。

一条没验证过的护栏，比没有护栏更糟：它会让人以为已经检查过了。

### 剩余未做

| # | 条目 | 为什么留着 |
|---|---|---|
| A2 | 五套执行循环无共享抽象 | 不建议现在做大统一重构。先出 `docs/architecture/execution-models.md`，把五者的持久化等级/取消语义/崩溃后行为列成一张表 |
| D2 | 超大文件（2073/1943/1746/1536/1519） | 多日工作量。`GraphDistiller` 优先（已有 4 份历史审计指向同一处） |
| D3 | `cli/` 覆盖比 0.16 | 同上。`mcpAppsHost.ts` 优先，上一轮在里面修的 3 个问题大多没有回归锁 |
| B7 / D4 / D5 | 模块级单例、文档治理、公共 API 版本化 | 均属「记录到位即可」，建议写进 README 与 `docs/reviews/INDEX.md` |

### 验证

- `tsc --noEmit`：干净（`tsconfig.test.json` 下的 62 个既有测试类型错误为改动前基线，逐条比对未增加）。
- `vitest run`：**2282 passed / 230 files，0 失败**。
- 上一轮基线为 2177 / 218；本轮新增 3 个测试文件 / 14 个用例。
- 测试在 Linux 沙箱中的独立副本上运行（仓库的 `node_modules` 是 macOS 原生绑定，无法跨平台直接跑），源码逐次同步。建议本机再跑一次 `npm test` 作为最终确认。
