# Loop 跨 Workspace 并行 Scheduler 方案（2026-07-13）

> 状态：设计草案，尚未实现。
>
> 前置基线：`loop-single-workspace-closure.md`。本文只扩展单宿主上的多 workspace 并行，
> 不改变单 workspace 的 Charter、Artifact、Gate、Effect、Ledger 和恢复语义。
>
> 范围外：跨集群、多宿主协调、跨 workspace 工作流/数据依赖、Campaign 和不受信第三方插件。

## 1. 结论与架构决策

采用“每个 workspace 独立 `loop-scheduler` 进程 + 宿主级轻量协调器”的方案：

```text
Workspace A scheduler ──┐
  .loop / wakes / ledger │
                        ├── HostSchedulerCoordinator
Workspace B scheduler ──┤     identity / admission / fairness / resource leases
  .loop / wakes / ledger │
Workspace C scheduler ──┘
```

不改成单一中心 scheduler，原因是：

- 保留 workspace 级故障隔离，一个 scheduler 崩溃不拖垮其他项目；
- 保留现有 CLI 使用方式和 `.loop` 本地权威状态；
- 不要求宿主常驻一个新的网络服务；
- 共享部分只负责身份、并发和外部资源协调，不成为业务 Ledger 的第二权威。

目标使用方式保持不变：

```bash
meta-agent -w /project/A loop-scheduler
meta-agent -w /project/B loop-scheduler
```

## 2. 当前基础与缺口

### 2.1 已按 workspace 隔离

- daemon lock：`<workspace>/.loop/daemon.lock`；
- WakeStore：`<workspace>/.loop/wakes`；
- instance、Charter snapshot、Ledger、Artifact、draft、event：
  `<workspace>/.loop/<instance-id>`；
- 同一 workspace 的第二个 scheduler 会因 `lock_held` 退出；
- 一个 scheduler 内默认最多并行四个不同 Loop round，同一 Loop 同时最多一个 live claim。

### 2.2 尚未隔离或协调

| 缺口 | 当前后果 |
|---|---|
| Worker lineage ID 只含 instance ID | 两个 workspace 使用同名 instance 时可能共享 Session 历史 |
| Distill session 未包含 workspace identity | 不同项目同名需求文档可能恢复到同一会话 |
| scheduler 并发上限是进程内的 | 两个 scheduler 默认可能合计执行八个 round |
| EffectAdapter admission 是进程内 Map | 跨 scheduler 的 adapter 限流与最小间隔失效 |
| Worker 自动继承全部宿主 writeAllowPaths | 未在 Charter 声明的外部目录也可能进入 sandbox |
| 外部资源无统一身份与租约 | 账号池、Git 分支、远端平台可能并发冲突 |
| effectKey 只有实例内语义 | 外部 adapter 可能把不同 workspace 的同名 key 映射成同一任务 |
| 无宿主 scheduler registry | 无法统一检查活跃进程、排队、公平性和资源占用 |

## 3. 必须保持的设计不变量

1. 每个 workspace 的 `.loop` 仍是该 workspace Loop 状态的唯一权威；宿主协调器不复制 Ledger。
2. 同一 Loop 同时最多执行一个 round，跨进程也不得突破。
3. scheduler、Wake、admission 和资源租约都必须有独立 heartbeat；长 Seat 不能使租约过期。
4. kill -9 后只能重放未确定完成的本地 round，不能产生第二个逻辑外部副作用。
5. Worker只能获得 Charter 明确请求且操作员明确授权的能力。
6. 跨 workspace 隔离不能依赖“项目一般不会同名”或 Prompt 自觉。
7. 全局协调只使用短文件锁和带 token 的 lease；锁内禁止 LLM、网络、Git 和 adapter 调用。
8. 单 workspace 部署的行为、性能和恢复结果保持兼容。

## 4. 稳定 Workspace Identity

### 4.1 WorkspaceIdentity

项目首次 `loop create` 或启动 scheduler 时原子生成：

```json
{
  "schemaVersion": "1.0",
  "workspaceId": "ws-550e8400-e29b-41d4-a716-446655440000",
  "createdAt": 1783930000000
}
```

保存到：

```text
<workspace>/.loop/workspace.json
```

采用持久 UUID，不采用路径 hash：

- workspace 移动目录后身份不变；
- 不同项目即使同名也不会冲突；
- instance ID 恢复为 workspace 内唯一，不要求宿主全局唯一；
- Worker无权修改 `.loop`，不能伪造身份。

