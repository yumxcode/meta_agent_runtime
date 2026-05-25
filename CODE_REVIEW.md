# meta-agent-runtime 全项目代码审查报告

**审查范围：** `packages/meta-agent-runtime/src/` — 所有 TypeScript 源文件  
**审查时间：** 2026-05-23  
**状态：** 最终版

---

## 一、本轮已修复项目（上下文）

以下问题在本轮开发过程中已被修复，此处列出作为背景：

| 编号 | 问题 | 修复方式 |
|------|------|----------|
| #1 | `DirectSession` / `CampaignSession` / `RoboticsSession` 缺少并发防护 | 添加 `_submitInFlight` guard + try/finally |
| #2 | `stateSnapshot.ts` 并发写入 JSON 文件损坏 | 引入 `_writeChains` per-session promise 链 |
| #3 | `SubAgentTaskStore` 并发写入竞态 | 引入 `_writeChains` per-taskId promise 链 |
| #4 | `GitWorkspaceManager` 并发 git 操作竞态 | 引入 `_withGitMutationLock` |
| #5 | `CampaignStateStore._mutationLock` 多实例竞态 (P0) | 引入引用计数锁 (`count` + 自析构) |
| #6 | `JobManager` 持久化失败无重试 | 添加 `_persistWithRetry`（指数退避，3次） |
| #7 | `JobManager.awaitJob()` 可能永久挂起 | 检测 terminal 状态但无 result 时立即 reject |
| #8 | `GitWorkspaceManager` 缺少结果感知的清理 API | 添加 `removeWorktreeWithOutcome()` |
| #9 | 旧 worktree 磁盘积累 | 添加 `pruneStaleWorktrees(ttlMs)` |
| #10 | 队列堵塞无可见性 | 添加 `SubAgentSchedulerStats` + 30s 超时警告 |
| #11 | Plan B：任务认领后历史对话边界模糊 | `teamSetContextBoundary()` + 对话框 |

---

## 二、新发现问题

### 🔴 P0（高优先级）

#### P0-A：`TeamStore.writeAll()` — `team.json` 写入非原子

**文件：** `robotics/team/TeamStore.ts:1211-1236`

`writeAll()` 依次写入 `team.json`、`board.md`、`goals.md` 等 6 个文件，但 `team.json` 用的是普通 `writeFile`，不是 `atomicWriteJson`。

```typescript
// 当前（危险）:
await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')

// 应改为:
await atomicWriteJson(this.statePath, state)
```

**风险：** 进程在写入 `team.json` 时崩溃（如 SIGKILL），会留下一个空文件或半写文件。下次 `read()` 解析失败后返回 `null`，调用 `ensure()` 则会创建默认状态，**所有任务数据丢失**。

其余 5 个 `.md` 文件不需要原子写（它们是渲染视图，可从 `team.json` 重建），但 `team.json` 是系统的唯一真相来源，必须原子写。

---

#### P0-B：`SessionStore._upsertIndex` — `index.json` 写入非原子

**文件：** `core/SessionStore.ts:68`

```typescript
async function writeIndex(entries: SessionMeta[]): Promise<void> {
  await ensureDir(SESSIONS_ROOT)
  await writeFile(INDEX_FILE, JSON.stringify(entries, null, 2), 'utf-8') // ← 非原子
}
```

`index.json` 保存最近 50 个会话的元信息。如果两个进程同时关闭（两个 CLI 窗口），两者都会 `readIndex()` → mutate → `writeFile()` 产生最终写覆盖，其中一个会话的元数据丢失。更严重的是，如果写入时进程终止，`index.json` 被清空，所有会话入口变得不可发现（数据本身在 `history.jsonl` 中仍然存在，但用户无法从 UI 找到它）。

```typescript
// 修复：
import { atomicWriteJson } from './persist/index.js'
// 将 writeFile(INDEX_FILE, ...) 改为 atomicWriteJson(INDEX_FILE, entries)
```

---

### 🟠 P1（中优先级）

#### P1-A：`sanitizeScalar` 不过滤换行符 → YAML 前置信息注入

**文件：** `core/memory/memoryWriter.ts:104-108`

```typescript
function sanitizeScalar(value: unknown, max = 240): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/\r/g, '').trim()   // ← 只过滤 \r，不过滤 \n
  if (!trimmed) return undefined
  return trimmed.slice(0, max)
}
```

`renderMemoryFile()` 将清洗后的值直接拼入 YAML 前置信息：

```typescript
lines.push(`name: ${sanitizeScalar(proposal.name, 160)}`)
```

如果 LLM 返回的 `name` 包含 `\nrequires_revalidation: false\ntype: malicious_type`，将向 frontmatter 注入额外字段。虽然当前威胁模型中 LLM 是半信任的，但任何能影响 LLM 输出的攻击者（提示注入）可借此写入任意 frontmatter 字段。

