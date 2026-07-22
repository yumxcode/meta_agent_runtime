# Graph Loop 使用指南

## 快速开始

```bash
meta-agent -w /path/to/project loop distill requirements.md --out loop.graph.json
# 审阅 loop.design.md、loop.semantic-review.md 和 loop.graph.json
meta-agent -w /path/to/project loop create loop.graph.json
meta-agent -w /path/to/project loop tick --until-quiescent
meta-agent -w /path/to/project loop inspect <instanceId>
```

长期运行可启动：

```bash
meta-agent -w /path/to/project loop-scheduler
```

## Distill 输出

Distill 是前台可见的 Agentic 会话，不创建后台子任务。它会自行读取需求文件和必要项目文件。成功后生成：

- `loop.graph.json`：可执行 `graph-2.0` 源图。
- `loop.constraints.json`：来源约束。
- `loop.design.json` / `loop.design.md`：Workspace、Lanes、Control 的简明设计。
- `loop.graph.traceability.json`：hard constraint 到 Graph JSON pointer 的映射。
- `loop.graph.manifest.json`：从最终图机械提取的审阅清单。
- `loop.preconditions.json`：机器可校验的启动前置条件（必须已存在的文件/目录、外部 CLI、凭据、待人工确认的未决决策）。`loop create` 会校验 file/directory 是否存在，blocking 决策未确认时拒绝创建（`--force` 显式放行）。
- `loop.semantic-review.json` / `.md`：独立语义审阅（六层，含 runtime_preconditions）。
- `loop.graph.review.md`：Compiler 的关键决策和运行前注意事项。

成功 Distill 的可运行性合同：Compiler 校验、`loop create` 和 Scheduler 使用同一个 `graph_agent` Tool Catalog；Freeze 记录图实际使用的工具名，Runtime 在执行前再次核对。Semantic Reviewer 会看到 Agent prompt 和 Lane Workspace 合同，任何已发现的协议差异都是阻断问题，`warnings` 必须为空。

这些是设计产物，不是运行实例状态。修改意见可以在交互会话中继续输入；满意后 `/exit`，再执行 `loop create`。

## 最小 Graph 示例

```json
{
  "schemaVersion": "graph-2.0",
  "id": "bounded_iteration",
  "version": 1,
  "goal": "迭代执行，满足完成条件后结束。",
  "state": {
    "iteration": {
      "type": { "type": "integer", "minimum": 0 },
      "initial": 0
    }
  },
  "lanes": {
    "work": {
      "context": "persistent",
      "maxConcurrency": 1,
      "workspace": {
        "read": ["requirements.md", "state"],
        "write": [
          { "path": "state/progress.json", "mode": "atomic_replace" },
          { "path": "state/history.jsonl", "mode": "append_only" }
        ],
        "deny": [".git"]
      }
    }
  },
  "nodes": {
    "work": {
      "type": "agent",
      "lane": "work",
      "prompt": "完成一轮工作；直接维护声明的 Workspace 文件，并返回 done 与 summary。",
      "tools": ["read_file", "write_file", "append_file", "bash"],
      "outputSchema": {
        "type": "object",
        "required": ["done", "summary"],
        "properties": {
          "done": { "type": "boolean" },
          "summary": { "type": "string" }
        },
        "additionalProperties": false
      },
      "maxAttempts": 3,
      "budget": { "turns": 30, "usd": 2, "wallTimeMs": 900000 }
    },
    "done": { "type": "terminal", "status": "done" },
    "failed": { "type": "terminal", "status": "failed" }
  },
  "transitions": [
    {
      "id": "complete",
      "from": "work",
      "on": "success",
      "when": "$output.done == true",
      "priority": 10,
      "to": "done"
    },
    {
      "id": "continue",
      "from": "work",
      "on": "success",
      "default": true,
      "updates": [
        { "target": "iteration", "reducer": "builtin/increment@1" }
      ],
      "to": "work"
    },
    { "id": "failed", "from": "work", "on": "failure", "to": "failed" }
  ],
  "entrypoints": [{ "id": "start", "node": "work" }],
  "limits": { "maxTotalActivations": 100, "maxLiveActivations": 4, "maxWallTimeMs": 86400000, "maxCostUsd": 20 },
  "concurrency": { "maxActivations": 1, "maxPerNode": 1, "stateConsistency": "commit_latest" }
}
```

## Agent 输出契约与局部修复

声明 `outputSchema` 后，Runtime 会把该 schema 直接绑定到 Graph Agent 的 `return_result.data` 工具参数。缺少必填字段、类型/枚举不符或出现禁止的额外字段时，tool call 会在 Agent session 内报错，Agent 可以原地重新提交，而不会先结束 Activation。

