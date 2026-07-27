# Meta-Agent 架构健壮性审查 — 低耦合 / 高内聚 / 模块化 / 可扩展性

审查日期：2026-06-18 · **仅审查，未改动代码**
关注点：模式之间是否低耦合、模块是否高内聚、边界是否清晰、加新模式是否容易。

证据来源：跨层 import 方向统计、mode 字面量分布、prompt 构建器分支、SessionRouter 契约、各文件行数。

---

## 0. 总览

| 维度 | 评分 | 一句话 |
|---|---|---|
| 模式注册集中度 | 良好 | `core/modes.ts` 是单一事实源 + 编译期 `Exact<>` 锁，加模式只改一处枚举 |
| Kernel ↔ 模式解耦 | 良好 | kernel 用 hook 注入（verifyGate/driftGate/onCheckpointBoundary/canUseTool），不反向 import 行为 |
| 共享 prompt 层解耦 | **差** | `dynamicPrompt`/`staticPrompt` 硬编码 `mode === 'campaign'` 分支并直接 import campaign 内部 |
| 共享 infra 归属 | ✅ 已修复 | GitWorkspaceManager + ExperienceStore（连同 persist/metaAgentHome/经验类型簇）已下沉到 `infra/`；`core/auto` 不再依赖 `robotics/`。`infra` 是自包含叶子。 |
| Router ↔ 后端契约 | 中 | `SessionImpl` 契约过窄，模式特有能力全靠 `as any` 逃逸（7 处） |
| 单文件内聚 | 中 | `RoboticsSession` 1766 行、`dynamicPrompt` 1245 行、`SubAgentBridge` 1173 行，职责偏多 |

**核心结论**：存在**两套互相矛盾的「模式扩展机制」**——robotics 用干净的依赖注入（`modeExtensions`），campaign 用把自己焊进共享层的硬编码分支。后者是本次最值得收敛的架构债：它让「共享」模块其实只对 campaign 共享，新模式要么继续往里加 `if`，要么走 robotics 的注入路子，标准不统一。

下文严重度：**[高]** 结构性、阻碍扩展；**[中]** 局部耦合/错位；**[低]** 整洁度。

---

## 1. 分层与依赖方向

实测「谁 import 谁」（非测试代码）：

```
kernel  → core(2)                         ← 分层倒置（kernel 应是最底层）
core    → kernel(14) subagent(14) modes(4) campaign(4) robotics(2) workflow(1)
                                          ↑ 共享层 core 反向依赖具体模式
modes   → core(21) kernel(9) campaign(2)
robotics→ core(66) subagent(11) workflow(5) modes(1)
subagent→ core(16)
routing → core(19) subagent(3) kernel(3) modes(1)
tools   → core(61) subagent(7) kernel(2)
```

期望的依赖方向是单向向下：`routing → modes(robotics/campaign/agentic) → core → kernel`，外加 `subagent`/`tools` 作为被依赖的叶子。实测有三处反向边。

> 注：§1 各小节为**修复前**的原始分析。修复后实测（见 §5.1）：三处反向边全部消除——
> `core → robotics`、`core → campaign`、`kernel → core` 真实 import 均为 0；新增的 `infra/`
> 层是自包含叶子（不 import core/robotics）。下文保留作为问题背景。

### 1.1 [高] ✅ 已修复 — 共享 prompt 构建器硬编码 campaign，且与 robotics 的注入机制不一致
`core/dynamicPrompt.ts`（1245 行）与 `core/staticPrompt.ts` 满是 `mode === 'campaign'` / `mode === 'agentic'` 分支，并**直接 import campaign 内部**：

```
core/dynamicPrompt.ts:47  import { MetaAgentContextStore, USER_CHECKPOINT_PHASES, MACHINE_PHASES } from '../campaign/index.js'
core/dynamicPrompt.ts:48  import { campaignRegistry } from '../campaign/registry.js'
```

D4b/D8/D9/D10、`campaign_knowledge`、`phase_guidance`、V&V 响应规则等都写死在共享构建器里，按 `mode` 开关。

对照之下，`buildDynamicSections({ modeExtensions })` / `buildVolatileContextSections({ volatileExtensions })` **已经提供了干净的注入点**，`RoboticsSession` 正是用它把 R1–R6 当作参数传进去（共享层对 robotics 一无所知）。

**问题**：campaign 没走这条路，而是把自己焊进了 core。结果：
- core 这个「共享」层其实编译期硬依赖 campaign，无法在不带 campaign 的前提下构建；
- 出现两套扩展范式（注入 vs 硬编码分支），新人加模式不知道该用哪套；
- 加一个有 prompt 段的新模式，若照 campaign 范式，又要回来改 `dynamicPrompt`/`staticPrompt` 的 `if`。