**修复：**

```typescript
const trimmed = value.replace(/[\r\n]/g, ' ').trim()
```

---

#### P1-B：`TeamStore.claim()` — 并发认领竞态

**文件：** `robotics/team/TeamStore.ts:415-444`

`claim()` 的操作序列为 `read()` → validate → mutate → `writeAll()`，没有乐观并发控制或行级锁。两个单元（unit）同时调用 `claim(taskId)` 时，两者都能通过 `ownerUnit` 检查（因为两者读到的都是旧状态），最终最后一个写入者成功拥有任务。

这是 git-backed 共享状态的固有局限，文档中也有说明（"last write wins"）。不过，对于 **同一进程内** 的并发认领（如 CLI 快速双击），行为是可预测的（Node.js 单线程事件循环），而 **跨进程** 的竞态依靠用户在 PR 阶段发现冲突。

**建议：** 添加 `schemaVersion` + `updatedAt` 乐观锁（写入前检查磁盘版本是否改变），或在 `writeAll()` 前从磁盘重新读取并重新检查所有权。这与 CampaignStateStore 的 `_withLock` + `reload()` 模式一致。

---

#### P1-C：`parseConcurrencyLimit()` 等在模块加载时求值

**文件：** `kernel/tools/ToolOrchestration.ts:17-23`、`tools/shell/bash/index.ts:11-17`、`modes/toolAdapter.ts:20`

```typescript
const MAX_CONCURRENT_TOOLS = parseConcurrencyLimit()   // ← 在 import 时执行
const MAX_OUT = (() => { ... })()                       // ← 在 import 时执行
const MAX_TOOL_RESULT_CHARS = (() => { ... })()         // ← 在 import 时执行
```

这意味着环境变量 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` / `META_AGENT_MAX_TOOL_OUTPUT_CHARS` 在模块第一次被 `import` 后设置无效。这不影响生产（环境变量在进程启动前设置），但严重影响单元测试——测试之间无法改变这些常量，导致测试隔离困难。

**修复：** 将求值延迟到首次 `call()` 调用，或接受为构造参数：

```typescript
// 惰性求值替代方案：
function getConcurrencyLimit(): number {
  const raw = process.env['CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY']
  ...
}
// 每次调用时使用 getConcurrencyLimit()，无顶层常量
```

---

#### P1-D：`CampaignStateStore._evalCache` — 静态 Map 无 TTL，测试污染

**文件：** `coordination/CampaignStateStore.ts:86-93`

```typescript
private static readonly _evalCache = new Map<
  string,
  { offset: number; results: EvaluationResult[] }