### 4.2 复制与移动

- 同一个 Workspace ID 在新路径出现，但旧路径没有 live lease：视为 workspace 移动，更新
  registry 的 last-known realpath；
- 同一个 Workspace ID 同时从两个 realpath 申请 live lease：第二个 scheduler fail-closed，报告
  “workspace identity duplicated”；
- 复制 workspace 后确实要独立运行时，必须显式执行：

```bash
meta-agent loop workspace-fork
```

该命令只生成新 Workspace ID 并记录 fork provenance；不隐式复制、清空或改写旧 Ledger。

### 4.3 ExecutionScope

所有跨 workspace 可见的运行时对象统一携带：

```ts
interface ExecutionScope {
  workspaceId: string
  instanceId: string
  round?: number
  wakeId?: string
}
```

比较、日志、Session 恢复、Effect dispatch 和资源申请均使用完整 scope，禁止只用 instance ID。

## 5. 全局状态命名空间

所有写入 `META_AGENT_HOME` 的 Loop 状态都必须按 Workspace ID 分区。

```text
Worker lineage: loop:<workspaceId>:<instanceId>:worker
Round lineage:  loop:<workspaceId>:<instanceId>:round:<round>:worker
Distill:        loop-distill:<workspaceId>:<relative-doc-path-hash>
Effect scope:   <workspaceId>/<instanceId>/<effectKey>
```

Session metadata 至少记录：

```json
{
  "workspaceId": "ws-...",
  "workspaceRoot": "/canonical/real/path",
  "instanceId": "research-v1"
}
```

恢复 Session 时同时校验 key 和 metadata。任一 workspaceId 不一致都拒绝加载，不能把命名规范
当作唯一安全边界。

Subtask ID 继续使用随机 ID，但持久记录新增 workspaceId/instanceId，支持隔离查询、清理和审计。

## 6. Workspace Scheduler Lease

现有 workspace 内 `daemon.lock` 继续保留，用来处理同一路径上的进程竞争。新增宿主 registry：

```text
$META_AGENT_HOME/loop-scheduler/workspaces/<workspaceId>.lease.json
```

建议结构：

```json
{
  "schemaVersion": "1.0",
  "workspaceId": "ws-...",
  "workspaceRoot": "/canonical/real/path",
  "pid": 12345,
  "host": "host-a",
  "token": "random-lease-token",
  "startedAt": 1783930000000,
  "heartbeatAt": 1783930060000,
  "expiresAt": 1783930360000,
  "runtimeVersion": "0.6.x"
}
```

获取顺序：

1. 获取 workspace 本地 daemon lock；
2. 以 Workspace ID 获取宿主 workspace lease；
3. 失败时释放本地 lock 并退出；
4. 运行期间由独立 timer 续租；
5. 退出时按 token 校验后反向释放。

lease 用于检测同一 Workspace ID 的复制品和提供宿主可观测性，不替代本地 daemon lock。

## 7. 宿主全局 Admission

### 7.1 默认配额

建议默认：

```text
host.maxConcurrentRounds = 4
workspace.maxConcurrentRounds = 4
loop.maxConcurrentRounds = 1
```

这样单 workspace 与当前默认行为一致；多 workspace 共享四个宿主槽，不会按进程数线性膨胀。

还需要单独的 `host.maxConcurrentModelCalls`，因为一个 Worker 可以 spawn sub-agent，仅限制 round
不能严格限制模型调用数。所有 Loop Seat 和其嵌套 sub-agent 都应经过同一宿主 model-call admission。

### 7.2 持久结构

```text
$META_AGENT_HOME/loop-scheduler/
  workspaces/
  tickets/
  leases/
  resources/
  coordinator.lock
```

Admission ticket：

```json
{
  "ticketId": "ticket-...",
  "workspaceId": "ws-...",
  "instanceId": "research-v1",
  "wakeId": "wake-...",
  "kind": "round",
  "weight": 1,
  "enqueuedAt": 1783930000000,
  "heartbeatAt": 1783930000000
}
```

授予后生成带 token/TTL 的 lease。lease 过期前持续 heartbeat；crash 后过期回收。

### 7.3 公平性

不能让 scheduler 直接竞争普通 semaphore，否则活跃 workspace 可能持续占满新释放的槽。

首版采用 workspace 级轮转公平队列：

