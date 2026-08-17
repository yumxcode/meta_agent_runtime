# 长周期任务管理 TUI —— 技术方案

状态：**P0 / P1 已实现（v0.8.18）** · 2026-08-17

> 实现与本文的三处偏差，以实现为准：
>
> 1. **心跳记录在正常退出时标记 `stoppedAt`，不删除**（§4.3 原写"删除"）。删掉会让
>    workspace 在它的 scheduler 消失的那一刻从全局视图里消失——恰好是最需要看见它的
>    时候。记录同时承担 workspace 注册表的职责，只在 30 天无人触碰后由写入方清理。
> 2. **`cancel` 必须同步写 checkpoint 的 `stopReason`**。只取消 wake 会留下
>    "checkpoint 说 parked + 队列空"——正是 `orphaned` 的判据，于是主动停止的任务会
>    永久亮红，和事故态无法区分。
> 3. **TUI 里的不健康提示不内联恢复命令**。绝对路径 + 完整 UUID 放不进任何终端宽度，
>    截断后的命令看起来能复制、其实不能。完整命令在 `tasks show` 里。
>
> 另新增 §7 未列的 `tasks rm`：删除 checkpoint + wake 记录 + steer 队列 + 会话历史，
> 不可恢复，运行中拒绝执行。无自动清理——系统在无人注视时删数据是危险默认值。

## 1. 背景

`auto + self_timer` 的长周期任务已经成为常态：一个会话可以跨十几个小时、几十次
park/resume，横跨多个 workspace 和多个 provider profile。但目前对这些任务的全部
可观测手段，只有 `auto-scheduler` 打到 stderr 的几行日志，关掉终端就没有了。

直接动机是 2026-08-17 的一次事故：某会话 park 46 分钟后被围栏误判，wake 被标记
`cancelled`（终态），scheduler 随即因队列为空而正常退出。**全过程日志没有任何一行
看起来像失败**——`done`、`cancelled`、"本工作区已无待处理的 Auto 唤醒"，形态上
和一次正常收尾完全一致。人是在半小时后凭直觉发现"感觉上面没结束"的。

围栏那个 bug 已经修了，但事故暴露的真正缺口不是那个 bug：**系统没有任何地方能回答
"我的任务现在还活着吗"**。这个方案要补的是这个。

## 2. 目标与非目标

**目标**

- 一屏看清所有长周期任务的存活状态，尤其是识别"已经死了但看起来正常"。
- 少量安全操作：立即执行、取消、终止运行中的 turn、发送纠偏。
- 跨 workspace 统一视图。
- 全屏 TUI，随终端而生，SSH 上等价可用。

**非目标**

- 不做网页前端、不做原生桌面 app、不引入端口和鉴权。
- 不在本方案中改动调度拓扑（是否改常驻全局 daemon 留待后续）。
- 不做历史回放 / 指标图表 / 多用户协作。
- TUI 不接管任务执行（见 §5 铁律）。

## 3. 现状盘点

### 3.1 数据分布

| 数据 | 位置 | 说明 |
|---|---|---|
| wake 记录 | `<workspace>/.meta-agent/auto/wakes/*.json` | `AutoContinuationRecord`，file-per-record + 目录锁 |
| auto checkpoint | `<workspace>/.meta-agent/auto/checkpoints/<sessionId>.json` | goal / 待办 / 成本 / stopReason / pendingWake |
| 纠偏队列 | `<workspace>/.meta-agent/steer/<sessionId>/*.json` | 一消息一文件，无锁 |
| 会话历史 | `~/.meta-agent/sessions/<sessionId>/history.jsonl` | 全局，非 per-workspace |
| 会话索引 | `~/.meta-agent/sessions/index.json` | **上限 50 条且会驱逐** |

### 3.2 可直接复用的能力

- `AutoContinuationStore.list()` **不取目录锁**（走 `listUnlocked`），UI 高频轮询
  不会和 scheduler 抢锁。
- `schedule()` 对同一 session 只保留一条 `pending` 记录，天然是"一个 session 一行"。
- 已有变更操作：`cancel(wakeId)`、`cancelSession(sessionId)`、`expireStale()`、`prune()`。
- 纠偏通道已存在：`meta-agent steer <sessionId> "..."`，写文件即可，无需进程间协议。
- 终端基建：`cli/term.ts`（颜色、`isTTY`、`installBrokenPipeGuards`、`safeStdoutWrite`）、
  `cli/attachedSteer.ts`（raw mode 的正确用法与 Ctrl+C 陷阱的现成范本）。

### 3.3 三个缺口

1. **跨 workspace 发现**：wake 是 per-workspace 的，没有任何全局索引。会话索引不能
   用——50 条上限且会驱逐，而长跑任务正是最容易被挤掉的那批。