**建议**：把 campaign 的 D4b/D8/D9/D10/phase_guidance 改写为 `CampaignSession` 在 `modeExtensions`/`volatileExtensions` 里注入的 section（与 robotics 对齐），删除 `core/dynamicPrompt` 对 `campaign/*` 的 import 与 `mode === 'campaign'` 分支。共享层只保留模式无关的 D1/D2/D3 等，模式专属段一律由各自 Session 注入。

### 1.2 [中] ✅ 已修复 — core/auto 反向依赖 robotics —— 通用基础设施错位在 mode 包里
```
core/auto/learn/AutoExperienceStore.ts:20  import { ExperienceStore } from '../../../robotics/ExperienceStore.js'
core/auto/AutoWorktreeCoordinator.ts:20     import { GitWorkspaceManager } from '../../robotics/git/GitWorkspaceManager.js'
```
`GitWorkspaceManager`（git worktree 生命周期）和 `ExperienceStore`（带索引的经验持久化）本质是**通用基础设施**，却安家在 `robotics/`，于是 auto 模式被迫横向 import 另一个 mode 包。`GitWorkspaceManager` 还反向 import `robotics/types` 的 `RoboticsAgentRole`/`RoboticsGitState`，`ExperienceStore` 绑定 `RoboticsDomain` 且存储路径写死 `META_AGENT_HOME/robotics/experiences`——既是通用件又混入了 robotics 概念。

**建议**：把这两者下沉到中性位置（如 `core/git/`、`core/knowledge/`，或独立 `infra/`），把 `RoboticsAgentRole` 等 robotics 专属泛化为类型参数/泛型。这样 auto 与 robotics 都依赖共享 infra，而不是 auto → robotics。

### 1.3 [中] ✅ 已修复 — kernel → core/types 分层倒置
```
kernel/types/KernelTool.ts:9        import type { ToolPermissionDeclaration } from '../../core/types.js'
kernel/permissions/PermissionPolicy.ts:6  import type { AutonomyProfile, ToolPermissionDeclaration } from '../../core/types.js'
```
虽是 type-only（运行期零耦合），但 kernel 自称最底层，却向上取 `core/types` 的类型，导致 kernel 无法独立抽取，`core/types.ts` 沦为 kitchen-sink。
**建议**：把 `ToolPermissionDeclaration`/`AutonomyProfile` 定义下沉到 `kernel/types`，core 再 re-export 给上层用。

### 1.4 [中] ✅ 已修复 — core/compact → campaign
```
core/compact/compactPrompt.ts:17    import { MetaAgentContextStore } from '../../campaign/index.js'
core/compact/stateSnapshot.ts:32    import { MetaAgentContextStore, CampaignStateStore } from '../../campaign/index.js'
```
与 1.1 同源：共享的压缩/状态快照代码知道 campaign 的状态存储。加一个有自定义状态快照的模式，又得回来改 `core/compact`。
**建议**：压缩侧的状态注入也走 thunk/回调（agentic/robotics 的 `compact.customInstructions`/`deterministicAnchors` 已是这个模式），让 campaign 把自己的快照作为注入值传入，而非被 core 主动读取。

---

## 2. SessionRouter ↔ 后端契约

### 2.1 [中] ✅ 已修复 — 模式特有能力全靠 `as any` 逃逸（7 处）
`SessionImpl` 接口只覆盖 `submit/registerTool/interrupt/steer?/compactNow?/getMessages/getUsage/getEstimatedCost/getSessionId`。所有 robotics 专属能力（`pendingExperiences`、`pendingPhysicalAnchors`、`pendingPrinciples`、`proposePrincipleForExperience`、`reinforce…`、`evaluatePromotion…`、`invalidateAnchors`）都通过 `this._impl as any` 访问：

```
routing/SessionRouter.ts:475,488,500,511,521,529,538  const impl = this._impl as any
```

`RoboticsTeamController`（~25 个可选方法）虽是显式 interface，但也是 `as RoboticsTeamController` 强转得到。后果：robotics 改名/删方法时，router 的访问器**编译期不报错**，只在运行时 `undefined`。这是 router 与 robotics 之间的隐性强耦合。

**建议**：定义一个可选能力接口（如 `RoboticsCapabilities`），让 `RoboticsSession implements` 它，router 用类型守卫（`'pendingExperiences' in impl`）或一个 `getCapabilities()` 返回 typed 视图，避免 `as any`。宽达 25 个方法的 `RoboticsTeamController` 也提示「团队能力」更适合作为 router 持有的一个独立 controller 对象，而不是摊进 Session。

### 2.2 `_createImpl` switch 是合理的扩展点
`switch (mode)` 里 agentic/auto 共用 `_createAgenticBackend(overrides)`、campaign/robotics 各一分支——清晰且被 `SessionMode` 穷举检查保护。加模式在这里加一个 case 是可接受的集中点。✅