post-validation 仍保留为异构 executor 和旧 substrate 的防线。如果一个已完成 segment 仍返回 schema mismatch，Runtime 只启动一次结构化结果 repair segment：fresh context、`shared_readonly`、无业务工具、无 Lane lineage，最多 6 turns、1 USD、120 秒，并受 Node 单段预算上限与 Activation lifetime 剩余预算进一步约束。repair prompt 只能使用原 candidate、summary、校验错误和 schema，不得重做研究、访问 Workspace 或产生外部副作用。

repair 仍失败时，Activation 走既有 `failure` transition，但 `$output` 会保留 `candidateOutput`、`candidateSummary`、原 `subtaskId` 以及 `contractRepair` 的 task ID、候选值和错误，便于 writer、Operator 或人工恢复有效成果。`maxAttempts` 不用于重跑这类已经产生外部副作用的完整 Agent 工作。

## Workspace 规则

- `read`：Agent 需要读取的项目相对路径清单，供 Prompt、审阅和 Operator View 使用。
- `owned`：Lane 可编辑路径前缀下的工作文件。
- `atomic_replace`：用 `write_file` 原子替换单个文件。
- `append_only`：用 `append_file` 追加，不重写历史。
- `deny`：从写范围中剔除路径；Kernel 还固定保护 `.loop`、`.meta-agent`、`.git`。

不同 Lane 不能拥有重叠写路径。强相关 producer/consumer 优先放在同一 persistent Lane；需要并行时，将写路径按目录或文件明确分配给不同 Lane。

## 工作区边界与写面 Lint

Agent 的一切写入必须落在项目内的 Lane write 范围：**项目根以外没有任何可写位置**（sandbox 基线拒写），需要编辑的外部资源（含其他仓库的 work tree）必须 clone/放置到项目内的 owned 前缀并声明为 directory 前置条件。`lintLoopGraph` 对这一失败类做静态检查：error 级（prompt 中的绝对路径/项目外写目标、无任何 git 能力却要求 commit/push）在 Distill 阶段直接阻断；warning 级（嵌套仓库依赖、Agent 预折叠布尔路由、永不可达的字面量死路由）转交语义 Reviewer 逐条实地核验。`loop create` 与交互 `/validate` 对所有发现仅打印告警（手工作者可自行裁量）。

## Git 与版本控制

Kernel 默认拒绝项目根 `.git` 的一切写入，普通 Lane 的 Agent 无法在项目根 `git commit/push`。需要版本控制的 loop 有两条被支持的路径：

- **`scm: 'git'`**：在恰好一个 Lane 上声明（git index 是单写者资源），该 Lane 获得 `.git` 写权限，但 `.git/hooks` 与 `.git/config`（代码执行与凭据攻击面）仍被固定保护；该 Lane 必须至少有一条 workspace write 规则。`loop create` 会打印 notice，Reviewer 将其视为需要来源依据的权限升级。
- **嵌套仓库惯用法**：在某个 owned 写前缀下维护独立 clone（如 `write: [{"path":"vendor_repo","mode":"owned"}]`），其内部 `vendor_repo/.git` 是普通 owned 内容——只有项目根 `.git` 受 Kernel 特殊保护。适合"训练代码镜像仓库"这类不该动宿主项目历史的场景。

## 长 Agent 与 timer

```json
{
  "type": "agent",
  "lane": "work",
  "prompt": "启动外部任务并持续观察；未完成时调用 timer，说明等待原因。",
  "budget": { "turns": 20, "usd": 1, "wallTimeMs": 600000 },
  "lifetimeBudget": { "turns": 300, "usd": 20, "elapsedMs": 172800000 },
  "timerPolicy": { "allowHardPark": true, "maxDelayMs": 3600000, "maxParks": 96 }
}
```

Hard park 只要求 persistent Lane 以及 `timerPolicy.maxDelayMs/maxParks` 两个持久等待保险丝。`budget` 和 `lifetimeBudget` 是需要更严格成本边界时的可选覆盖；省略时运行时使用保守的单段默认值，避免为了启用 Agent 自主定时而制造一组无来源的 Distill 数字。

`loop tick` 和 `loop-scheduler` 的费用 owner 是持久 Graph Kernel：节点 `budget` 约束单个物理段，`lifetimeBudget` 约束逻辑 Activation，`limits.maxCostUsd` 约束整个图实例。Scheduler 仍复用 auto backend 的 workspace jail 和保守并发，但不会再叠加 auto 单次会话默认的 `$10` 子 Agent 累计上限；否则一个显式 `$15` 段会在模型启动前失败，长期 daemon 也会在累计 `$10` 后永久失活。操作员显式设置 `META_AGENT_MAX_TOTAL_SUB_AGENT_BUDGET_USD` 时仍会增加宿主级硬上限；该上限拒绝被映射为 `exhausted`，不会消耗 `maxAttempts` 做确定性重试。