2. **"立即执行"原语**：`release(..., 'pending', fireAt)` 只服务已 claim 的记录（需要
   token）。未 claim 的 pending 记录没有改 `fireAt` 的入口。
3. **scheduler 存活性未知**：pending wake 挂着但该 workspace 根本没有 scheduler 在跑
   时，它会静静躺到 `staleWakeMs`（默认 7 天）才被 `expired`。这是第二种"看起来正常
   的死法"，目前同样不可见。

## 4. 核心模型

### 4.1 任务的单位是 session，不是 wake

wake 是一次性的调度凭据，用完即终态；一个长周期任务在其生命周期里会产生几十条 wake。
UI 的一行必须是 **session**，wake 只是这一行的当前状态来源。session 的身份信息
（goal、进度、成本）全部来自 checkpoint。

### 4.2 四态判据

对每个 `(workspace, sessionId)`，联合 wake 记录与 checkpoint 推导：

| 状态 | 判据 |
|---|---|
| 🟢 `running` | 存在 `claimed` 记录且 `claim.expiresAt > now` |
| 🟡 `parked` | 存在 `pending` 记录且 `fireAt > now`（展示 ETA） |
| 🔴 `orphaned` | checkpoint `stopReason == 'parked'`，但该 session **既无 pending 也无有效 claimed** |
| ⚪ `finished` | 无活动 wake，且 checkpoint `stopReason != 'parked'` |

**🔴 是整个方案的核心产出。** 它恰好是 8-17 事故的稳态形态，且纯本地文件即可判定，
不需要任何新基础设施。有它的话，13:24 就会看到一个红行，而不是靠人在一小时后察觉。

补充两个降级态：

- `overdue`：存在 pending 且 `fireAt <= now` 超过一个宽限窗（建议 2×poll + 60s）仍未被
  claim —— 说明该 workspace 的 scheduler 不在或卡住。
- `stale-claim`：存在 claimed 但 `claim.expiresAt < now` —— 执行进程已崩，等待
  `reconcileOrphans` 回收。

### 4.3 scheduler 存活性

新增 `~/.meta-agent/schedulers/<hash(workspace)>.json`：

```jsonc
{ "workspace": "/Users/x/proj", "pid": 64918, "host": "mbp.local",
  "startedAt": 1786938713801, "lastSeen": 1786944251722,
  "pollIntervalMs": 1000, "maxConcurrent": 1, "configFile": "~/.meta-agent/glm_config.json" }
```

由 `runAutoSchedulerCommand` 启动时写入、轮询循环中刷新 `lastSeen`（复用现有 poll
节拍，不新增定时器），正常退出时删除。`lastSeen` 超过 `3×pollIntervalMs` 视为失联。

一举三得：解决跨 workspace 发现、补上 §4.2 的 `overdue` 判据、并且无论将来是否改成
全局 daemon 都用得上——**这是本方案里唯一与调度拓扑相关但对两种拓扑都中立的改动**。

## 5. 分层架构

```
┌─────────────────────────────────────────────┐
│  L3  TUI 壳（meta-agent tasks）              │  可替换
├─────────────────────────────────────────────┤
│  L2  CLI 契约（tasks list/show/run-now/…）   │  --json，稳定
├─────────────────────────────────────────────┤
│  L1  读模型 + 变更原语（TaskRegistry）        │  纯函数 + store 操作
├─────────────────────────────────────────────┤
│  L0  现有持久化（wakes / checkpoints / steer）│  不改语义
└─────────────────────────────────────────────┘
```

**铁律：L3 永远不 spawn turn。**

"立即执行"= 把 pending wake 的 `fireAt` 改成 `now`，运行中的 scheduler 在一个 poll
周期内自然接管。理由有三：

1. 执行路径唯一。UI 自己拉起进程等于第二条执行路径，claim/lease 协议立刻要在两处维护。
2. UI 不需要知道该用哪个 bin。当前 wake 的 `runtime` 是空对象，**不记录自己属于哪个
   provider profile**；靠"人记得用 `meta-agent-glm`"兜底。UI 一旦能拉起进程，这个隐含
   约定必然被破坏（见 §7）。
3. 无 API key 依赖。TUI 可以在没有任何 provider 凭据的环境里运行。

## 6. 数据契约

L1 输出的唯一结构，L2/L3 都只消费它：

