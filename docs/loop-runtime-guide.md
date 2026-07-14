# 通用长周期 Loop 机制与使用指南

> 本文描述当前已实现的 `legacy-round-v1` Runtime。下一代“Distill 生成任意受约束图、Execution Lane 承载强相关节点”的目标方案见 [Durable Graph Loop Runtime 重构方案](loop-durable-graph-runtime-plan.md)。

本文描述当前 `auto_orch v2` 的实际实现。它已经从“Research Loop Kernel + 通用执行器”调整为：

```text
通用 Loop Kernel
├── builtin/research@1
├── builtin/generic@1
├── builtin/release@1
├── builtin/compliance@1
└── 显式加载的 ScenarioPluginV1
```

Kernel 不理解 finding、release note 或 compliance bundle 等业务概念。它只负责长周期控制、持久化、并发和恢复；Artifact 结构、场景 gate、胶囊视图、等待绑定和报告呈现由 Scenario 提供。

## 1. 适用范围

Loop 用于需要跨多个独立 Agent round 推进，且必须具备预算、审计、中断恢复和人工介入能力的任务。例如：

- Research：产生 finding、方向去重、独立 judge；
- Release：每轮生成 release manifest 与 release note；
- Compliance：生成合规包并等待外部人工批准；
- Generic：由 Charter 自行声明 Artifact；
- 自定义插件：安全评审、数据治理、部署验收等新的业务语义。

一次普通 `agentic/auto` 会话解决一个连续上下文内的任务；Loop 位于会话之上，每个 seat 可以重新创建，跨 round 的真相只来自磁盘账本和胶囊。

## 2. 固定 Kernel 与可插拔 Scenario

### Kernel 固定职责

- Wake 的调度、claim、租约续期和 fencing；
- `RECONCILE → MODE → CAPSULE → SEAT → GATE → METER → LEDGER → ROUTE`；
- round、progress、effect、Artifact transaction 的权威持久化；
- 预算、tripwire、pause/resume/stop/migrate；
- inbox/event 的有界读取与精确一次消费；
- 单机全局并发、workspace 公平性和资源读写锁；
- kill -9 后的幂等恢复。

### Scenario 可扩展职责

- 默认 Artifact 声明及其 gate；
- worker 输出契约和 Scenario producer gate；
- 跨 round 的有界 Capsule view；
- 外部 effect wait 的绑定；
- 最终/attention 报告的业务呈现；
- 可重建的兼容 read model。

Scenario 不能替换 Kernel 的路由、账本提交顺序、Wake 所有权或 Artifact transaction。插件是显式加载的可信 Node.js 代码，不是安全沙箱；应像运行时依赖一样审核。

## 3. 每个 round 的状态机

```text
WAKE/CLAIM
  → RECONCILE       修复 orphan wake、pending effect、Artifact checkpoint、终态尾部
  → MODE            消费一次性 pivot 指令，检查硬预算
  → CAPSULE         从账本 + inbox + Scenario view 确定性构建有界上下文
  → SEAT            worker；按需 pivoter / judge / finalizer
  → GATE            Kernel gate + Scenario gate，失败可进行有界纠偏重试
  → METER           从三态 observation 更新 meters
  → LEDGER          先提交 Artifact transaction，再写 RoundEntry/postState
  → ROUTE           continue / pivot / finalize / escalate
```

外部等待会把一个 round 拆成 submit 和 harvest 两段。`pending_round.json` 保存 round 身份、费用、lineage 摘要和本轮读取的 inbox 文件；进程退出后，event 或 effect poll 唤醒同一个 round。中间不会提前更新 meter，也不会重复运行 submit seat。

## 4. 长时程可靠性不变量

### 可恢复提交

- `RoundEntry.postState` 是重建 `progress.json` 的恢复点；progress 丢失或落后时从最后一个完整 round 重建。
- 若终态 round 已提交但报告、Wake cancel 或 `instance.json` 尚未写完，RECONCILE 只修复尾部，不创建新 seat。
- Artifact 使用 transaction id（`round:N`）去重。Scenario hook 在锁外执行；锁内只做 checkpoint 恢复、幂等检查和提交。
- migration 先把实例 fence 为 `migrating`，再写 recovery intent，最后原子地收敛 frozen charter、record、progress 和 audit；启动/加载会继续未完成迁移。
- frozen charter 的 SHA-256 必须与 instance record 一致；漂移时 fail closed。

