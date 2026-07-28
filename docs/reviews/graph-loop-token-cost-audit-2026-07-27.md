# Graph Loop 节点 Token 消耗审计（样本：F1_train_AMP / amp_loop-v1）

日期：2026-07-27（rev.2，含 A0 实测校正）
样本实例：`F1_train_AMP/.loop/amp_loop-v1`（workspaceId `ws-e9ad66c3…`，status=`exhausted`，
`totalCostUsd = 1.6174`，7 个 activation，跑到 iteration 3→4）
审计对象：`meta_agent_runtime` graph loop 的上下文与计费机制

> **rev.2 修订说明**：rev.1 的 R2「GLM 关闭 prompt cache，重放按全价计费」经
> `scripts/probe-glm-cache.mjs` 实测**证伪，已撤回**。智谱端点有服务端自动前缀缓存。
> 但增长机制（R1/R3）不受影响，且绝对上下文量级比 rev.1 估计**大约一个数量级**，
> 压缩墙比 rev.1 说的更近。详见 §2.R2-RETRACTED 与 §6。

---

## 1. 实测数据（来自 activation 记录，非估算）

`ActivationUsage` 只持久化 `{turns, costUsd, durationMs}`。下表 costUsd/turns 为实测，
上下文两列为按 GLM 定价（`GLM_STD: input $0.43/M, cacheRead $0.043/M, output $1.74/M`）
在两种缓存假设下反推（设每 turn 新增 Δ≈3k、输出 O≈600）。

| 节点 | 迭代 | turns | costUsd | $/turn | 上下文（无缓存假设） | 上下文（**有缓存，接近实况**） |
|---|---|---:|---:|---:|---:|---:|
| research | iter1 | 72 | 0.2825 | 0.00392 | ~6.7k | **~33k** |
| writer   | iter1 | 13 | 0.0395 | 0.00304 | ~4.6k | — |
| research | iter2 | 30 | 0.1791 | 0.00597 | ~11.5k | **~65k** |
| writer   | iter2 | 13 | 0.0395 | 0.00304 | ~4.6k | — |
| research | iter3 | 44 | 0.5006 | **0.01138** | ~24.0k | **~175k** |
| writer   | iter3 | 13 | 0.0363 | 0.00279 | ~4.1k | — |
| research | iter4（cancelled，3 段） | 26 | 0.5399 | **0.02076** | ~45.9k | **~210k** |

**合计实测 $1.6174。**

关键信号：

- research 节点 **单 turn 成本**：`1.0x → 1.52x → 2.90x → 5.29x`，逐迭代单调放大。
  **这个比值与缓存是否生效无关**——缓存只是上下文项上的常数因子。
- 最后两个 research activation 占全实例 **69% 的成本**；第 4 次没跑完（26 turns，被 cancel）
  就已经花掉 **33%**。
- writer 节点单 turn 成本 **持平**（0.00304 / 0.00304 / 0.00279）。
  这条对照证明：不是模型涨价、不是 prompt 变长，**就是 research lane 的会话在累积**。

---

## 2. 根因

### R1. persistent lane = 跨 activation 的整段 transcript 重放（主因，成立）

`loop.graph.json` 中 `lanes.research.context = "persistent"`（control 同）。链路：

```
LaneManager.bind()            → context==='persistent' 才下发 lineageSessionId
NodeExecutors.executeAgent()  → continuity.lineageSessionId
SubAgentRunner                → priorMessages = SessionStore.loadHistory(lineageSessionId)
                              → sessionConfig.initialMessages = priorMessages
SubAgentRunner._persistLineageHistory() → SessionStore.replace(lineageId, …, session.getMessages())
```

每个 iteration 的 research activation 都以 **上一轮完整 transcript 作为 initialMessages 开局**，
并在结束时把更长的 transcript 写回。

需要说清楚的一点：单次请求里历史**只出现一次**（`KernelLoop` 维护 append-only 的
`state.messages`，每 turn 发送整个数组的一份快照，不做任何复制）。O(N²) 来自
**上下文 O(N) × 请求次数 N**，即同一段内容在时间维度上被重复传输，不是同一请求内重复。