```ts
interface TaskView {
  workspace: string
  sessionId: string
  status: 'running' | 'parked' | 'orphaned' | 'finished' | 'overdue' | 'stale-claim'
  goal?: string                    // checkpoint.goal
  note?: string                    // checkpoint.note
  wake?: {                         // 当前活动 wake（pending 或 claimed）
    wakeId: string
    fireAt: number
    reason: string
    attempts: number
    checkpoint?: Record<string, unknown>
    claim?: { owner: string; expiresAt: number }
  }
  lastOutcome?: 'done' | 'cancelled' | 'expired'   // 最近一条终态 wake
  progress: {
    turnCount?: number
    estimatedCostUsd?: number
    completedSteps: string[]
    pendingTodos: string[]
  }
  health: {                        // checkpoint 上的运行健康计数
    compactions?: number
    driftCorrections?: number
    verifyRejections?: number
  }
  scheduler: { alive: boolean; pid?: number; lastSeen?: number }
  pendingSteerCount: number
  updatedAt: number                // checkpoint.updatedAt
}
```

字段全部来自现有文件，无一需要新增写入点（除 §4.3 的心跳）。

L2 命令面：

```
meta-agent tasks list  [--json] [--all] [--workspace <dir>]
meta-agent tasks show  <sessionId> [--json]
meta-agent tasks run-now <sessionId>
meta-agent tasks cancel  <sessionId>       # 取消 pending wake（安全）
meta-agent tasks kill    <sessionId>       # 终止运行中的 turn（破坏性）
meta-agent tasks steer   <sessionId> "..." # 复用现有 steer 通道
```

`tasks list --json` 是整个方案的对外契约，先于 TUI 完成并单独验证。

## 7. 新增存储原语

**`AutoContinuationStore.fireNow(wakeId): Promise<boolean>`**
取锁 → 读记录 → 仅当 `status === 'pending'` 时写回 `fireAt = now`。claimed 记录直接
返回 false（正在跑，无需催）。约 20 行。

**取消语义必须在 UI 上区分**（现有 `cancel(wakeId)` 在不传 token 时会连 `claimed`
记录一并取消）：

- `cancel`：目标是 pending 记录 → 纯队列操作，无副作用。
- `kill`：目标是 claimed 记录 → 记录转 `cancelled` 后，执行进程的 heartbeat 会发现失主
  并 `abort('claim lost')`，**中断正在进行的模型 turn**。这是真正的破坏性操作，需要
  二次确认，且必须与 `cancel` 用不同按键。

**前置债 —— `runtime` 自描述。** `armAutoContinuation` 目前只记录 model/baseUrl/
maxTurns 等 CLI 显式传入的值；用配置文件选 provider 时它们全是 `undefined`，恢复时
落到执行进程自己的配置上。必须补记 `configFile`（或 argv0），否则任何"重启/立即执行"
类操作在多 profile 环境下都是错的。**这是 §6 中 `run-now` 落地前必须还清的债。**

## 8. TUI 设计

### 8.1 布局

```
 meta-agent tasks                              3 running · 2 parked · 1 ORPHANED
 ─────────────────────────────────────────────────────────────────────────────
 ●  X1_29_AMP        9bf2297f  🟡 parked    →16:10:34 (in 24m)   $13.36  209t
    v20 门控 ~15:57-16:05 出结果；PASS 则守到 ~19:00
    ▸ roboparty_train   3a1f88c2  🟢 running   turn 12  1m42s     $2.10   12t
    ▸ meta_agent_rt     7c02de19  🔴 ORPHANED  parked 46m ago, no wake ⚠
    ▸ sim2sim_eval      b41e9903  ⚪ finished   done 2h ago        $0.87   31t
 ─────────────────────────────────────────────────────────────────────────────
 goal      持续推进X1 AMP训练，先定义GMR重定向验收…
 待办 6    · v19 训练监控（4000 iter）
           · 创建 sim2sim 独立任务
 健康      compactions 1 · drift 0 · verify-reject 0 · scheduler ✓ pid 64918
 ─────────────────────────────────────────────────────────────────────────────
 ↑↓ 选择  ⏎ 详情  r 立即执行  c 取消  K 终止  s 纠偏  a 显示全部  / 过滤  q 退出
```

上半列表、下半详情、底部键位提示。顶栏是唯一需要"瞥一眼"的信息：有没有 ORPHANED。

### 8.2 键位

| 键 | 动作 | 备注 |
|---|---|---|
| `↑`/`↓`、`j`/`k` | 移动选择 | |
| `⏎` | 展开/收起详情 | |
| `r` | 立即执行 | 仅 parked；改 `fireAt` |
| `c` | 取消 wake | 仅 pending；单次确认 |
| `K` | 终止运行中的 turn | 大写，破坏性，二次确认 |
| `s` | 发送纠偏 | 唤起单行输入，写 steer 文件 |
| `a` | 显示/隐藏 finished | 默认隐藏终态 |
| `/` | 过滤（workspace/goal 子串） | |
| `q`、`Ctrl+C` | 退出 | 恢复终端状态 |

### 8.3 渲染策略

