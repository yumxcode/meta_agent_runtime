# Loop 管理面板 —— 接口方案

状态：设计稿，待评审
日期：2026-07-28
范围：跨 workspace（全机器）· 本地 HTTP + SSE · 读 + 安全控制

---

## 1. 目标与非目标

**目标**

- 一个地方看到这台机器上**所有** graph loop 实例：已创建 / 运行中 / 已停止 / 已完成。
- 回答四个高频问题：现在跑到哪了、为什么不动了、花了多少、出了什么错。
- 支持安全的干预：暂停、恢复、停止、投递外部事件。
- 支持「再次运行」——但这个词有三种不同语义，见 §7，面板必须区分。

**非目标（第一版）**

- 不做 `create` / `recover` / `archive` / `gc`。这些会创建实例、搬目录、删数据，
  锁与误操作语义比读复杂一个量级，先留在 CLI（§8 分期里给了接入路径）。
- 不做远程访问、多用户、RBAC。绑定 loopback。
- 不做图编辑（distill 是另一条产品线）。
- **不做 scheduler**。面板不驱动执行，只观测和发指令；`tick` 仍由 daemon /
  `loop-scheduler` 负责。理由见 §6.3。

---

## 2. 现状盘点

比预想的好：底层能力基本齐了，缺的是**聚合**和**传输**。

### 2.1 已经能直接复用

| 能力 | 现状 |
|---|---|
| 实例列表 | `listGraphInstanceRecords(projectDir)` 扫 `<projectDir>/.loop/*/instance.json` |
| 实例详情 | `loop inspect --json` → `loop-inspect-1.0`，已含 state / activationCounts / cost / wakes / activePhases / reliability / diagnostics |
| 时间线 | `loop timeline --json` |
| 磁盘占用 | `loop disk --json` → `loop-disk-1.0`，分区 + 指标 |
| 外部事件 | `loop events --json` → `loop-events-1.0` |
| 生命周期 | `pause` / `resume [--run]` / `stop`，均已实现且带 wake 清理 |
| 事件投递 | `loop event` + `deliverGraphEvent`，**已有 source/deliveryId 幂等去重** |
| 主机资源 | `HostSchedulerCoordinator.snapshot()` → workspace 租约 / graph_tick / model_call 配额 |
| 熔断器 | `ProviderCircuitBreaker.snapshot()` |
| 事件流底座 | `graph/journal/` 是 append-only、单调序号的 JSON 文件序列 —— 天然适合 SSE |

`GraphInstanceRecord` 本身就带 `workspaceId` + `projectDir`，跨 workspace 聚合的数据基础已经在了。

### 2.2 缺的三样

**C1. 没有 workspace 台账。** 发现逻辑是 `listGraphInstanceRecords(projectDir)`，
必须先知道 projectDir。`HostSchedulerCoordinator` 的 `workspaces/` 目录记的是
**租约**（`WorkspaceSchedulerLease`，带 `expiresAt`，scheduler 一停就过期被回收），
它回答的是「谁在跑」，不是「机器上有哪些 workspace」。→ §3.1 新增。

**C2. 没有 HTTP 层。** 全仓库无 `createServer`。生产依赖只有
`@anthropic-ai/sdk` / `openai` / `zod`，所以用 `node:http` 手写，不引框架。

**C3. 部分命令没有 `--json`。** `pause/resume/stop`、`event`、`schedulers`、
`host-capacity` 目前只返回给人看的字符串。面板不该去解析这些字符串。

---

## 3. 架构

三层，自下而上：

```
┌─ HTTP/SSE 层  (src/loop/admin/LoopAdminServer.ts)
│    node:http，REST + text/event-stream，loopback + token
├─ Admin Core   (src/loop/admin/LoopAdminApi.ts)
│    纯 TS 类，无 HTTP 依赖。聚合、派生状态、动作编排
│    ← CLI 也可以直接用它（loop list --all-workspaces）
└─ 现有底座
     WorkspaceRegistry(新) · GraphStore · WakeStore
     HostSchedulerCoordinator · ProviderCircuitBreaker
```

**分层理由**：Admin Core 不碰 HTTP，所以它同时能被 CLI、未来的 MCP 工具、
或 Electron 主进程直接 import。HTTP 只是它的第一个前端。

### 3.1 WorkspaceRegistry（新增，解决 C1）

位置：`$META_AGENT_HOME/loop/workspaces.json`（即 `metaAgentPath('loop','workspaces.json')`）