- 每个 workspace 默认权重 1；
- 同 workspace 内按 ticket 入队时间排序；
- 每次释放槽后优先授予自上次 grant 后虚拟运行量最低的 workspace；
- 同权重时使用最早 ticket；
- 任何 workspace 不能因另一个 workspace 持续产生 wake 而永久饥饿。

后续可以通过宿主策略配置权重，但 Charter 无权扩大自己的权重或宿主总上限。

### 7.4 Wake 与 Admission 顺序

兼容现有 runner 的首版顺序：

1. scheduler 原子 claim 本地 Wake；
2. 为该 Wake 创建宿主 admission ticket；
3. 排队期间持续 heartbeat daemon/workspace lease、Wake claim 和 ticket；
4. 获得宿主槽后调用 `runRound`；
5. round 结束后先持久化 Wake disposition，再释放 admission lease；
6. abort/crash 时按 token 和 TTL 恢复。

排队中的 claimed Wake 不允许过期回到 pending，否则同一 round 可能与仍在等待 admission 的进程并行。

## 8. 外部路径权限闭包

Charter 必须显式声明需要写入的宿主路径：

```json
{
  "hostRequirements": {
    "writePaths": ["~/.account-pool"]
  }
}
```

Worker实际 sandbox 外部写路径只能是：

```text
Charter requested paths ∩ operator-granted paths
```

规则：

- 未声明的全局 writeAllowPath 不进入 Worker sandbox；
- create 时缺少操作员授权则拒绝创建；
- 运行时再次 preflight，撤销授权后 fail-stop；
- workspace 内路径仍完全由 writeScope 决定；
- `~/.ssh` 不应为 `vcs_publish` 暴露给 Worker，Git 凭据由受信任内核工具处理。

## 9. 外部资源租约

路径不重叠不等于外部系统不冲突。Charter 增加声明式资源需求：

```json
{
  "hostRequirements": {
    "writePaths": ["~/.account-pool"],
    "resources": [
      {"id": "account-pool:gradmotion-default", "mode": "exclusive"},
      {
        "id": "gradmotion:project:PRO_EXAMPLE",
        "mode": "shared",
        "maxConcurrent": 2
      },
      {
        "id": "git:github.com/example/repo#main",
        "mode": "exclusive"
      }
    ]
  }
}
```

资源策略：

- writable host path 默认映射为 exclusive 资源；
- 只有操作员策略确认并发安全后才能 shared；
- shared 资源可声明宿主最大并发，Charter 只能收紧不能扩大；
- 资源 ID 必须是规范化、无 secret 的稳定标识；
- 资源 lease 与 round admission 分离，避免无关任务互相阻塞；
- Bash 直接操作外部 CLI 时，保守地在整个 Worker segment 持有资源 lease；
- EffectAdapter 可把 lease 缩小到 submit/inspect/cancel/reconcile 单次调用。

锁顺序固定为：round admission → 按规范化 resource ID 排序获取资源 lease。获取失败时反向释放，
禁止不同 Worker以不同顺序申请导致死锁。

## 10. EffectAdapter 跨进程协调

当前 EffectAdapterRegistry 的 admission 是进程内状态。跨 workspace 后迁移到宿主 admission，键为：

```text
adapter:<adapterId>:<credentialProfile>
```

例如：

```text
adapter:vendor/task@2:account-pool-default
```

宿主统一执行：

- maxConcurrentCalls；
- minIntervalMs；
- FIFO/公平排队；
- deadline/AbortSignal；
- lease heartbeat 与 crash recovery。

EffectAdapterContext 增加：

```ts
interface EffectScope {
  workspaceId: string
  instanceId: string
  effectKey: string
}
```

adapter 用完整 scope 派生外部幂等键。Worker提供的 effectKey 仍是实例内稳定业务 key，但不能单独
作为跨 workspace 的外部幂等身份。

## 11. Git 与远端副作用

### 11.1 Git publish

不同 workspace 推送同一 remote/branch 时，`vcs_publish` 在短临界区申请：

```text
git:<canonical-remote-url>#<branch>
```

在 lease 内重新读取 remote head，非 fast-forward 时 fail-stop 并要求人工处理，禁止自动覆盖。

### 11.2 Worker直接提交远端任务

直接 Bash/skill 调外部 CLI 无法获得 Effect ABI 的完整幂等保障，因此必须：