---

## 3. 内聚度 / 大文件

| 文件 | 行数 | 混合的职责 |
|---|---|---|
| `robotics/RoboticsSession.ts` | 1766 | 会话生命周期 + 经验候选预载/本地打分/flash 选择 + ~20 个 `team*` 透传 + workflow 修复 + compact 指令 + agent-mode 分类 + principle 晋升 |
| `core/dynamicPrompt.ts` | 1245 | 模式无关段 + campaign 专属段（见 1.1） |
| `subagent/SubAgentBridge.ts` | 1173 | 调度 + 预算核算 + 重试 + worktree 生命周期对账 + 通知队列 + 末尾还挂了个 prompt-section 自由函数 |
| `routing/SessionRouter.ts` | 821 | 路由 + 三套 side-call client + memory 预取 + auto 协调器装配 + robotics/team 透传 |

### 3.1 [中] RoboticsSession 是 god-object
最突出的是 ~20 个 `teamInit/teamJoin/teamTake/teamNote/teamSync/teamPush/…` 几乎都是「`invalidate('robotics_team_mode')` + 转发 `TeamStore` + `forceSync`」的薄包装，存在的唯一理由是让 `SessionRouter`（再让 CLI）够得着。这把「团队协作」这一独立关注点摊进了会话类。经验预载/打分（`_preloadExperienceWorkingSet`、`_rankExperienceCandidates`、`_selectApplicableExperiences`）也是可以独立成 `ExperienceWorkingSet` 协作者的一块。
**建议**：抽出 `RoboticsTeamController`（真正的对象，不是 interface 摆设）和 `ExperienceWorkingSetManager`，`RoboticsSession` 持有它们并暴露 getter，瘦身到「装配 + 提交循环 + 生命周期」。

### 3.2 [低] SubAgentBridge 末尾的 `buildSubAgentNotificationSection` 是异类
调度器类文件里挂了个构建 prompt 段的自由函数（不同关注点）。移到 prompt 层即可。其余调度/预算/重试/worktree 虽多但围绕「子代理生命周期」尚算内聚。

### 3.3 [低] 命名/范式一致性
`MetaAgentSession`（agentic/auto 的后端）与 `RoboticsSession`/`CampaignSession` 是平级后端却命名不对称（一个叫 MetaAgent，两个叫 XxxSession）。建议统一为 `AgenticBackedSession` 或在 router 注释里点明三者同为 `SessionImpl` 实现，降低阅读门槛。

---

## 4. 可扩展性实测：加一个新模式要碰几处？

当前（mode 字面量散落 22 个非测试文件）：

| 必改 | 文件 | 性质 |
|---|---|---|
| ✅ 集中 | `core/modes.ts` `MODE_PROFILES` | 穷举 Record，编译器逼你填全字段——好 |
| ✅ 集中 | `routing/SessionRouter._createImpl` | 加一个 case |
| ⚠ | 新 `SessionImpl` 后端类 | 必要 |
| ⚠ | `routing/ModeDetector` | 加检测启发式（除非像 auto 仅显式进入） |
| ❌ 分散 | `core/dynamicPrompt.ts` + `core/staticPrompt.ts` | **若照 campaign 范式**要加 `if (mode===…)`；若照 robotics 范式则零改动 |
| ❌ 分散 | `core/compact/*` | 若有自定义状态快照（campaign 范式） |
| ❌ 分散 | `SessionRouter` 的 `as any` 访问器 | 若暴露模式专属 CLI 能力 |

**结论**：`modes.ts` 这层做得很好；真正的扩展摩擦集中在 prompt/compact 共享层的 campaign 硬编码（1.1/1.4）和 router 的 `as any`（2.1）。把这两类收敛到「注入式」，新模式就能做到「只碰 modes.ts + 一个后端类 + 一个 detector 分支」。

---

## 5. 建议（按优先级，仅建议）

1. **[高]** 统一模式扩展机制：campaign 的 prompt 段改用 `modeExtensions`/`volatileExtensions` 注入（对齐 robotics），删除 `core/dynamicPrompt`/`staticPrompt` 对 `campaign/*` 的 import 与 `mode==='campaign'` 分支。这是消除「假共享」的关键一步。
2. **[中]** 下沉通用 infra：`GitWorkspaceManager`、`ExperienceStore` 移出 `robotics/` 到中性位置并去 robotics 类型耦合，让 `core/auto` 不再依赖 `robotics`。
3. **[中]** compact 状态注入改回调式（1.4），core/compact 不再 import campaign。
4. **[中]** 用 typed capability 接口 + 类型守卫替换 router 的 7 处 `as any`（2.1）。
5. **[中]** 把 `ToolPermissionDeclaration`/`AutonomyProfile` 下沉到 `kernel/types`，修正 kernel→core 倒置（1.3）。
6. **[中]** 从 `RoboticsSession` 抽出 `TeamController` 与 `ExperienceWorkingSet` 两个协作者（3.1）。
7. **[低]** `buildSubAgentNotificationSection` 迁到 prompt 层；后端命名对称化。