推论：**在第 k 个 turn 进入上下文的 X 个 token，本 activation 内被计费 (N−k+1) 次；
persistent lane 下，后续每个 activation 的每个 turn 继续计费。** 本样本中
iter1 开头进入的内容到 iter4 结束已被重发 72+30+44+26 = **172 次**。

`SessionStore.loadHistory` 的保护上限 `DEFAULT_MAX_RESUME_BYTES = 64MiB`（≈16M token），
实际等于没有上限。

### R2-RETRACTED. ~~GLM 关闭 prompt cache~~ —— 实测证伪

rev.1 原结论：`CAP_ZHIPU.promptCache = false` ⇒ 重放全部按 input 全价计费，5–10x 乘数。

`scripts/probe-glm-cache.mjs` 实测（glm-5.2 @ open.bigmodel.cn，8k token 定长前缀）：

| run | cache_control | input_tokens | cache_read_input_tokens | cache_creation |
|---|---|---:|---:|---:|
| A 首轮 | 无 | 5,475 | 0 | 0 |
| B 次轮（重放同前缀） | 无 | **46** | **5,440** | 0 |
| C 次轮 | 有 | 46 | 5,440 | 0 |

**结论：智谱有服务端自动前缀缓存，无需下发 `cache_control`，且建缓存不收费
（`cache_creation` 恒为 0）。rev.1 的「全价重放」不成立。**

两条附带修正：

- **B 与 C 数值完全相同**，说明 C 的命中应归因于自动缓存，**不能**据此认为
  `cache_control` 生效。C 只证明了端点**不会因 `cache_control` 返回 400**——
  registry 注释里 “rejects … prompt-cache control blocks” 这半句是错的，
  但下发它也确实不带来增益。
- **`promptCache` 是死标志位。** 全仓库 `grep -rn "promptCache" src/` 只有
  `registry.ts` 的接口声明与各 provider 赋值，**无任何读取点**。翻成 `true` 不会
  产生任何行为变化；同时意味着运行时对**所有** provider（含 Anthropic）都从不
  下发 `cache_control`——那是一个独立的潜在损失，不在本次范围。

### R3. 自动压缩阈值对 glm-5.2 实际上是 637k（成立，且比 rev.1 更急）

`kernel/utils/Context.ts`：`AUTOCOMPACT_THRESHOLD_PCT = 0.65`；
`registry.ts`：`'glm-5.2': { contextWindow: 1_000_000 }`。

```
effective = 1_000_000 - 20_000 = 980_000
trigger   = 980_000 * 0.65 ≈ 637_000 tokens
```

`structuralTruncate` 只是模型压缩失败后的兜底，目标同样是 `0.85 × 637k ≈ 542k`。
也就是说，**上下文涨到 ~637k 之前没有任何机制会缩小它**。

按 ~1.9x/迭代 外推触墙轮次：

| 假设 | iter3 上下文 | 触 637k 墙 |
|---|---:|---|
| rev.1（无缓存） | ~24k | 约第 9 轮 |
| **rev.2（有缓存，接近实况）** | **~175–220k** | **约第 5 轮** |

本实例是被 `maxWallTimeMs 172800000 exhausted` 停的，不是撞墙停的。

节点 budget `turns: 200 / usd: 200`、graph `limits.maxCostUsd: 200`、
`lifetimeBudget: 1000 turns / $1000` —— 在 637k 之前这些闸门都不会拦住任何东西。

### R4. 单次工具输出可以往 transcript 里灌 25–30k token（成立，权重按缓存下调）

四层防线全部漏过它：

- `tools/shell/bash/index.ts:9`：`DEFAULT_MAX_OUT = 100 * 1024` 字符 ≈ 30k token；
- 内核层 `applyToolResultBudget` 用 `META_AGENT_MAX_TOOL_RESULT_CHARS`，默认
  `200 * 1024`（`modes/toolAdapter.ts:81`）——**比 100KiB 宽，永不触发**；
  且它是**每块上限**而非总量上限，拦得住单个巨大结果，拦不住多个中等结果累加；