>()
```

`_evalCache` 和 `_mutationLock` 都是静态 Map，在进程生命周期内持续存在。`cleanup()` 会清除特定 campaign 的条目，但：

1. 如果 `CampaignMonitor._stop()` 未被调用（进程 crash），Map 无限增长（每个 campaign 积累所有评估结果）。
2. 测试中同一进程多轮创建和销毁 campaign 时，旧 campaign 的 eval 数据泄漏到新测试。
3. `MetaAgentContextStore._cache` 是同类问题（静态缓存，单元测试无隔离）。

**建议：** 在 `_loadAll()` 中为已知的 DONE/FAILED campaign 主动调用 `cleanup()`，或者为 `_evalCache` 添加容量限制（LRU）。

---

#### P1-E：`SubAgentBridge._completedCount` 语义命名歧义

**文件：** `subagent/SubAgentBridge.ts`

`_completedCount` 在 `_drainStartQueue().finally()` 中递增，因此它统计的是**成功 + 失败**任务数，而非仅成功的任务。`getSchedulerStats()` 返回的字段名 `completedThisSession` 给调用者的暗示是"成功完成"。

**建议：** 重命名为 `_finishedCount` / `finishedThisSession`，或分别维护 `_successCount` / `_failedCount`。

---

### 🟡 P2（低优先级 / 技术债）

#### P2-A：全局无运行时 schema 校验（Zod 缺失）

**影响文件：** `CampaignStateStore.reload()`、`TeamStore.read()`、`SessionStore.loadHistory()`、`SubAgentTaskStore`、大量 JSON 文件读取路径

所有 JSON 反序列化都形如 `JSON.parse(raw) as SomeType`，没有 Zod 等运行时校验。当磁盘上的文件来自旧版本（schema 迁移）或被手动编辑时，TypeScript 类型断言在运行时没有任何保护作用。

当前代码通过 `schemaVersion` 字段检查提供了**一定程度**的防御（`TeamStore.read()` 校验 `parsed.schemaVersion !== '1.0'`，CampaignStateStore 同理），但对字段级别的类型错误（如 `pendingTaskIds` 不是数组）没有防护。

**建议：** 对核心持久化类型（`PersistedCampaignState`、`TeamState`、`EngineeringJob`）引入 Zod schema 校验，至少保护最关键的字段。

---

#### P2-B：`SessionStore._upsertIndex` — sort 在 slice 之后执行

**文件：** `core/SessionStore.ts`

```typescript
const trimmed = entries.slice(0, MAX_INDEX_ENTRIES)  // slice 先
trimmed.sort((a, b) => b.lastActivity - a.lastActivity)   // sort 后
```

这个顺序有一个角落案例：如果索引已满（50 条），新插入的条目（`unshift` 到位置 0）在 `slice(0, 50)` 后保留，但如果刚 `slice` 后其 `lastActivity` 相对较老，它应该出现在排序后的较后位置，而不是被丢弃。事实上这个逻辑是正确的（新条目在 slice 前已保证在前 50 条里），但 sort-after-slice 的语义令人困惑。

**建议：** 改为先 sort 再 slice，并添加注释说明意图：

```typescript
entries.sort((a, b) => b.lastActivity - a.lastActivity)
const trimmed = entries.slice(0, MAX_INDEX_ENTRIES)
```

---

#### P2-C：`TeamStore.writeAll` 写 6 个文件无防抖

**文件：** `robotics/team/TeamStore.ts`

每次 `sync()` / `claim()` / `updateTaskStatus()` 等状态变更都会触发 6 次顺序 `writeFile` 调用。`TeamWatcher.tick()` 每 30 分钟调用一次 `sync()`，但如果团队频繁操作（多个 unit 密集协作），每次 git push/pull 都会写 6 个文件。

Markdown 视图文件（`board.md` 等）是纯渲染副产品，可以考虑：
1. 降低渲染频率（不在 `sync()` 中写，仅在 `claim()` / `updateTaskStatus()` 中写）；
2. 或将它们改为按需从 `team.json` 计算，完全去除写入。

---

#### P2-D：`memoryWriter.ts` 硬编码 DeepSeek 模型

**文件：** `core/memory/memoryWriter.ts:19`

```typescript
const MEMORY_WRITER_MODEL = 'deepseek-v4-flash'
```

记忆写入侧调用的模型硬编码为 DeepSeek。如果用户使用纯 Anthropic 配置（无 DeepSeek key），每次 session 关闭的记忆写入都会因 API 调用失败而静默跳过（8s timeout 后返回 `{attempted: false}`）。

这不会影响主功能，但会使 robotics 和 campaign 模式的记忆功能对无 DeepSeek 密钥的用户完全不可用。

**建议：** 从 `MetaAgentConfig.flashModel`（或 `config.memoryModel`）传入，fallback 到 DeepSeek。

---

#### P2-E：`git` 分支名未经 allowlist 校验即传入 `execFileAsync`

**文件：** `robotics/team/TeamStore.ts:568-571`

```typescript
await execFileAsync('git', ['checkout', branch], { cwd: this.projectDir, timeout: 30_000 })
```

`branch` 值来自 `task.branch`（反序列化自 `team.json`）。`makeBranchName()` 会正确 slugify，但如果用户手动编辑 `team.json` 将 `branch` 改为 `--option-injected`，git 会将其解释为选项标志。

`execFileAsync`（而非 `exec`）不会经过 shell，所以**命令注入**不存在；但**git 选项注入**仍然有效（git 接受 `--` 分隔符之前的任何参数作为选项）。

**修复：** 在 `branchForTask()` 调用 `git checkout` 前，对 `branch` 做 `branch.match(/^[a-zA-Z0-9/_.-]+$/)` 校验，若不匹配则拒绝并报错。

---

#### P2-F：`stateSnapshot.ts` vs `runStateSnapshot.ts` 代码重复

**文件：** `core/compact/stateSnapshot.ts`、`core/compact/runStateSnapshot.ts`

两个文件实现了几乎相同的快照逻辑（从 `runtimeContext` 构建状态 + 序列化写磁盘），但服务不同的调用路径（KernelSession-based vs cc-kernel-based）。随着时间推移，两者的边界条件修复可能互相遗漏，已有一定程度的发散。

**建议：** 将公共的 `buildSnapshotData()` 逻辑提取到共享模块，两个文件各自保留专属的写入策略（write chain vs 直接写入）。

---

## 三、架构层面观察（无明显问题，记录供参考）

### 3.1 静态单例的测试隔离问题

以下单例在测试间无法干净重置：
- `MetaAgentContextStore._cache`（静态字段）
- `CampaignStateStore._evalCache`、`_mutationLock`（静态 Map）
- `MAX_CONCURRENT_TOOLS`（模块级常量）
- `_evalCache` Map entries（需要显式调用 `cleanup()`）

对现有测试套件（主要 mock 化的单元测试）影响不大，但若未来添加集成测试（多 campaign 或多 session 并发）会成为痛点。

### 3.2 JSON 序列化边界无类型守卫

见 P2-A。`as T` cast 遍及全库，技术上不安全，但被 schemaVersion 检查和业务层防御性代码（`if (!task)` 等）所缓冲，实际故障率很低。

### 3.3 三 Session 类共同模式可提取基类

`DirectSession`、`CampaignSession`、`RoboticsSession` 共享几乎相同的构造器（`KernelSession` 初始化、`registerTool()`、`_submitInFlight` guard）。可提取 `BaseSession<T extends KernelSessionConfig>` 减少重复，但这是纯重构，不影响正确性。

### 3.4 `TeamStore` 与 git 强耦合

`TeamStore` 同时承担**状态管理**（JSON 读写）和**git 操作**（fetch、branch、push、PR draft）两个职责。随着功能增长，建议将 git 操作迁移至专用 `TeamGitOps` 类，保持 `TeamStore` 专注于状态持久化。

---

## 四、安全审查

| 向量 | 状态 | 说明 |
|------|------|------|
| 路径遍历 | ✅ 已防护 | `workspaceGuard.ts` 使用 `realpathSync` + 祖先解析，bash tool 也有独立检查 |
| Shell 注入 | ✅ 无风险 | 所有外部命令均使用 `execFileAsync`（非 `exec`），不经 shell 解释 |
| Git 选项注入 | ⚠️ P2-E | `task.branch` 未经 allowlist 校验直接传入 `git checkout` |
| YAML 注入 | ⚠️ P1-A | `sanitizeScalar` 未过滤 `\n`，LLM 输出可注入 frontmatter 字段 |
| API Key 泄漏 | ✅ 无风险 | key 只存在于 `process.env`，不写入磁盘，不出现在日志中 |
| 任意文件写入 | ✅ 已防护 | 写入路径均在预定义目录下（`~/.claude/meta-agent/`、workspace root）|
| GitHub issue 注入 | ✅ 低风险 | task 字段经 `gh` CLI 传递，`gh` 本身做 HTTP 转义 |

---

## 五、测试覆盖评估

当前 117 个测试（全部通过）覆盖：

- ✅ `ToolOrchestration` — 并发批处理逻辑
- ✅ `KernelSession` — 基本 submit/tool 循环
- ✅ `AutoCompact` — compact 触发条件
- ✅ `PermissionPolicy` — workspace 路径检查
- ✅ `SubAgentBridge` — scheduler 统计（新增）

**覆盖空白（高优先级添加）：**
- ❌ `TeamStore.claim()` 并发认领
- ❌ `CampaignStateStore.completeTask()` 多实例并发
- ❌ `GitWorkspaceManager.pruneStaleWorktrees()`
- ❌ `TeamStore.writeAll()` 写入原子性（power-failure 模拟）
- ❌ `memoryWriter.extractJson()` YAML 注入边界

---

## 六、建议修复优先级

| 优先级 | 编号 | 预计工时 |
|--------|------|----------|
| 🔴 立即修复 | P0-A：`team.json` 改用 `atomicWriteJson` | 15 分钟 |
| 🔴 立即修复 | P0-B：`index.json` 改用 `atomicWriteJson` | 10 分钟 |
| 🟠 近期修复 | P1-A：`sanitizeScalar` 过滤 `\n` | 5 分钟 |
| 🟠 近期修复 | P1-E：`_completedCount` 重命名 | 5 分钟 |
| 🟠 近期修复 | P2-E：branch name allowlist 校验 | 20 分钟 |
| 🟡 计划中 | P1-B：TeamStore 乐观并发控制 | 1-2 小时 |
| 🟡 计划中 | P2-A：核心类型添加 Zod 校验 | 半天 |
| 🟡 计划中 | P1-C / P1-D：模块加载常量 + 静态单例 | 半天 |

---

## 七、总体评价

代码库整体质量**较高**。核心并发路径（CampaignStateStore、SubAgentTaskStore、GitWorkspaceManager、KernelSession）都有经过仔细设计的锁机制，本轮审查中发现的高优先级问题均集中在**持久化层**——特别是 TeamStore 和 SessionStore 的非原子写入。这两处修复成本极低（替换为已有的 `atomicWriteJson` 工具函数），但对数据安全性影响显著。

安全面总体无重大漏洞。YAML 注入（P1-A）和 git 选项注入（P2-E）均属低烈度问题，且在当前威胁模型中可接受，但值得修复。

测试套件充实，主要业务逻辑均有覆盖；建议重点补充并发/竞态场景的测试，以防止已修复的问题回归。
