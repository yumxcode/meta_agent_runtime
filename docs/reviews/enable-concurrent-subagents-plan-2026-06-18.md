# 让 auto / agentic / robotics 真正并发执行子 agent — 方案

日期：2026-06-18 · 配套：`multi-agent-architecture-review-2026-06-18.md`
结论先行：**并发地基已经建好,缺的不是基础设施,而是"把异步入口接到主 agent" + "并发写隔离"两件事。**

---

## 0. 现状盘点：哪些已就位、哪些缺

实测(文件:行号见末尾)发现并发链路其实大部分是通的:

| 环节 | 状态 | 证据 |
|---|---|---|
| 并发调度器 | ✅ 已有 | `SubAgentBridge` maxConcurrent 默认 4 / auto 3,队列 64,起始间隔 50ms |
| 完成通知(事件驱动) | ✅ **已接线** | `useEventDriven` 默认 true;`dynamicPrompt.ts:878` 注入 D-SubAgent 段;每模式都 `setSubAgentBridge` |
| 预算/断路器 | ✅ 已有 | 每任务 $0.5 / 10 turns / 5min;auto 总预算 $5 |
| 失败重试 | ✅(仅 auto) | `_maybeRetryFailed` 指数退避 |
| 写隔离(worktree) | ✅(仅 auto) | `AutoWorktreeCoordinator` + `isolated_write` |
| **异步 spawn 工具暴露给主 agent** | ❌ **缺** | `makeSubAgentTools` 全仓无注册;agentic/auto 只有同步 `research_dispatch` |
| 轮内并行 | ❌ 默认关 | 委派工具 `isConcurrencySafe=false`(`toolAdapter.ts:277`) |
| robotics 并发 | ✅ 部分 | `experiment_dispatch`(async)能并发,但每次只 spawn 一个 |

**一句话**:通知、预算、调度器都好了,主 agent 在 agentic/auto 里**根本没有异步派发工具可用**;并发写隔离只有 auto 有。补这两块即可。

---

## 1. 三个正交的杠杆(可单独用、可组合)