### Wake 所有权

每次 claim 都有随机 token。heartbeat、release、费用转移以及 Kernel 的权威提交都校验 token。旧 owner 即使在租约过期后恢复运行，也不能覆盖新 owner 的结果。一个 workspace 内同一 loop 同时最多一个 live claim。

### 有界输入和内存

- inbox：每轮最多 32 个文件，每个最多 256 KiB；超限文件隔离为 `.oversize`；
- events：每次最多 256 个文件，每个最多 1 MiB；
- Artifact draft：单文件最多 8 MiB，每轮总计最多 32 MiB；
- Charter：最多 64 个 Artifact；
- Scenario async hook：默认 30 秒、返回值最多 1 MiB；hook 应响应传入的 `AbortSignal`；
- Effect：单事件最多 1 MiB，热历史每类最多保留 256 项，每实例最多 100,000 个 effect key；完整审计仍在 append-only journal；
- daemon 每小时清理过期终态 Wake，并按默认 30 天保留期清理已处理 inbox/event 文件。

达到硬上限会显式失败或隔离输入，不会静默截断权威业务数据。若一个实例预计超过 100,000 个 effect，应该按阶段滚动到新的 Loop instance。

## 5. 单机并发与公平性

`loop-scheduler` 在 workspace 内并发执行多个 round（默认 4），同时通过 host coordinator 对同一台机器上的所有 workspace 施加全局 admission：

- round 和 model call 各有全局上限；
- workspace 使用排队 ticket，繁忙 workspace 不能反复插队；
- 资源支持 shared/exclusive lease；较早的 exclusive waiter 会阻止后到 shared request 持续抢占；
- lease 带 token 和 TTL，旧 holder 不能删除新 lease；
- daemon 有 workspace identity 与 heartbeat，复制的 workspace 必须显式执行 `workspace-fork`。

查看运行状态：

```bash
meta-agent loop schedulers
meta-agent loop host-capacity
meta-agent loop workspace-info
```

## 6. 内置 Scenario

| Scenario ID | 用途 | 默认 Artifact / 特性 |
| --- | --- | --- |
| `builtin/research@1` | 研究迭代 | finding、direction、judge、方向去重 |
| `builtin/generic@1` | 自定义通用流程 | Artifact 由 Charter 声明 |
| `builtin/release@1` | 发布准备 | release manifest、versioned release note |
| `builtin/compliance@1` | 合规审批 | compliance bundle、外部 human approval wait |

查看当前进程实际加载的 Scenario：

```bash
meta-agent loop scenarios
meta-agent loop scenarios --scenario-plugin ./plugins/security-review.mjs
```

## 7. 最小使用流程

### 从需求生成并审核 Charter

```bash
meta-agent -w /path/to/workspace loop distill requirements.md --out charter.draft.json
# 人工审核 charter.draft.json
meta-agent -w /path/to/workspace loop create charter.draft.json
```

一个最小 Release Charter 示例：

```json
{
  "id": "prepare-release",
  "version": 1,
  "scenario": "builtin/release@1",
  "goal": "生成可发布的 manifest 和 release note",
  "observables": [],
  "meters": [{ "name": "iteration", "inc": "every_round" }],
  "tripwires": [{ "when": "iteration >= 3", "then": { "act": "finalize" } }],
  "gates": {},
  "seats": {
    "worker": {
      "context": "lineage_round",
      "prompt": "完成发布检查并写入 Scenario 要求的 drafts。",
      "tools": ["read_file", "edit_file", "bash"]
    }
  },
  "budgets": {
    "perRound": { "usd": 3 },
    "lifetime": { "rounds": 5, "usd": 15 }
  }
}
```

### 执行