Graph Kernel 同时是 Graph Agent attempt 的唯一 retry owner。Graph seat 以 `retryOwner:'caller'` 派发，loop backend 也把 SubAgentBridge 的 Auto retry 关闭；Bridge 不得为一个已由 Graph 持久化 attempt 的失败另起隐藏 task。普通 Auto 子 Agent 的 Bridge retry 会保留稳定的 `logicalTaskId`、记录 `retryOfTaskId`，并可按 task family 整体取消。同一 `lineageSessionId` 在 Bridge 内强制单执行者：即使还有全局并发槽，后续 task 也必须等前一 runner 完全退出并保存 history 后才能启动。

SubAgent wall-clock 超时在 task record 的 `result.diagnostics` 中记录执行阶段：`model_admission` 表示等待宿主模型调用配额，`provider_response` 表示已获准但仍在等待模型事件，`agent_execution` 表示至少已有一个运行时事件。Graph retry reason 和最终 failure output 会保留该诊断，避免把 0-turn admission/provider 等待误判成文件工具失败。

timer 会结束当前物理执行段，但不结束逻辑 Activation。到期后同一 Lane 会话恢复。`loop inspect` 显示当前阶段、等待原因、累计时间和最近 summary。

## Webhook / event

图中使用 event wait 后，外部接收器调用：

```bash
meta-agent -w /path/to/project loop event <instanceId> ci.completed \
  --source github --delivery-id 12345 \
  --payload '{"runId":42,"conclusion":"success"}'
```

`source + deliveryId` 用于重投去重。event 可在 Wait Activation 创建前到达并进入 inbox；存在 timeout 时按首次有效事件判定。

## 运维命令

```bash
meta-agent loop list
meta-agent loop inspect <instanceId>
meta-agent loop timeline <instanceId> --limit 50
meta-agent loop files <instanceId>
meta-agent loop disk <instanceId>
meta-agent loop events <instanceId> --status pending
meta-agent loop inspect <instanceId> --json
meta-agent loop pause <instanceId> --reason maintenance
meta-agent loop resume <instanceId>
meta-agent loop stop <instanceId> --reason cancelled
meta-agent loop archive <instanceId>
meta-agent loop gc --older-than-days 7
meta-agent loop capabilities
```

`files` 显示各 Lane 的直接 Workspace 合同和当前文件状态；`timeline` 显示控制 journal；`disk` 只统计 Runtime 自身实例记录。`list/inspect/timeline/disk` 支持版本化 `--json` 输出；`events` 是只读 inbox 视图，不消费或重放事件。`inspect --json` 同时返回静态 Reliability Profile 和从现有持久状态推导的诊断卡片。Evidence、Effect conformance 和 webhook ingress API 见 [Graph Loop Support Packs](graph-loop-support-packs.md)。

## 运行前审查

至少确认：

- Graph goal、成功标准和终态符合需求；
- Lane 写路径没有过宽或冲突，且与真实项目结构一致（写路径指向的目录确实是要改的目录）；
- append 文件使用 `append_file`，replace 文件使用 `write_file`；
- Agent tools/skills 在目标机器可用（工具目录以 `DEFAULT_GRAPH_AGENT_TOOLS` 为唯一权威，扩展走 Capability Pack）；
- 确定性阈值由 `when`/Reducer 计算；
- 所有 failure、timeout、event 和 timer 路由闭合；
- 节点读取的每个 `$input.x` 在所有入边与 entrypoint 上都有绑定（可选值绑定 `{"literal": null}`；validator 会机械拒绝缺口）；
- `loop.preconditions.json` 中的文件/CLI/凭据已就绪，未决决策已人工确认；
- 有界图使用 `maxTotalActivations + maxLiveActivations`；持续/反应式图省略 total，只保留 `maxLiveActivations` 和业务停止事件；
- 时间、费用或 Activation 预算耗尽按 `exhausted` 终态处理，failure 只表示执行/控制流错误；
- Join arrival 的即时唤醒只是优化；Kernel 每个 tick 都会从持久 Activation 对账完整 barrier，commit 后唤醒事务失败不会永久挂起；
- Scheduler 对未知基础设施错误最多退避重试 5 次，之后自动 `paused` 并保留 `loop resume` 恢复入口；只有明确的图、ABI、能力或路由确定性错误进入 `failed`；
- 并发大于 1 时显式选择 `stateConsistency`，并确认 `commit_latest` 路由没有把新鲜 `$state` 与旧快照 `$output` 当成同一快照；
- 时间、费用、park 次数符合部署预期。

## $input 严格语义

节点 inputs、effect idempotencyKey、wait delayMs/correlation、terminal result 中的 `$input.x` 引用是严格的：任何一条入边或 entrypoint 未绑定 `x`，该 Activation 在执行前就地失败。只有 transition `when` 条件对缺失引用宽松（视为该边不匹配）。只在部分路径存在的可选值，必须在其余每条入边显式绑定 `{"literal": null}`。entrypoint inputs 只能引用 `$state` 或 literal。另注意 `builtin/identity@1` 返回完整 inputs 记录，下游用 `$output.<key>` 取值。