### 杠杆 A — 翻转 `isConcurrencySafe`(最小改动,半天)
把 `spawn_sub_agent`(纯入队、天然安全)标为 `isConcurrencySafe=true`;`research_dispatch`/`run_agent` 视情况也翻。
- 效果:模型在**同一轮**发多个调用时,kernel 的 `partitionToolCalls` 合批 `Promise.all` 并发执行(上限 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`,默认 10,再受 bridge 4/3 收口)。
- 局限:同步工具(research_dispatch)即使并行,**整轮仍要等最慢的那个**才返回,没有跨轮重叠。适合"一次扇出、本轮收齐"。

### 杠杆 B — 暴露异步 spawn 家族(真正的并发,推荐)
在创建 bridge 的地方注册 `makeSubAgentTools(bridge)`(含 spawn / status / intermediate / cancel / list)。
- 效果:主 agent `spawn_sub_agent` 后**立即返回 taskId**,继续干别的;后台并发跑(≤4/3);完成时经**已接线的 D-SubAgent 段**自动回注通知。这是真正的异步 fan-out + overlap。
- 这是"基础设施建好但没接线"的那条路——改动极小。

### 杠杆 C — 批量派发工具(最可控,适合 auto 无人值守)
新增 `spawn_sub_agents([{task, tools, budget}...])`,一次调用入队 N 个,返回 N 个 taskId。
- 效果:并发性不依赖模型记得发多次,**单次调用即保证并行**;可在入队前做一次性预算预检(N×budget ≤ 剩余总预算),超了直接拒绝,便于无人值守下的成本封顶。
- 配一个 `await_sub_agents(taskIds[])` join 工具(等待全部终态后一次性返回汇总),给模型一个干净的"扇出—汇合"范式。

---

## 2. 让"真正并发"安全的前置条件(关键)

光暴露入口不够,N 个子 agent 同时跑会踩到下面这些;**写隔离是头号问题**。

### 2.1 [必做] 并发写隔离
默认 `workspaceMode` 是 `shared_write` → N 个子 agent 同写一棵工作树 = 数据竞争 + 互相覆盖。并发场景必须二选一:
- **`isolated_write`**:每个子 agent 独立 git worktree+分支,主 agent 事后串行 merge/diff/discard。auto 已有 `AutoWorktreeCoordinator`;agentic 需要把它接上,否则并发写任务一律拒绝。
- **`shared_readonly`**:只读分析类任务(research、检查、抽取)直接共享树只读,无冲突——这是最省事的并发档,research_dispatch 本质就是它。

落地策略:**并发档默认 `isolated_write`(写)或 `shared_readonly`(读),`shared_write` 仅允许单发**。

### 2.2 [必做] 并发与预算上限按模式收紧
- agentic:给个默认总预算(现在是 undefined=无上限),建议 maxConcurrent 4 + 总预算可配。
- auto:保留 `conservativeAutoDefaults`(3 并发 / $5),不放宽。
- 统一并发闸:呼应整改方案①的 `ConcurrencyGate`——worker 内再 spawn 时共享同一全局令牌,避免"4×4 真实并发"。

### 2.3 [必做] 单层级不变(防扇出爆炸)
子 agent 当前拿不到 bridge → 无法再 spawn(凑巧安全)。开放并发后务必把它变成**显式不变量**:`SubAgentRecord` 加 `depth`,spawn 处 `if (depth>=1) throw`。否则一旦给子 agent 也注入 dispatcher 就是无界递归 fan-out。

### 2.4 [建议] 通知洪泛与收口
多个子 agent 同时完成会灌通知。`mergeOverflowNotifications` 已做背压合并;再给模型一个 `await_sub_agents` join 工具,避免它靠轮询 status 空耗 turn。

---

## 3. 各模式的具体改动

### agentic
- **改 `SessionRouter`**(现已在 ~740 注册 research_dispatch + status):追加
  ```ts
  for (const t of makeSubAgentTools(bridge)) session.registerTool(t)
  ```
  → 主 agent 立刻获得 spawn/list/cancel/status/intermediate。
- 写任务默认 `isolated_write`;给 agentic 也构造一个 worktree coordinator(复用 auto 的),无 git 仓时写任务降级为拒绝、读任务走 readonly。
- 设默认总预算(可配)。
- 通知已接线,无需改。

### auto
- 同样在 `SessionRouter` 的 auto 分支注册 spawn 家族(`conservativeAutoDefaults` 已自动收紧到 3/$5)。
- **强制** `isolated_write`(worktree 已有)用于写;`AutoWorktreeCoordinator` 已能 reconcile/merge/discard。
- 优先上**杠杆 C 批量工具 + 预算预检**:无人值守下"一次扇出 N 个 + 总额封顶"比模型自由多发更可控。
- 失败重试已有;加 `depth` 上限。

### robotics
- 已有 `experiment_dispatch`(async)——**已经能并发**,模型连发多次即可。两个增强:
  1. 让 `experiment_dispatch` 支持**批量**(接收 specs 数组,一次入队 N 个实验),省去模型多轮发起。
  2. 实验子 agent 强制独立 worktree/分支(prompt 已要求"never push/merge,主 agent 处理"),把这点从 prompt 约定升级为 `isolated_write` 代码强制,杜绝并发实验互相污染工作树。
- 通用并行(非实验类)可一并注册 spawn 家族。

---

## 4. 推荐落地路线(分阶段,各自可合可回滚)

| 阶段 | 内容 | 工作量 | 产出 |
|---|---|---|---|
| **P1** | `SessionRouter` 注册 `makeSubAgentTools`(agentic+auto);`spawn_sub_agent` 标 concurrency-safe;写任务默认 `isolated_write`/读 `shared_readonly` | 1 天 | agentic/auto 获得真异步并发 |
| **P2** | 新增 `spawn_sub_agents` 批量 + `await_sub_agents` join;按模式设并发/预算上限;`depth` 不变量 | 2 天 | 可控扇出—汇合范式 + 防爆炸 |
| **P3** | robotics `experiment_dispatch` 批量化 + 强制 worktree;统一 `ConcurrencyGate` 全局闸(并入整改方案①) | 2–3 天 | robotics 批量并发 + 全局并发预算 |

P1 就能让三个模式真正并发;P2/P3 是"可控 + 安全 + 收敛"。

---

## 5. 验收与风险

**验收**
- agentic/auto:发 3 个 `spawn_sub_agent` 后,`list_sub_agents` 显示 3 个同时 `running`(≤上限),主 agent 不阻塞;完成后下一轮 prompt 出现 D-SubAgent 通知。
- 写并发:3 个 `isolated_write` 任务各在独立分支提交,主 agent 串行 merge 无冲突丢失。
- 预算:批量超额时入队前即拒绝,实际花费 ≤ 总预算。
- 单层级:子 agent 内尝试 spawn 抛 `depth` 错误。

**风险与对策**
- *并发写竞争* → 2.1 隔离(头号)。
- *成本失控* → 总预算 + 批量预检 + auto 3/$5。
- *上下文被通知灌满* → 已有 `mergeOverflowNotifications` 背压 + join 工具。
- *provider 限流* → `startDelayMs`(50ms)+ 并发上限;必要时调 `META_AGENT_SUB_AGENT_START_DELAY_MS`。
- *孤儿子 agent* → bridge dispose 已 abort 在途 runner(配合整改方案③的退出钩子)。

---

## 6. 最小可行改动(若只做一件事)

在 `SessionRouter` 创建 bridge 后那几行(现注册 research_dispatch + status 处),加注册 `makeSubAgentTools(bridge)`,并把 `spawn_sub_agent` 默认 `workspaceMode` 设为 `shared_readonly`(写则要求显式 `isolated_write`)。**这一处改动即让 agentic 与 auto 的主 agent 拿到真正的异步并发能力**——通知、调度、预算、断路器全是现成的。robotics 本就有 `experiment_dispatch`,无需等这步。

---

## 附:关键代码位置
- `src/subagent/tools/index.ts:33`(`makeSubAgentTools` 工厂,含全部 5 个工具,**当前无人注册**)
- `src/routing/SessionRouter.ts:712,740,745,747`(bridge 创建 + 现有注册点 + setSubAgentBridge)
- `src/core/dynamicPrompt.ts:878` / `src/subagent/notificationSection.ts`(D-SubAgent 通知段,**已接线**)
- `src/subagent/types.ts:198-208`(默认 config:useEventDriven=true 等)
- `src/kernel/tools/ToolOrchestration.ts:48-78` / `src/modes/toolAdapter.ts:277`(轮内并发批处理 + 默认非并发安全)
- `src/robotics/tools/experiment_dispatch/index.ts:77`(await_completion 默认 false)
- `src/core/auto/AutoWorktreeCoordinator.ts`(写隔离,auto 已用)