> 这些都是结构性重构，建议分步、每步独立可回归（现有测试 808 条是安全网）。优先做 #1，因为它同时解决 1.1/1.4 的根因并把可扩展性拉回 modes.ts 一处。

---

## 5.1 实施状态（2026-06-18 同日落地）

全程保持 `tsc --noEmit` 干净、`vitest` 808 通过。

| # | 项 | 状态 | 落点 |
|---|---|---|---|
| 1 | campaign prompt 段去硬编码（[高]） | ✅ 已完成 | D4b/D8/D9/D10 + V&V 规则移至 `campaign/promptSections.ts`；`core/dynamicPrompt` + `core/staticPrompt` 删除全部 campaign import 与 `mode==='campaign'` 分支。**`core` 现在零 campaign import**。行为不变（campaign 自有 `_buildEnrichedSuffix` 注入路径，这些段在生产中本就不经共享构建器）。 |
| 3 | compact 去 campaign 耦合 | ✅ 已完成 | `compactPrompt.ts`/`stateSnapshot.ts` 移至 `campaign/compact/`；`core/compact` 不再 import campaign。 |
| 2a | GitWorkspaceManager 下沉 | ✅ 已完成 | 移至 `infra/git/`，类型中性化（`WorktreeRole`/`GitWorkspaceState`），`robotics/types` 以别名 re-export；**`core/auto` 不再 import robotics 的 git 管理器**。 |
| 4 | router 去 `as any` | ✅ 已完成 | `robotics/contracts.ts` 定义 `RoboticsCapabilities`/`RoboticsTeamController`，`RoboticsSession implements` 两者（编译期校验）；router 用 `_roboticsImpl()` 单点类型守卫，删除 7 处 `as any`。 |
| 5 | kernel→core 类型倒置 | ✅ 已完成 | `ToolPermissionDeclaration`/`AutonomyProfile`/`ToolPermissionCategory` 移至 `kernel/types/Permissions.ts`，`core/types` re-export。 |
| 7a | notification section 迁出调度类 | ✅ 已完成 | `buildSubAgentNotificationSection` 移至 `subagent/notificationSection.ts`。 |
| 2b | ExperienceStore 下沉 | ✅ 已完成 | 连同级联依赖一起下沉到 `infra/`：`metaAgentHome`、`persist/`（均留 `core/` re-export shim，45 个 import 站点零改动）、经验类型簇（`infra/knowledge/types.ts`，中性名 `KnowledgeDomain`，`robotics/types` 以 `RoboticsDomain` 别名 re-export）、`ExperienceStore`（`infra/knowledge/`，`robotics/ExperienceStore` 留 shim）。`core/auto` 现在 import `infra/knowledge`。**结果：`core` 零 `robotics` import；`infra` 是自包含叶子（不 import core/robotics）；`kernel` 零 `core` import。** 无包级环。 |
| 6 | 从 RoboticsSession 抽出 TeamController + ExperienceWorkingSet | ✅ 已完成 | `RoboticsTeamCoordinator`（~20 团队操作 + Plan-B 边界状态，借用 `invalidate` 回调）+ `ExperienceWorkingSetManager`（候选缓存/排序/flash 选择 + slot 注入）。`RoboticsSession` 1766 → 1329 行；router 经 `getTeamController()` 取协调器；agent team 工具以协调器为 host。行为不变（纯搬迁）。 |
| 7b | 后端类命名对称化 | ⏸ 暂缓 | `MetaAgentSession` 有 40+ 引用，纯命名 [低]，churn/风险不划算。 |

新增回归测试沿用既有套件；本轮重构均为行为保持型（dead-code 搬迁 / 类型搬迁 / 文件搬迁），无新增行为。

---

## 6. 已经做对、不要动的设计

- `core/modes.ts` 单一事实源 + 编译期 `Exact<SessionMode, CompactProfile>` 锁。
- kernel 以 hook 注入行为（`verifyGate`/`driftGate`/`onCheckpointBoundary`/`canUseTool`），从不反向 import 模式实现——分层意图正确。
- `buildDynamicSections({ modeExtensions })` 注入式 section——**这就是应推广到所有模式的范式**。
- `PermissionPolicy` 只认 `AutonomyProfile` 的布尔（`lockWorkspace`/`autoApproveInWorkspace`/`deniedTools`），从不认 `SessionMode`——mode→profile 映射留在 routing 层，策略层与模式解耦，教科书级。
- `_createImpl` 中 agentic/auto 共用后端、仅靠 `agenticOverrides` 区分——复用得当。