- 声明对应 host resource；
- 在 Worker segment 持有资源 lease；
- 使用业务系统原生稳定 task ID/幂等键；
- 长期推荐迁入 EffectAdapter，由 adapter 统一 submit/reconcile/cancel。

## 12. 认证事件与 Human Gate

认证事件签名域扩展为：

```text
workspaceId
instanceId
effectKey
contentHash
principal
roles
issuedAt / expiresAt / nonce
```

验签必须同时检查当前 instance 的 Workspace ID。把 Workspace A 的合法审批文件复制到
Workspace B 时，即使 effectKey 和内容相同也必须失败。

event 文件仍只写入目标 instance 的 `events/`，签名 secret 继续放在 META_AGENT_HOME，Worker
不可见。

## 13. 失败与恢复语义

| 失败点 | 确定性处理 |
|---|---|
| 第二个 scheduler 启动同一 workspace | `lock_held`，不改任何 Wake |
| 同 Workspace ID 在两个 realpath live | `workspace_identity_conflict`，第二个 fail-closed |
| 等待宿主槽时 scheduler 退出 | ticket 取消，Wake 回 pending；已知 cost 不丢 |
| 持有宿主槽时 kill -9 | lease 到期回收，Wake claim 到期后按原协议恢复 |
| resource lease 丢失 | 立即中止 Seat；外部副作用不确定时实例 failed，要求 reconcile |
| 操作员撤销 host path | 运行前 preflight fail-stop，不回退为更宽权限 |
| Effect admission 进程崩溃 | lease 到期后同 effectKey reconcile，不创建第二个任务 |
| Session namespace 发现不匹配 | 拒绝加载旧上下文，从 Ledger Capsule 建新 lineage 并记录 warning |
| Git remote 发生并发推进 | 非 fast-forward fail-stop，不覆盖远端 |

任何协调器损坏或无法验证的状态都不能被当作“没有锁”；必须 quarantine 或 fail-stop。

## 14. 兼容迁移

现有实例升级步骤：

1. 停止旧 scheduler，确认没有 running Seat；
2. 原子创建 `.loop/workspace.json`；
3. instance record 补充 workspaceId；
4. 后续 Worker/Distill 使用新 Session namespace；
5. 旧 lineage 能唯一归属当前 workspace 时在 SessionStore 锁内一次性迁移；
6. 发现多个 workspace 竞争同一 legacy lineage 时不导入，使用 Ledger Capsule 新建 Session；
7. 不修改旧 rounds/artifacts/effects Ledger 和 frozen Charter；
8. event-auth secret 兼容读取一个版本，成功迁移后才删除旧入口；
9. migration 记录写入 instance lifecycle/audit，而不是伪造一个业务 round。

LLM Session 不是权威状态。歧义时放弃 Session 连续性优先于跨项目错误恢复。

## 15. CLI 与可观测性

保留：

```bash
meta-agent -w <workspace> loop-scheduler
```

新增建议：

```bash
meta-agent loop workspace-info
meta-agent loop workspace-fork
meta-agent loop schedulers
meta-agent loop host-capacity
```

`loop schedulers` 至少展示：

- Workspace ID、canonical root、PID、runtime version 和 heartbeat；
- 活跃/排队 round；
- 宿主槽占用；
- 外部资源 lease；
- 最近错误和 stale lease；
- duplicate Workspace ID 冲突。

日志前缀统一为：

```text
[ws-a1b2/research-v1/round-3]
```

默认命令只查看当前 workspace；`--all-workspaces` 必须是明确的宿主级查询，不得把其他 workspace
内容注入当前 Worker。

## 16. 实施阶段

### G0：冻结契约与失败测试

- WorkspaceIdentity、ExecutionScope；
- HostAdmission、AdmissionTicket、ResourceLease 接口；
- 失败语义、lock ordering、兼容策略；
- 先加入能稳定复现 Session 串线、全局超额和路径过度授权的测试。

### G1：身份与 Session 隔离

- Workspace ID 生成、读取和 duplicate 检测；
- Worker/round/Distill Session namespace；
- Session metadata workspace 校验；
- Subtask workspace metadata；
- legacy lineage 安全迁移。

完成 G1 后才能承诺不同 workspace 不串上下文。

### G2：权限闭包

- hostRequirements 与操作员 grant 求交集；
- 删除外部路径自动继承；
- `.ssh` 不进入 Worker sandbox；
- create 和每次 Seat 前双重 capability preflight；
- 路径撤权和 symlink 变化 fail-stop。

