# Auto-Orch Mode 设计文档

> **状态：🚧 骨架已落地（本分支 `auto_orchestration`）**
> 新增第五种模式 `auto-orch`，定位为 **`auto` 的自我编排变体**：在 `auto` 的自主执行 + 工作区硬牢笼之上，
> 叠加 **(B) 主循环相位钩子** 与 **(C) AI 可编排的计划图**，让 AI 面对复杂任务时能自主构建一个
> 由多个执行/审查 Agent 协作的 loop，而编排本身是**受校验的数据**、由固定引擎解释执行。
>
> 本分支已落地：新模式全链路注册（`tsc --noEmit` 通过）、B 的内核相位事件 + HookRegistry、
> C 的 Loop IR + 统一 Verdict + PlanRunner，以及 17 条单测（全绿），且 `src/kernel` 310 条既有单测零回归。
>
> 关联文档：[auto-mode-design.md](auto-mode-design.md)

---

## 1. 定位与设计原则

### 1.1 一句话定位

`auto-orch` = `auto`（自主放行 + 文件系统硬牢笼）**＋ (B) 相位钩子中间件 ＋ (C) AI 编排的计划图**。

与 `auto` 的唯一增量：面对复杂目标，AI 不再只作为单执行器线性推进，而是先产出一张
**编排计划图**（执行节点 + 审查角色节点 + 条件边，可成环），由固定的 `PlanRunner` 解释执行；
图内每个节点运行时还可挂载 **相位钩子**，在 `pre_query/post_query/pre_tool/post_tool` 四个
回合内转换点上做最小干预（注入/中止）。

### 1.2 三条贯穿全文的原则（继承 auto）

| 原则 | 落地方式 |
|------|---------|
| **低耦合** | 内核只认 `PhaseHookFn` 契约，不 import 编排实现；模式→开关映射在 `MODE_PROFILES` 与 `SessionRouter` |
| **零回归** | B 的相位事件是 *additive*：未配置 `phaseHooks` 时内核**零额外调用**，`agentic/auto/campaign/robotics` 字节不变 |
| **编排即数据** | AI 产出的 loop 是可校验、可封顶、可重放的**数据图**，绝非自由代码；非法编排被拒并回退默认自主循环 |

---

## 2. 两层架构

```
┌─ (C) 编排层：AI 产出 OrchPlan(数据图) ──────────────────────────┐
│   PlanRunner 解释：从 entry 走图 → 每节点跑一个 kernel session   │
│   → 读统一 Verdict → 按条件边跳转（可成环）→ 硬上限封顶          │
│        节点 = executor(干活) | role(verify/drift/reviewer/…)     │
└───────────────────────────────────────────────────────────────┘
            │ 每个节点运行时挂载 ↓
┌─ (B) 相位钩子层：HookRegistry 实现内核 PhaseHookFn 契约 ────────┐
│   pre_query / post_query / pre_tool / post_tool 四个回合内转换点 │
│   每个钩子 = {point, when(谓词DSL), handler→Verdict}            │
│   折叠为内核可消费的 {inject?, abort?}                          │
└───────────────────────────────────────────────────────────────┘
            │ 注入式 DI ↓
┌─ 内核 KernelLoop（固定、battle-tested、不被 AI 改写）───────────┐
│   query → (verify) → tools → (stall) → (drift) → loop          │
└───────────────────────────────────────────────────────────────┘
```

要点：**内核循环固定且确定**，AI 只在外层（图）和钩子（数据谓词）两个受约束的维度上编排，
永远跑在内核的牢笼、预算、并发、fail-open 之内。

---

## 3. (B) 主循环相位钩子

### 3.1 内核契约（`src/kernel/loop/PhaseHooks.ts`）

`PhaseHookFn = (event) => Promise<PhaseHookOutcome>`，沿用 `DriftGateFn`/`VerifyGateFn` 的纯 DI 模式。

- **四个相位点**：`pre_query`（查询模型前）、`post_query`（助手回合落库后、执行工具前）、
  `pre_tool`（工具批执行前）、`post_tool`（工具批结果落库后）。