- `structuralTruncate` 是压缩失败后的兜底；
- auto-compact 要到 637k 才醒。

`read_file` 默认 `MAX_LINES = 2000` 行同理，量级小一档。

**缓存修正**：warm turn 上重放按 cacheRead 计费（1/10），damage 比 rev.1 说的小；
但**每次冷启动按全价**——见 R5，一个 activation 内可能有多次冷启动。

### R5. park/resume 是缓存杀手（新增，实测证据）

iter4 的 research activation `segmentCount=3, parkCount=3`。从 journal 还原：

| 段 | turns | 成本 | $/turn | 之前的等待 |
|---|---:|---:|---:|---|
| seg1 | 12 | $0.1736 | 0.01447 | 冷启动 |
| seg2 | 4 | $0.1119 | **0.02797** | **park 1801s** |
| seg3 | 10 | $0.2544 | 0.02544 | **park 1501s** |

1801s / 1501s 对应 `timerPolicy.maxDelayMs: 1800000`（30 分钟）顶格。
**任何前缀缓存的 TTL 都远短于此**，所以每次 resume 都把整段 transcript 按全价重发一遍。
seg2 单 turn 成本因此接近 seg1 的 2 倍。

同理，**每个新 activation 的第一个 turn 也是冷启动**（iter1→iter2 之间隔了 writer 的
一整次执行，约 207s）。

附带风险：`KernelLoop:931` 的 `stripThinkingBlocksFromMessages` 在
`state.fallbackTriggered` 时会重写历史 —— 一旦触发 fallback，前缀缓存在该 session
余下全程失效。

### R6. 观测缺口（升级为关键路径）

`SubAgentRunner` 手里的 `event.usage` 已经是完整四字段 `TokenUsage`
（`inputTokens / outputTokens / cacheCreationInputTokens / cacheReadInputTokens`，
见 `core/types.ts:310`、`modes/CampaignSession.ts:188`），但：

- `SubAgentResult`（`subagent/types.ts:346`）只保留 `turnsUsed/inputTokens/outputTokens/costUsd/durationMs`，**cache 两项被丢弃**；
- `MetaAgentGraphAgentExecutor.usageFromRecord()`（:201）进一步只取
  `turnsUsed/costUsd/durationMs`；
- `ActivationUsage`（`GraphTypes.ts:320`）就这三个字段。

后果：**§1 表里那两列相差 10 倍的上下文估算，无法用现有数据区分。**
而它们对应的紧迫度完全不同（第 5 轮 vs 第 9 轮触墙）。
订阅制（GLM 套餐按 token 扣额度）下这个缺口尤其致命 —— `costUsd` 是按定价表算的估值，
不等于套餐扣减口径。

---

## 3. 一句话结论

不是某个节点"贵"，是 **research lane 的 persistent 会话从不收缩**，
叠加 **637k 的压缩阈值形同虚设**，使得每一迭代的单 turn 成本按 ~1.9x 复利增长；
**park/冷启动**在此之上周期性地把整段历史按全价重打一遍。
writer 节点单 turn 成本持平，是这个判断的对照组。
GLM 的服务端自动缓存把绝对成本压低了约一个数量级，但**不改变增长率**。

---

## 4. 已实施（rev.3）

设计原则：**graph loop 的上下文增长机制与 agentic/robotics 保持一致即可，不为控 token
新增任何摘要 / 裁剪机制。** 只修 graph loop 相对其他模式多出来的偏差。
（据此撤回 rev.1 A3 的「落盘前有界摘要」，并把 `fresh_per_activation` 降级为可选。）