### G3：宿主级并发与公平性

- scheduler registry/workspace lease；
- round/model-call admission；
- 公平 ticket 和 workspace 权重；
- 排队期间多租约 heartbeat；
- abort、kill -9、stale lease recovery。

### G4：外部资源、Effect、Git、审批

- ResourceLeaseManager；
- EffectAdapter 跨进程 admission；
- scoped external idempotency；
- Git remote/branch lease；
- workspace-bound authenticated events。

### G5：迁移、观测与压力测试

- CLI 状态与 workspace fork；
- legacy migration；
- 50 workspace / 200 Loop 压测；
- 长 Seat、限流、资源争用和完整故障注入；
- 升级指南和单 workspace parity 报告。

## 17. 测试矩阵

### 17.1 隔离

1. 两个 workspace 使用相同 Charter/instance ID，Worker Session 不共享任何消息；
2. 同名 Distill 文档生成独立会话；
3. Ledger、Wake、Artifact、draft、event 不出现跨根路径；
4. Workspace B 的 Worker不能读取 Workspace A 的 Session metadata；
5. 全局 subtask cleanup 不能删除其他 workspace 的 live task。

### 17.2 锁与恢复

1. 同 workspace 第二个 scheduler 返回 lock_held；
2. symlink 指向同一 workspace 时仍只能有一个 scheduler；
3. 两个 realpath 携带同一 Workspace ID 时第二个 fail-closed；
4. daemon、Wake、admission、resource heartbeat 在六小时 Seat 中持续有效；
5. 在 ticket 排队、slot grant、resource grant、Seat 运行和 release 各边界 kill -9；
6. stale lease 只能由 token/TTL 协议回收，不能删除新 holder 的 lease。

### 17.3 并发与公平

1. 多 scheduler 合计活跃 round 永不超过 host 上限；
2. 单 Loop 永不出现两个 live round；
3. 持续繁忙 workspace 不能使其他 workspace 永久饥饿；
4. workspace 权重只影响比例，不突破总上限；
5. model-call 上限覆盖嵌套 sub-agent。

### 17.4 权限与资源

1. 未声明 `~/.ssh` 时 sandbox 中绝不出现该路径；
2. Charter请求但操作员未授权时 create 失败；
3. exclusive 资源严格串行；
4. shared 资源遵守 maxConcurrent；
5. 多资源反序申请不会死锁；
6. 同 remote/branch 的 VCS publish 串行且拒绝非 fast-forward；
7. 同 adapter/credential profile 的调用遵守宿主级间隔和并发。

### 17.5 Effect 与审批

1. 不同 workspace 同 effectKey 不映射为同一外部幂等任务；
2. adapter submit ack 丢失后使用完整 scope reconcile；
3. Workspace A 的签名事件在 Workspace B 验证失败；
4. event/poll first-wins 在跨 scheduler 压力下仍只有一个 terminal outcome。

### 17.6 兼容与性能

1. 单 workspace 全量现有测试保持通过；
2. 旧实例不改 Ledger 即可生成 Workspace ID 并恢复；
3. legacy Session 歧义不会静默合并；
4. 50 workspace / 200 Loop 下协调器热路径与活跃 ticket/lease 数相关，不扫描全部业务历史；
5. 无竞争的单 workspace round 延迟无显著回退。

## 18. 发布验收标准

必须全部满足：

1. 不同 workspace 即使 instance ID 相同也不串 Session、Subtask 或事件；
2. 项目内所有权威状态仍只落在自己的 `.loop`；
3. 同一 workspace 或同一 Workspace ID 不会出现两个 scheduler；
4. 全宿主并发严格受限且有公平性；
5. Worker只获得 Charter 声明且操作员授权的外部写路径；
6. 外部 exclusive/shared 资源遵守声明的租约语义；
7. EffectAdapter admission、Git publish 和审批认证都绑定完整 workspace scope；
8. kill -9 后不丢成本、不重复已确认 round、不产生第二个逻辑外部任务；
9. 旧实例可安全升级，歧义 Session 不跨 workspace 恢复；
10. 单 workspace 行为、恢复和性能与当前闭环基线保持 parity。

达到以上标准后，才正式承诺：同一宿主上的多个 `loop-scheduler` 可以跨 workspace 并行运行，
并在状态、上下文、权限、并发和外部资源层面互不干扰。