- **最小动作面**：钩子只能 (a) `inject` 元消息（在下一个自然边界注入，与 drift 校正同机制）
  或 (b) `abort`（干净终止）。**不能**改历史、调工具、改写模型输出 —— 执行权始终在内核。
- **零回归**：`KernelConfig.phaseHooks` 缺省时，`runPhaseHook` 直接 return，无任何额外调用。
- **fail-open**：钩子抛错/超时被吞掉，按空结果处理。

### 3.2 新增终止原因

`LoopTerminationReason` 增加 `'phase_hook_abort'`，在 `KernelSession` 的 subtype 表里映射为
`'success'`（编排层主动停机是**有意的干净停止**，非失败）。

### 3.3 HookRegistry（`src/core/auto-orch/HookRegistry.ts`）

把内核的两个写死 gate 槽，泛化为**开放注册表**：

```ts
reg.register({ id, point, when?: Predicate, handler: (ctx) => OrchVerdict, role? })
const phaseHooks = reg.toPhaseHookFn()   // 即内核 PhaseHookFn
```

`toPhaseHookFn` 在每个相位点求值 `when` 谓词 → 顺序跑命中的钩子 → 折叠 verdict（inject 去重合并，
任一 abort 即 abort）。drift/verify 在这套体系里只是「挂在结构边界上的两个角色」的特例。

---

## 4. (C) AI 编排的计划图

### 4.1 Loop IR（`src/core/auto-orch/LoopIR.ts`）

AI Planner 产出的 **数据图**：

- `OrchNode`：`{ id, kind: 'executor'|'role', role?, taskDescription, allowedTools?, maxTurns?,
  maxBudgetUsd?, workspaceMode?, hooks? }`。写文件的 executor **必须** `workspaceMode: 'isolated_write'`
  （校验强制）。`hooks` 是只在该节点运行时生效的相位钩子（B 挂进 C）。
- `OrchEdge`：`{ from, to, when? }`，条件 `always | verdictLabel | verdictAction`。**回边即循环**
  （verify fail → 回到 gen 就是 generate→verify→fix 环）。
- `OrchBounds`：`maxNodeVisits / maxTotalSteps / maxTotalCostUsd / maxWallClockMs` —— AI 工作的硬墙。
- `validatePlan`：唯一 id、entry 存在、边引用合法、谓词合法、写节点隔离 —— **非法计划绝不执行**。

### 4.2 统一 Verdict（`src/core/auto-orch/Verdict.ts`）

图与钩子都消费同一个 `OrchVerdict`，动作集闭合为五种：
`continue | inject | reject | branch | done | abort`。
提供 `fromDrift` / `fromVerify` 适配器，让既有 drift/verify Agent 不改写就能接入。

### 4.3 谓词 DSL（`src/core/auto-orch/predicates.ts`）

触发谓词是**纯数据**（`turnInterval / atPoint / onBoundary / verdictLabel / anyToolErrored /
counterAtLeast / costAtLeast / and|or|not`），`evalPredicate` 全函数、无副作用。
这是「AI 组合主循环过程钩子却不执行任意逻辑」的关键。

### 4.4 PlanRunner（`src/core/auto-orch/PlanRunner.ts`）

固定解释器：校验 → 从 entry 走图 → 每节点经注入的 `NodeRunner` 执行 → 读 verdict → 选首个命中
的出边跳转 → 直到无命中边（终止）或 `abort`。全程封顶（visits/steps/cost/wall-clock），
**永不抛异常**：任何失败路径都落成 `PlanRunResult{status}`，host 据此回退默认固定循环。

### 4.5 KernelNodeRunner（实盘节点执行，`src/core/auto-orch/KernelNodeRunner.ts`）

`NodeRunner` 的实盘实现：每个节点经 `ISubAgentDispatcher` spawn 一个真实 kernel 子 session。
- **executor 节点** → 用节点的 tools/隔离起一个干活子 Agent；终态映射为 `branch('ok'|'error')`，图据此路由成败。
- **role 节点**（verify/drift/reviewer）→ 起一个**只读**审查子 Agent，必须输出 `{label:'pass'|'fail',messages?}` JSON；`pass`→`done`，`fail`→`branch('fail')` 携带纠偏 messages。无法运行/不可解析 → fail-open 成 `skipped` 的 pass，绝不卡死图。
- 成本经 `verdict.data.costUsd` 上报，供 PlanRunner 执行成本上限。