```ts
interface LoopWorkspaceEntry {
  workspaceId: string          // 来自 ensureWorkspaceIdentity
  workspaceRoot: string        // canonical 绝对路径
  firstSeenAt: number
  lastSeenAt: number
  label?: string               // 面板可编辑的别名，默认取 basename
}
interface LoopWorkspaceRegistry {
  schemaVersion: 'loop-workspaces-1.0'
  workspaces: LoopWorkspaceEntry[]
}
```

**写入点**（两处，都是已存在的路径，改动很小）：

- `loop create` 成功后 upsert
- `loop tick` 拿到 workspace lease 后 upsert（刷新 `lastSeenAt`）

**自愈**：读取时若 `<workspaceRoot>/.loop` 不存在 → 标记 `stale`，列表里灰显，
提供一键移除。**不自动删**——外置磁盘没挂载、仓库临时 move 走都是正常情况，
静默丢失条目比留个灰条目更糟。

**并发**：沿用 `infra/persist` 的 `atomicWriteJson` + 现有 session lock 模式。

> 备选方案（评估后未采用）：扫描文件系统找 `.loop` 目录。全盘扫太慢，
> 限定几个根目录又要用户配置，不如在已经必经的两个写入点登记。

---

## 4. 数据模型

### 4.1 派生运行态 —— 本方案的核心概念

`GraphInstanceRecord.status` 只有 `active | waiting | paused | done | exhausted | failed`，
**它不足以回答「现在到底在不在跑」**。一个 `status=active` 的实例，如果没有
scheduler 在 tick 它的 workspace，它就是躺着不动的——而这恰恰是最常见的
「我的 loop 怎么不动了」的原因，raw status 完全看不出来。

所以 Admin Core 把三个来源 join 起来，产出 `runtimeState`：

| runtimeState | 判定 | 面板语义 |
|---|---|---|
| `running` | active/waiting + workspace 有**未过期**的 scheduler 租约 + 存在 `running` 状态的 activation | 真的在跑 |
| `stalled` | active/waiting + 有 pending 且 `fireAt <= now` 的 wake + **没有**存活 scheduler | ⚠️ **该跑但没人跑** —— 高亮，给「启动 scheduler」指引 |
| `sleeping` | active/waiting + 最近的 wake `fireAt > now` | 定时 park 中，显示倒计时 |
| `blocked` | 有 `blockedFailure`，或存在 blocked 的 activation | 需要人介入 |
| `paused` | status=paused | 人为暂停 |
| `done` / `exhausted` / `failed` | 同名 status | 终态 |

数据来源：`GraphStore.snapshot()` × `WakeStore.list()` × `HostSchedulerCoordinator.snapshot()`。

`stalled` 是这个面板最有价值的一个格子——目前 CLI 上要 `loop inspect` +
`loop schedulers` 两条命令对着看才能推出来。

### 4.2 资源

```
Workspace        1 ── n  Instance
Instance         1 ── n  Activation
Instance         1 ── n  Wake / ExternalEvent / JournalEvent
Host             1 ── n  SchedulerLease / ProviderCircuit
```

---

## 5. HTTP 接口

约定：

- 前缀 `/api/v1`，全部 `application/json; charset=utf-8`
- 每个响应体带 `schemaVersion`，沿用现有 `loop-*-N.N` 命名习惯，与 CLI `--json` 复用同一 shape
- 错误统一 `{ schemaVersion: 'loop-error-1.0', error: <code>, message, ...ctx }`，
  code 用现有 `instance_not_found` 这类蛇形串
- 时间一律 epoch ms（与底层记录一致，不做本地化——那是前端的事）
- 金额字段保留 `costUsd`，并在 A0.1 埋点落地后追加 token 字段（§9）