```bash
# 只处理当前到期 Wake
meta-agent -w /path/to/workspace loop tick

# 一直处理到当前没有可推进工作
meta-agent -w /path/to/workspace loop tick --until-quiescent

# 长驻调度，多实例并发；空闲后退出
meta-agent -w /path/to/workspace loop-scheduler
```

### 观察与人工介入

```bash
meta-agent -w /path/to/workspace loop list
meta-agent -w /path/to/workspace loop inspect prepare-release-v1
meta-agent -w /path/to/workspace loop inbox prepare-release-v1 "优先解决签名校验失败"
meta-agent -w /path/to/workspace loop pause prepare-release-v1 --reason "等待变更窗口"
meta-agent -w /path/to/workspace loop resume prepare-release-v1
meta-agent -w /path/to/workspace loop stop prepare-release-v1 --reason "人工终止"
```

`pause` 不吞掉外部 event；`resume` 会从 durable state 重建所需 Wake。`paused_attention` 的轻量 resume 会重置触发 escalation 的 meter，避免立刻再次触发。

### Charter 升级

先把新版本写入 workspace CharterStore，再执行：

```bash
meta-agent -w /path/to/workspace loop migrate prepare-release-v1 --version 2
```

只允许同一 charter id 的更高版本，且实例必须处于 `idle` 或 `paused_attention`。meter 按名称迁移，新增项从 0 开始，删除项写入 migration audit。

## 8. 加载自定义 Scenario

插件不会被扫描或自动发现。创建、tick、daemon、inspect/migrate 同一实例时都必须显式提供同一插件：

```bash
meta-agent loop create charter.json --scenario-plugin ./plugins/security-review.mjs
meta-agent loop tick --scenario-plugin ./plugins/security-review.mjs
meta-agent loop-scheduler --scenario-plugin ./plugins/security-review.mjs
```

加载器按 workspace 解析本地路径或 package specifier，并计算实际入口文件 SHA-256。实例冻结 `id + apiVersion + version + integrity`；缺失或不一致时，在 claim Wake 之前拒绝运行。完整 ABI 和示例见 [Scenario 插件指南](scenario-plugins.md)。

## 9. 磁盘布局与排障

每个实例位于 `<workspace>/.loop/<instanceId>/`：

```text
instance.json                 当前生命周期状态
charter.frozen.json           不可静默漂移的执行契约
capsule.json                  最近一次确定性上下文胶囊
ledger/
  rounds.jsonl                round 审计与 postState
  progress.json               当前 meter/预算/route 投影
  effects.jsonl               外部 effect 状态机审计
  artifacts.jsonl             Artifact 权威 journal
  pending_round.json          submit/harvest 中间状态（存在时）
  migration.pending.json      未完成 migration intent（正常完成后删除）
drafts/                       worker 候选产物，不是权威数据
inbox/                        下一轮反馈；processed/ 为已消费归档
events/                       外部结果；processed/ 为已消费归档
reports/                      final_report / attention_report
```

排障原则：先看 `loop inspect`，再看 `instance.json`、`progress.json` 和最后一条 `rounds.jsonl`。不要手工改 frozen charter、progress 或 journal；需要修订执行 `migrate`，需要反馈写 `inbox`。正常的 crash 恢复由下一次 tick/daemon 自动完成。

## 10. 明确边界

- 当前保证是进程崩溃级原子性；append-only JSONL 不承诺断电后的 `fsync` 持久性，但读取会跳过 torn tail，并依靠 checkpoint/postState 恢复。
- Scenario hook 的 deadline 能约束异步、协作式插件；同步死循环会阻塞 Node.js event loop。对不可信插件应放到独立进程/容器，不应直接加载。
- 插件完整性固定的是实际解析到的入口文件；若 package 行为依赖多个传递文件，应由发布流程把 bundle 作为单一入口签名，或在外层使用 lockfile/制品签名。
- 单机 host coordinator 解决同一主机上的全局并发与公平性；跨主机协调需要外部共享 lease backend，不应把本地文件锁误当作分布式锁。

设计契约和历史决策可继续参考 [Auto-Orch v2 spec](auto-orch-v2-spec.md)，但运行与扩展以本文及当前代码为准。