### 4.5b RoleCatalog（角色注册表，`src/core/auto-orch/RoleRegistry.ts`）

**drift/verify 不再是两个写死的 gate 槽，而是注册表里的两个角色。** 角色在此**定义一次**，
同时暴露两面：
- `buildHandler(ctx)` —— 给编排图（KernelNodeRunner 的 role 节点）用的节点级处理器；
- `buildVerifyGate(ctx)` / `buildDriftGate(ctx)` —— 给内核 loop 在结构边界消费的 gate。

关键：**内核一行未改** —— loop 仍消费稳定的 `VerifyGateFn`/`DriftGateFn` 契约；注册表只是
**产出**它们的「编排/authoring 层」（verify/drift 内部仍委托既有 `makeAutoVerifyGate`/`makeAutoDriftGate`）。
`AgenticBackendFactory` 现在经 `defaultRoleCatalog()` 取 verify/drift gate，并把**同一个 catalog**
传给 `AutoOrchController`，因此内核 gate 与图 role 节点共享一份角色定义。新增角色（reviewer/cost_guard/security）
= 一条 `register()`，图与 loop 都能用。零回归。`reviewer` 是通用只读 pass/fail 复核（`reviewer.ts`），
也是未知 role 名的兜底。

### 4.5c Blackboard（节点间共享通道，`src/core/auto-orch/Blackboard.ts`）

**让修正环真正闭合。** 没有它时，role 节点 `fail` 携带的具体纠偏项（"补测试"、"修空指针"）会丢失——
回边只是用**原始** taskDescription 重跑 executor，审查反馈无处可去。Blackboard 是 **run 作用域**的共享通道：
- `KernelNodeRunner.runRole`：role 返回 `fail` 时把 `messages` 写入 `postCorrective(role, messages)`；
- `KernelNodeRunner.runExecutor`：重跑前 `takeCorrectivePreface()` 读取并**消费**待处理纠偏，作为任务前缀注入，
  于是 generate→verify→fix 真正修的是被点名的缺口。

作用域与归属：一次计划执行一个 Blackboard，由 `PlanRunner` 持有、经 `PlanRunContext.blackboard` 下发；
内存、单次运行（**不是**持久 checkpoint）。保留完整 post 日志供观测，待处理纠偏**读取即清**（反馈恰好应用一次）。
`correctiveRounds()` 写进 controller 摘要。这是最小跨节点通道，后续可在 `post/entries` 上扩展按目标寻址 / 兄弟输出。

### 4.6 AutoOrchController（端到端驱动，`src/core/auto-orch/AutoOrchController.ts`）

把三件串起来：`goal → Planner 产图 → PlanRunner 走图 → KernelNodeRunner spawn 子 Agent`，
返回 `OrchestrationResult{ planSource, run, summary }`（含中文执行路径/成本/状态摘要）。
`buildAutoOrchLaunchHooks(controller)` 产出**启动 phase hook**（B）：在首个 `pre_query` 跑一次整套
编排，把摘要作为 abort note 浮现为会话结果，然后中止 shell 执行器（幂等，二次为 no-op）。

---

## 5. 模式注册（全链路）

| 文件 | 改动 |
|------|------|
| `src/core/modes.ts` | `SessionMode` += `'auto-orch'`；`MODE_PROFILES['auto-orch']`（weight 1，编排身份/模式文案，`compactProfile: 'auto-orch'`，`agenticOverrides` 复用 auto 的 autonomy 牢笼 + `promptMode: 'auto-orch'`）。`MODE_WEIGHT` 自动派生。 |
| `src/kernel/compact/CompactPrompt.ts` | `CompactProfile` += `'auto-orch'`（compile-time `Exact<SessionMode,CompactProfile>` 要求对齐）；`SECTION_INSTRUCTIONS_BY_PROFILE['auto-orch']` 复用 auto 模板。 |
| `src/routing/SessionRouter.ts` | `_createImpl` 的 `case 'auto-orch'` 走共享 agentic backend；新增 `isAutonomousMode()` helper，把 goal 捕获 / resume / dispose-flush 三处 `=== 'auto'` 收敛为「auto 与 auto-orch 同列」。 |
| `src/kernel/KernelSession.ts` | `subtypeMap` 补 `phase_hook_abort: 'success'`。 |