- **备用屏缓冲**：进入 `\x1b[?1049h` + 隐藏光标，退出时严格对称还原；`process.on('exit')`
  同步还原，避免异常退出留下坏终端。
- **全量重绘**，不做差分。行数是任务数（几十行量级），1s 一帧的全量重绘成本可忽略，
  换来的是没有脏矩形 bug。
- **不引 Ink/React**。本项目运行时依赖只有 `@anthropic-ai/sdk` / `openai` / `zod` 三个，
  且以 esbuild 打成单文件 CLI；为一个列表界面引入 React 运行时与其洁癖不符。手搓
  ANSI 约 400–600 行，且 `attachedSteer.ts` 已经趟平了 raw mode 的所有坑。
- **raw mode 必须自行补发 SIGINT**：raw 模式下 tty 不再把 `^C` 变成信号，而是投递
  字节 `0x03`。`attachedSteer.ts` 的做法（识别 ETX 后 `process.emit('SIGINT')`，dispose
  时还原 stdin 原状）直接照搬。
- **复用 `installBrokenPipeGuards()` 与 `safeStdoutWrite()`**，`meta-agent tasks | head`
  不应报错。
- **非 TTY 降级**：`!isTTY` 时 `tasks` 自动等价于 `tasks list`，打印一次即退出，
  使其在管道和 CI 中可用。

### 8.4 刷新与并发

- 默认 1s 轮询（`--refresh-ms` 可调）。读路径全程不取锁：`store.list()` 本就是无锁读，
  checkpoint 与心跳文件都是原子写，读到的永远是某个完整版本。
- 单次刷新的 IO = 每 workspace 一次 `readdir` + N 次小文件 `readFile`。任务规模到三位数
  之前无需优化；真到那一步再加 mtime 短路。
- 不用 `fs.watch`：跨平台语义不一致（尤其网络卷与容器挂载），而 1s 轮询对本场景完全够。
- 写操作全部经 L1 走既有锁，与 scheduler 的并发安全性不变。

## 9. 分阶段落地

**P0 —— 让死亡可见**（不碰调度逻辑，不影响正在跑的任务）

1. scheduler 心跳注册表（§4.3）
2. `TaskRegistry` 读模型 + 四态判据（§4.2、§6）
3. `meta-agent tasks list --json`

验收：对 8-17 那次事故的现场文件跑一遍，`tasks list` 必须把该 session 判为 `orphaned`。
这一步产出的 JSON 契约无论最终壳是什么都不作废。

**P1 —— 全屏 TUI**

4. 只读 TUI（列表 + 详情 + 刷新 + 过滤）
5. `runtime` 自描述补记（§7 前置债）
6. `fireNow` 原语 + `run-now` / `cancel` / `kill` / `steer` 四个动作接入

**P2 —— 可选增强**

7. 状态跃迁提示：进入 `orphaned` 时终端响铃 + 顶栏高亮（跨平台，不依赖系统通知）
8. scheduler 事件日志落 JSONL，详情面板展示最近 N 条（补上"关了终端就没有历史"）
9. 视需要再评估是否改常驻全局 daemon

## 10. 风险与未决

- **判据误报**：`orphaned` 依赖 checkpoint 的 `stopReason`。若某条路径 park 成功但
  checkpoint 写失败，会误判。现有代码在这种情况下会拒绝 arm 并报错（park 持久化失败即
  不 arm），因此该组合应不可达——需在 P0 阶段用测试固化这个前提。
- **workspace 发现的完整性**：心跳表只登记"启动过 scheduler 的 workspace"。从未起过
  scheduler、或用 `--attached` 跑的任务不在表内。P0 先接受这个边界，UI 上明确标注
  "仅显示已注册 workspace"，必要时再加手工 `tasks add-workspace`。
- **`kill` 的语义强度**：它中断的是模型 turn，工作区已发生的文件修改不会回滚——与
  `Ctrl+C` 中断 attached 运行一致。UI 文案必须说清，不能让人以为是"撤销"。
- **多机**：心跳记录了 `host`，但跨机器的文件系统视图不共享。本方案只覆盖单机；多机
  需要真正的中心化状态，属于 daemon 决策的一部分。

## 附：涉及文件

```
新增
  src/core/auto/SchedulerRegistry.ts      心跳注册与发现
  src/core/auto/TaskRegistry.ts           读模型 + 四态判据
  src/cli/commands/tasks.ts               L2 命令面
  src/cli/tui/                            TUI 渲染与键位
修改
  src/core/auto/AutoContinuationStore.ts  + fireNow()
  src/cli/sessionFlow.ts                  armAutoContinuation 补记 runtime.configFile
  src/cli/singleTurn.ts                   runAutoSchedulerCommand 写/刷新心跳
  src/cli/args.ts                         tasks 子命令解析
```