| 项 | 改动 | 文件 |
|---|---|---|
| **G3** lineage 只在 completed 时落盘 | `_persistLineageHistory` 加终态门；failed/cancelled/异常退出的 attempt 不再污染 lineage。park 走 `completed` 分支，续接不受影响。 | `subagent/SubAgentRunner.ts` |
| **G4** 落盘前切掉压缩边界前的死历史 | 复用内核同一个 `getMessagesAfterCompactBoundary`（已从 `kernel/index.ts` 导出），不再每个 activation 写读一遍永不再发送的字节。 | `subagent/SubAgentRunner.ts`、`kernel/index.ts` |
| **G5** 压缩兜底改为显式声明 | 新增 `compact.structuralFallback` / `SubAgentConfig.compactStructuralFallback`；Graph seat 自己声明 `true`，不再靠「loop CLI 恰好用 mode:'auto' 起 backend」这条隐式链路。默认值仍是原来的 `autonomy !== undefined`，auto 模式行为不变。 | `core/config.ts`、`core/MetaAgentSession.ts`、`modes/AgenticSession.ts`、`subagent/types.ts`、`subagent/SubAgentRunner.ts`、`loop/graph/agent/MetaAgentGraphAgentExecutor.ts` |
| **配置 bug 1** 工具结果上限倒挂 | `DEFAULT_MAX_RESULT_SIZE_CHARS` 200KiB → 64KiB。原值比 bash 自身的 100KiB 还宽，backstop 对系统里最大的上下文贡献者永不触发。仍可用 `META_AGENT_MAX_TOOL_RESULT_CHARS` 覆盖。 | `modes/toolAdapter.ts` |
| **配置 bug 2** `promptCache` 死标志位 | 删除。声明+赋值但全仓库无读取点，暗示了运行时并不具备的行为（没有任何 provider 会下发 `cache_control`）。CAP_ZHIPU 上「rejects prompt-cache control blocks」的错误注释一并更正。 | `providers/registry.ts` |

回归测试（G3/G4/G5 三条都属于「坏了也不报错、只是变贵」的静默失效，因此单独覆盖）：

- `subagent/__tests__/LineagePersistence.test.ts` — 7 例
- `loop/graph/__tests__/GraphSeatCompactFallback.test.ts` — 1 例

验证：`tsc --noEmit` 通过；`vitest run` 全量 165 files / 1279 tests 通过。

**尚未实施**：G1（lane 缺少关闭点，建议给 `ExecutionLaneSpec` 加 `contextResetOn`，
按 phase 切换自然开新会话）、G2（park 冷启动，需先定策略）、A0.1（token 埋点）。

---

## 4b. 建议动作（按 ROI 排序）

### A0. 先量化，别先改

- ~~A0.2 验证 GLM 缓存~~ —— **已完成**，见 §2.R2-RETRACTED。
  工具保留在 `scripts/probe-glm-cache.mjs`，换 provider / 换模型时可复跑。
- **A0.1 埋点（未做，建议提前）**：
  1. `subagent/types.ts` `SubAgentResult` 增补可选 `cacheReadTokens / cacheWriteTokens`；
     `SubAgentRunner` 的各 `_writeTerminal` 调用点填入 `event.usage` 已有的值。
  2. `GraphTypes.ActivationUsage` 增补可选 `inputTokens / outputTokens /
     cacheReadTokens / cacheWriteTokens`；`UsageMath.addUsage` 一并累加。
  3. `usageFromRecord()` 透传。
  4. （可选）`GraphInstanceRecord` 加 token 总计；`loop inspect` 显示。

  全部字段设为可选即可向后兼容旧记录。**没有这一步，A1/A2 的效果无法验证，
  §1 的量级歧义也无法消除。**

### A1. 环境变量止血（零改码，立即可用）

```bash
export META_AGENT_LONG_CONTEXT_AUTOCOMPACT_THRESHOLD=60000   # 强制 60k 就压缩，绕开 637k
export META_AGENT_MAX_TOOL_OUTPUT_CHARS=16384                # bash 输出 100KiB → 16KiB
export META_AGENT_MAX_TOOL_RESULT_CHARS=32768                # 工具结果 200KiB → 32KiB
```

`META_AGENT_LONG_CONTEXT_AUTOCOMPACT_THRESHOLD` 是最有效的单个开关：
它走 `Math.min(pct 规则, cap)`，直接把压缩点从 637k 拉到可控区间。
按 §2.R3 的修正，这条现在是**第一优先级**。