---

## 6. 文件清单

**新增**
- `src/kernel/loop/PhaseHooks.ts` — B 的内核契约
- `src/core/auto-orch/{Verdict,predicates,HookRegistry,LoopIR,PlanRunner,index}.ts` — B+C 实现
- `src/core/auto-orch/__tests__/autoOrch.test.ts` — 17 条单测
- `docs/auto-orch-design.md` — 本文档

**修改**
- `src/kernel/types/KernelConfig.ts` — `phaseHooks?: PhaseHookFn`
- `src/kernel/loop/KernelLoop.ts` — `runPhaseHook` helper + 四个相位发火点 + `phase_hook_abort`
- `src/kernel/KernelSession.ts`、`src/kernel/compact/CompactPrompt.ts`、`src/core/modes.ts`、`src/routing/SessionRouter.ts`

---

## 7. 实现状态与未开发项

**已实现（本分支）**
- ✅ B：内核四相位事件 + HookRegistry + 谓词 DSL + 统一 Verdict（含 drift/verify 适配器）
- ✅ C：Loop IR + `validatePlan` + PlanRunner（成环、硬封顶、fail-open）
- ✅ **Planner Agent**（`src/core/auto-orch/PlannerAgent.ts`）：spawn 独立规划子 Agent（复用 drift/verify 的隔离 + spawn/poll 范式）→ 输出 OrchPlan JSON 代码块 → `parseOrchPlan` 解析归一 → `validatePlan` 把关；任何失败（无 goal / 无 summary / 不可解析 / 非法）**fail-open 回退** `singleExecutorPlan`（退化为单执行器 + verify 的 plain-auto 行为，永远可跑）。
- ✅ **实盘 NodeRunner**（`KernelNodeRunner`）：经 `ISubAgentDispatcher.spawnSubAgent` 起真实子 Agent 跑 executor/role 节点，映射为统一 verdict，fail-open。
- ✅ **AutoOrchController + Factory 装配 + 启动**：`AgenticBackendFactory` 在 auto-orch 时构造 controller + 启动 phase hook 并经 `phaseHooks` 注入 kernel（config 路径：`MetaAgentConfig.phaseHooks → AgenticSession → KernelSession → loop`）；首轮 `pre_query` 启动整套编排、摘要浮现为结果。
- ✅ 新模式 `auto-orch` 全链路注册，`tsc --noEmit` 通过
- ✅ **drift/verify → 角色注册表**（`RoleCatalog`）：drift/verify 定义为注册表角色，内核经 catalog 取 gate（契约不变、零回归），图 role 节点与内核 gate 共享同一份角色定义；`reviewer` 兜底未知角色。
- ✅ **Blackboard**（节点间共享通道）：role 的 `fail` 纠偏 messages 经 run 作用域 Blackboard 注入下一个 executor，修正环真正闭合；端到端单测断言纠偏文本注入重跑 executor 的 taskDescription。
- ✅ 52 条单测全绿（B+C+Planner+端到端+RoleCatalog+Blackboard+ModeProfiles）；`src/kernel`/`routing`/`modes`/`core` 既有单测零回归

**未开发（标 TODO，后续 PR）**
1. **节点级 hooks 装配**：把每节点 `hooks` 装配进该子 session 的 `KernelConfig.phaseHooks`（现仅主会话启动 hook 已接通；节点内相位 hook 待接）。executor 写节点的 isolated_write 分支事后 merge 也在此完善。
2. **闭环重规划**：在结构边界回调 Planner 改图，受 `replan-depth` 上限约束。
3. **Blackboard 进阶**：按目标节点寻址 / 兄弟输出共享（当前为单队列纠偏快路径），支撑真正的兄弟间并行协作。