### 5.1 读

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/v1/health` | 版本、启动时间、注册表条目数 |
| GET | `/api/v1/workspaces` | 台账 + 每个 workspace 的实例计数、聚合成本、是否 stale、是否有存活 scheduler |
| GET | `/api/v1/instances` | **面板主列表**。跨 workspace 聚合。见下 |
| GET | `/api/v1/instances/{workspaceId}/{instanceId}` | 详情 = `loop-inspect-1.0` + `runtimeState` |
| GET | `.../timeline?limit=&before=` | 时间线，分页 |
| GET | `.../activations?status=` | activation 列表（含 `usage`） |
| GET | `.../events?status=pending\|consumed` | 外部事件 |
| GET | `.../disk` | `loop-disk-1.0` |
| GET | `.../graph` | 冻结的 LoopGraphSpec（面板画 DAG 用） |
| GET | `.../journal?from={seq}&limit=` | 原始 journal 分页（SSE 断线补齐用） |
| GET | `/api/v1/host` | scheduler 租约 + graph_tick/model_call 配额 + provider 熔断状态 |

`GET /api/v1/instances` 查询参数：
`?workspaceId=&status=&runtimeState=&graphId=&q=&sort=updatedAt|cost|createdAt&order=&limit=&cursor=`

列表项（刻意做薄，详情另取）：

```jsonc
{
  "workspaceId": "ws-e9ad66c3…",
  "workspaceLabel": "F1_train_AMP",
  "instanceId": "amp_loop-v1",
  "graphId": "amp_loop", "graphVersion": 1,
  "status": "exhausted",
  "runtimeState": "exhausted",
  "statusReason": "maxWallTimeMs 172800000 exhausted",
  "createdAt": 1784874164930, "updatedAt": 1785115301014,
  "activationCount": 7,
  "cost": { "usedUsd": 1.6174, "maxUsd": 200 },
  "progress": { "phase": "amp_training", "iteration": 3 },   // state.values 的白名单投影
  "activeNodes": ["research"],
  "nextWakeAt": null,
  "recovery": { "sourceInstanceId": "amp_loop-v1" }           // 是 fork 才有
}
```

`progress` 取 `state.values` 的**白名单**投影（graph 可在 annotations 里声明
哪些 key 适合展示），避免把整个 state 塞进列表——AMP 那个 `findings_summary`
单条就有几 KB。

### 5.2 控制（第一版仅这四个）

| Method | Path | Body | 语义 |
|---|---|---|---|
| POST | `.../pause` | `{reason?}` | → paused，并 `cancelForLoop` 清 wake |
| POST | `.../resume` | `{reason?, run?: false}` | → active，重排 wake，重置 provider 熔断 |
| POST | `.../stop` | `{reason?}` | → failed（**终态，不可逆**），清 wake |
| POST | `.../events` | `{name, payload?, correlation?, source, deliveryId}` | 投递外部事件唤醒 park |

四个都直接映射到已验证过的现有实现，不新写状态机。

**约束**

- `stop` 是不可逆的（底层就是 `setStatus('failed')`）。要求 body 里带
  `confirm: "<instanceId>"`，否则 409。这是 UI 误点的唯一防线。
- `resume` 的 `run: true`（对应 CLI `--run`，会同步跑到 quiescent）**第一版禁用**——
  见 §6.3，面板不当 scheduler。
- `POST .../events` 的 `source` + `deliveryId` **必填**。底层已有幂等去重；
  强制填写意味着面板重复点击天然安全，而不是靠前端防抖。建议
  `source: "admin-panel"`、`deliveryId: <uuid v4，前端生成并在重试时复用>`。

---

## 6. 事件流

### 6.1 SSE

```
GET /api/v1/stream?workspaceId=&instanceId=&from={seq}
Accept: text/event-stream
```

- 不带筛选 = 订阅全机器（面板列表页实时刷新）
- `from` 给断线重连补齐；同时响应 `Last-Event-ID` 头，`id:` 用
  `{workspaceId}:{instanceId}:{sequence}`
- 事件类型直接透传 journal 的 union：`graph_created` / `activation_claimed` /
  `activation_released` / `activation_blocked` / `activation_committed` /
  `graph_status_changed` / `paused_terminal_resumed` / `external_event_recorded` /
  `external_event_consumed`
- 另外合成两类面板专用事件：
  - `runtime_state_changed` —— 派生态变化（尤其 `→ stalled`，这个 raw journal 里没有）
  - `heartbeat` —— 15s 一次，保活并携带 host 配额快照

### 6.2 采集方式

第一版：**轮询 `journal-sequence.json` + 增量读**。每个被订阅的实例记住 last seq，
默认 1s 检查一次（可配）。理由：跨平台可靠、无 fd 泄漏风险、journal 本来就是
单调序号，增量读天然正确。

`fs.watch` 作为后续优化项——它在网络盘 / Docker bind mount 上不可靠，
而 loop 恰恰常跑在挂载卷上。**先正确，再快。**

### 6.3 为什么面板不做 scheduler

技术上可以让面板进程持有 `daemon.lock` 并 tick。不做，三个理由：

1. `acquireDaemonLock` 是 workspace 独占的。面板一开就抢锁，
   会让用户手动 `loop tick` 直接失败（"another scheduler owns this workspace"），
   这个耦合很难向用户解释。
2. 面板是个可以随时关掉的观测工具；调度是长期任务。生命周期不匹配。
3. 关掉面板 = 停掉所有 loop，是个危险的意外后果。

所以面板对 `stalled` 实例的正确做法是**告诉用户怎么起 scheduler**
（显示 `meta-agent loop-scheduler` 命令并支持复制），而不是自己代劳。

---

## 7. 「再次运行」的三种语义

这是原始需求里最需要拆开的一点。CLI 里已经是三条不同的命令，面板不能糊成一个按钮。

| 意图 | 底层 | 实例 ID | 历史 | 可用前提 |
|---|---|---|---|---|
| **继续**：暂停的接着跑 | `loop resume` | 不变 | 保留 | status = `paused` |
| **重跑**：终态的从某步再来 | `loop recover` | **新** `<id>-r1` | 从源实例某个 activation 分叉 | status ∈ `done`/`exhausted`/`failed` |
| **新开**：同一张图跑一遍全新的 | `loop create --id` | 新 | 空 | 任意 |

`recover` 会**创建新实例**（那个 `-r1` 后缀，在 AMP 样本的 session 目录里能看到
`amp_loop-v1-r1-lane-research`），不是原地重启。面板 UI 上应该显示为
「从 X 派生」而不是「重新运行 X」，列表里用 `recovery.sourceInstanceId` 画出血缘。

第一版只开放**继续**。**重跑**和**新开**在 UI 上给按钮，但点击后展示对应的
CLI 命令供复制（`loop recover <id> --from <activationId>`）——因为
`recover` 的 `--from` / `--force` 语义需要人理解自己在做什么，
包成一个按钮反而危险。§8 第三期再评估是否直接执行。

---

## 8. 分期

**P0 — 数据面（无 HTTP，可独立验收）**

1. `WorkspaceRegistry` + `loop create` / `loop tick` 两个写入点
2. `LoopAdminApi`：`listWorkspaces` / `listInstances` / `getInstance` /
   `getHost` + `runtimeState` 派生
3. `loop list --all-workspaces --json` 直接暴露 P0 成果 —— **CLI 先受益，
   而且给了 Admin Core 一个不依赖前端的测试入口**

**P1 — HTTP 读 + SSE**

4. `LoopAdminServer`（`node:http`），§5.1 全部读接口
5. `/api/v1/stream`，journal 增量轮询
6. `meta-agent loop serve [--port 7717] [--token …]`

**P2 — 安全控制**

7. `pause` / `resume` / `stop` / `events` 四个 POST
8. 给 CLI 的 `pause/resume/stop/event/schedulers/host-capacity` 补 `--json`（解决 C3）

**P3 — 待评估**

9. `recover` / `create` 的面板化（需要先想清 §7 的 UI 表达）
10. `archive` / `gc`（需要 daemon.lock 归属方案）
11. `fs.watch` 替换轮询

---

## 9. 与 token 审计的衔接

`docs/reviews/graph-loop-token-cost-audit-2026-07-27.md` 的 **A0.1 埋点**
（把 `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens` 透传进
`ActivationUsage`）尚未实施。**建议排在 P0 之前或并行**：

- 面板最有价值的一屏是「哪个节点在烧钱」，而 `costUsd` 是按定价表算的估值，
  不等于订阅套餐的扣减口径；
- 埋点一旦落地，`.../activations` 直接多出 token 维度，接口不用改版
  （新增字段全部可选，向后兼容）；
- 反过来，面板也是这些数据的第一个真正消费者 —— 没有面板，埋点数据只能靠 grep 文件看。

面板上建议直接呈现：每实例 token 累计、每节点 token/turn 趋势、cache 命中率。
cache 命中率尤其有用——按 §R5，它会在每次 park 之后掉下去，图上能一眼看出来。

---

## 10. 待定

1. **鉴权强度**：loopback + 启动时生成一次性 token（写 `$META_AGENT_HOME/loop/serve.json`，
   `chmod 600`），够不够？还是要 origin 校验 + CSRF？取决于面板是浏览器打开还是 Electron 内嵌。
2. **`progress` 白名单**：靠 graph `annotations` 声明，还是 Admin Core 用启发式
   （挑标量、跳过长字符串）？前者干净，但要改所有现有图。倾向：**启发式兜底 + annotations 覆盖**。
3. **多实例并发上限**：面板同时订阅 50 个实例的 journal 轮询是否需要背压？
4. **归档实例**：`.loop/archive/` 下的要不要出现在列表里（只读、灰显）？倾向要——
   「已停止的图」在用户心智里包含已归档的。