### A2. lane 语义改造（改图，不改运行时）

`LaneContextMode` 已支持 `'fresh_per_activation'`。当前 loop 设计里，research 的跨轮记忆
其实已经落在 `state/findings.jsonl`、`state/progress.json`、`data/*` 这些**文件**上，
transcript 里的原始 tool 输出对下一轮几乎没有增量价值。

建议 `lanes.research.context` 改为 `fresh_per_activation`，每轮从 findings 文件重建上下文。

同时收紧 research 节点 prompt：bash 输出必须自带收口（`| tail -n`、`| wc -l`、`| grep -c`），
大输出先写文件、再用 `read_file` 带 `offset/limit` 取片段——文件不进 transcript。

### A3. 运行时改造（中期，剩余项）

> ~~`_persistLineageHistory()` 落盘前做有界摘要~~ —— **撤回**。这正是「不新增摘要机制」
> 原则要排除的东西。R1 的收敛改走 G1（给 lane 一个关闭点），语义上等价于
> agentic 用户换任务时开新会话。

- **G1**：给 `ExecutionLaneSpec` 加可选 `contextResetOn?: string`（取一个 state key），
  lineage id 带上该 key 的当前值 —— phase 一变自然开新会话。跨阶段交接本来就走
  `findings.jsonl` / `progress.json`，无需任何新增摘要逻辑。
- **G2**：缩短 `timerPolicy.maxDelayMs`（现 30 分钟顶格），或超过阈值的 park 直接不续
  seat、resume 时起新 session —— 缓存已凉，假装还热只是白付全价（R5）。
- 给 `AUTOCOMPACT_THRESHOLD_PCT` 加一个绝对上限默认值（如 `min(pct*window, 120k)`），
  避免 1M 窗口模型下压缩机制事实上失效。这条对所有模式生效，不只 loop。
- node `budget.turns: 200` 收到更现实的量级（样本实际用量 26–72 turns）；更根本的是
  budget 维度错配 —— turns/usd 都拦不住上下文长度。

---

## 5. 证据索引

| 结论 | 位置 |
|---|---|
| activation 实测 usage | `F1_train_AMP/.loop/amp_loop-v1/graph/activations/*.json` |
| park 时长 / 分段成本 | 同上 `graph/journal/0000000{14..27}.json` |
| lane 为 persistent | `F1_train_AMP/loop.graph.json` → `lanes.research.context` |
| lineage 下发 | `src/loop/graph/runtime/LaneManager.ts:43` |
| transcript 重放 | `src/subagent/SubAgentRunner.ts:354`（loadHistory → initialMessages） |
| transcript 落盘 | `src/subagent/SubAgentRunner.ts:752` `_persistLineageHistory` |
| 单请求不重复历史 | `src/kernel/loop/KernelLoop.ts:789`（`[...getMessagesAfterCompactBoundary(...)]`） |
| resume 上限 64MiB | `src/core/SessionStore.ts:37,311` |
| **GLM 自动缓存实测** | `scripts/probe-glm-cache.mjs`，结果见 §2.R2-RETRACTED |
| `promptCache` 无读取点 | `grep -rn "promptCache" src/` → 仅 `providers/registry.ts:37,92,97,100,105` |
| GLM 定价 / 1M 窗口 | `src/providers/registry.ts:112,158` |
| 压缩阈值 0.65 | `src/kernel/utils/Context.ts` |
| bash 输出 100KiB | `src/tools/shell/bash/index.ts:9` |
| 工具结果 200KiB / 每块上限 | `src/modes/toolAdapter.ts:81`、`src/kernel/tools/ToolResultBudget.ts:135` |
| fallback 触发时重写历史 | `src/kernel/loop/KernelLoop.ts:931` |
| token 数被丢弃 | `src/subagent/types.ts:346`、`src/loop/graph/agent/MetaAgentGraphAgentExecutor.ts:201`、`src/loop/graph/spec/GraphTypes.ts:320` |
| 可用环境变量 | `src/infra/env/RuntimeEnv.ts:114,118,122,211,215,245` |
