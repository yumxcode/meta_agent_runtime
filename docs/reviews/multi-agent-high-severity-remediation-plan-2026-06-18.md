# 多智能体架构 — 三处 [高] 问题整改方案

日期：2026-06-18 · 配套文档：`multi-agent-architecture-review-2026-06-18.md`
范围：①统一协作抽象 ②事件总线重命名/迁移 ③静态 bridge Map 泄漏
原则：每一步都**可单独合并、可回滚**，行为不变的重构与改行为的重构分开提交。

建议落地顺序（按风险/收益）：**②（半天）→ ③（1 天）→ ①（分 4 个 PR，1–2 周）**。
②③是低风险高收益的"先还的债"，①是结构性改造，放在地基稳定后做。

---

## ② 事件总线重命名 + 迁移（先做，最低风险）

### 现状
运行时单例 `CampaignEventBus` 物理上在 `src/subagent/`，却承载 `subagent:*` 与 `phase:transitioned` 两类事件；campaign 子系统反而不用它（走 `CampaignStateStore` 轮询）。命名误导模块归属。

**好消息**：实测运行时引用面极小，只有 5 个文件：
```
src/subagent/CampaignEventBus.ts        (定义)
src/subagent/types.ts                    (CampaignEventMap)
src/subagent/index.ts                    (re-export)
src/subagent/SubAgentBridge.ts           (on/off/emit)
src/subagent/SubAgentRunner.ts           (emit)
```
其余命中全是注释或无关的 `campaign` 字样。

### 方案
1. **新建** `src/runtime/AgentEventBus.ts`（runtime/ 已是叶子层，适合放跨切面单例），内容为现 `CampaignEventBus.ts` 原样搬迁：
   - `class TypedAgentEventBus` / `export const AgentEventBus`
   - 保留 `setMaxListeners(100)`（但见 §③ 会改成动态校验）。
2. **事件类型**从 `subagent/types.ts` 抽到 `src/runtime/agentEvents.ts`：
   - `CampaignEventMap → AgentEventMap`
   - 事件名维持 `subagent:completed/failed/checkpoint` 与 `phase:transitioned` 不变（**只改类型/总线名，不改事件字符串**，避免任何运行期行为变化）。
3. **更新引用**：`SubAgentBridge.ts`、`SubAgentRunner.ts` 改 import 路径与符号名。
4. **向后兼容**：在 `src/subagent/index.ts` 保留一行 deprecated 别名，给下游一个 release 的过渡窗：
   ```ts
   /** @deprecated 改用 runtime/AgentEventBus。下个 minor 移除。 */
   export { AgentEventBus as CampaignEventBus } from '../runtime/AgentEventBus.js'
   export type { AgentEventMap as CampaignEventMap } from '../runtime/agentEvents.js'
   ```
5. **文档**：在 `docs/architecture/meta-agent-architecture.md` 标注"AgentEventBus 是进程内单例，仅单进程；跨进程协调走 git（team）或未来 IPC"。

### 测试 / 验收
- `grep -rn "CampaignEventBus" src --include=*.ts | grep -v @deprecated` 应只剩别名行。
- 全量 `vitest` 通过（事件字符串未变，子 agent 通知/重试用例应零改动）。
- 类型检查 `tsc --noEmit` 通过。

### 回滚
单 PR，纯符号/路径变更 + 别名兜底，`git revert` 即可。

---

## ③ 静态 bridge Map 泄漏：从"靠约定"改为"结构保证"（再做）

### 根因（已核实）
- `SubAgentBridge._bridgesBySessionId` 是 `static` **强引用**；bridge 还把 `_onCompleted/_onFailed` 挂在事件总线单例上（同样强引用）。两条强引用链 ⇒ 只有 `dispose()` 真正跑过（`off()` + `map.delete()`）bridge 才能释放。
- `dispose()` 目前依赖**每个 owner 记得调**：`SessionRouter:422`、`RoboticsSession:893` 各自调一次。
- 已存在 `static disposeAll()`，但**全代码库无任何调用点**——没有进程退出兜底。
- 两个构造点还各自重复写了"先 `getBridge(id)?.dispose()` 再 `new`"的去重逻辑（`SessionRouter:712`、`RoboticsSession:451`），说明泄漏隐患已被 workaround 绕，而非根治。
- 注意：因为存在上述强引用，`WeakRef`/`FinalizationRegistry` **救不了**——bridge 在被 `off()` 之前永不可回收，弱引用方案无效。正解是**保证 dispose 一定执行**。

### 方案（三层，逐层加固）

**第 1 层 — 工厂收口（消除重复的 owner 逻辑）**
新增 `src/subagent/bridgeRegistry.ts`：
```ts
export function acquireBridge(
  sessionId: string,
  opts?: SubAgentBridgeOptions,
): Promise<SubAgentBridge> {
  // 原子化：先 dispose 同 sessionId 的旧 bridge，再构造新的
  await SubAgentBridge.getBridge(sessionId)?.dispose()
  ensureProcessExitHook()      // 见第 2 层，幂等
  return new SubAgentBridge(sessionId, opts)
}
```
- `SessionRouter:712` 与 `RoboticsSession:451-452` 改成 `await acquireBridge(...)`，删掉两处重复的 pre-dispose。
- 构造点唯一化后，"创建即注册退出兜底"无法被遗漏。

**第 2 层 — 进程退出兜底（接上已有的 disposeAll）**
在 `bridgeRegistry.ts` 里一次性注册（幂等 guard，避免重复挂 listener）：
```ts
let hooked = false
function ensureProcessExitHook() {
  if (hooked) return
  hooked = true
  const drain = () => { void SubAgentBridge.disposeAll() }
  process.once('beforeExit', drain)
  process.once('SIGINT', drain)
  process.once('SIGTERM', drain)
}
```
让早已存在却没人调的 `disposeAll()` 真正接上。

**第 3 层 — 泄漏可观测（开发期断言，替代失效的 FinalizationRegistry）**
- 把 `setMaxListeners(100)` 魔法数改成：bridge 构造时 `bus.setMaxListeners(Math.max(20, bus.listenerCount('subagent:completed') + 8))` 动态上调；并在超过软阈值（如 50）时 `console.warn` 一次，把"监听者只增不减"变成可见信号。
- 可选：`SubAgentBridge` 构造时若 `_bridgesBySessionId.size` 超过"活跃 session 数 + 余量"，打印告警——泄漏会立刻在日志里冒头。

**第 4 层（长期，可选）— 显式资源管理**
TS 5.2 `await using`：给 `SubAgentBridge` 实现 `[Symbol.asyncDispose]() { return this.dispose() }`，让未来调用点写成 `await using bridge = await acquireBridge(id)`，由编译器保证作用域退出即释放。本次不强制，作为后续清理项记录。

### 测试 / 验收
- 新增 `bridgeRegistry.test.ts`：连续 `acquireBridge(sameId)` N 次后 `_bridgesBySessionId.size === 1`；每次旧 bridge 的 listener 已被 off（断言 `bus.listenerCount('subagent:completed')` 不随次数增长）。
- 退出钩子用例：手动触发 `disposeAll()`，断言 map 清空、无残留 timer（用假定时器）。
- 回归：`SessionRouter` / `RoboticsSession` 的 dispose 既有用例不变。

### 回滚
第 1–3 层互相独立，可分 PR；任一层 revert 不影响其它层（旧的 owner 调用路径仍在）。

---

## ① 三套协作形态的统一抽象（最后做，分阶段）

### 现状：三处各写一遍
| 关注点 | A. subagent | B. coordination | C. team |
|---|---|---|---|
| 通信 | EventEmitter | `CampaignStateStore` 文件轮询 | git + 文件轮询 |
| 调度/并发 | bridge 队列(4) | 手写信号量(4) | 无(对等) |
| 结果回注 | `pendingNotifications`→D-SubAgent 段 | capsule→`MetaAgentContextStore`→prompt | render 视图→prompt 段 |

通信层差异是**本质的**（进程内 vs 跨进程），不该强行统一成一个实现。真正重复、值得收敛的是**调度**与**结果回注**两个seam，以及缺一个共同**契约**让第四种形态有骨架可循。

### 设计：契约 + 两个共享件，而非大一统重写

**(1) 契约 `ICoordinator`**（`src/coordination/ICoordinator.ts`，纯接口、零实现改动）
```ts
export interface ICoordinator<TUnit, THandle, TResult> {
  /** 派活：提交一批工作单元，返回句柄（taskId / pointId / unitId）。*/
  dispatch(units: TUnit[], signal?: AbortSignal): Promise<THandle[]>
  /** 收结果：终态结果流（事件或轮询都归一成异步迭代/回调）。*/
  onResult(cb: (h: THandle, r: TResult) => void): () => void
  /** 回注：产出 <500 token 的上下文块，供 prompt 层统一拉取。*/
  snapshotForContext(): string | null
  dispose(): Promise<void>
}
```
A/B/C 各实现这个接口（适配层，不重写内核）：A 包 `SubAgentBridge`，B 包 `WorkerCoordinator+CampaignMonitor`，C 包 `RoboticsTeamCoordinator`。

**(2) 共享件一 `ConcurrencyGate`**（`src/runtime/ConcurrencyGate.ts`）
- 一个信号量/令牌桶工具，替换 bridge 队列里的并发计数与 `WorkerCoordinator` 的手写信号量。
- 关键收益：支持**层级配额**——主调度器持全局令牌，worker 内再 spawn 子 agent 时向同一全局桶申请，解决审查里"真实并发是两者乘积、无全局预算"的问题。

**(3) 共享件二 `ContextProviderRegistry`**（`src/runtime/ContextProviderRegistry.ts`）
- 一个进程内注册表：任何协作形态注册一个 `() => string | null` 的 context provider。
- prompt 构建层（`dynamicPrompt`）改成**遍历注册表**收集上下文块，而不是分别 import `MetaAgentContextStore` / drainNotifications / team render。这同时呼应既有架构审查 §1.1"共享 prompt 层硬编码 campaign 分支"的债——回注从"三条写死的线"变成"一个注册点"。

### 分阶段（每阶段独立可合）
- **Phase 0**：落 `ICoordinator` 接口 + `ConcurrencyGate` + `ContextProviderRegistry` 三个文件，**不接线**。纯新增，零风险。
- **Phase 1（回注统一）**：把 A/B/C 的回注改成向 `ContextProviderRegistry` 注册；`dynamicPrompt` 改为遍历注册表。这是收益最大的一步（删掉共享层对具体模式的 import）。配独立回归：注入内容逐字节比对改造前后快照。
- **Phase 2（调度统一）**：`WorkerCoordinator` 与 `SubAgentBridge` 内部并发限流替换为 `ConcurrencyGate`，启用全局配额。压测验证并发上限。
- **Phase 3（契约落地 + 验证）**：让 A/B/C 正式 `implements ICoordinator`；用一个**新的小型第四形态**（哪怕是 demo：顺序流水线协调器）证明"加形态不再各写三遍"。若第四形态能仅靠实现接口 + 复用两个共享件跑通，则抽象成立。

### 不做什么（范围护栏）
- 不统一通信传输（EventEmitter / 文件 / git 各保留）——强行统一会把 team 的跨进程模型塞进单进程总线，得不偿失。
- 不在本轮改 campaign 的 prompt 硬编码分支本身（那是既有架构审查的独立条目）；但 Phase 1 的注册表为它后续收敛铺好了路。

### 测试 / 验收
- Phase 1 验收线：`grep` 确认 `dynamicPrompt.ts` 不再直接 import `campaign/` 与 subagent 回注细节；上下文快照逐字节一致。
- Phase 2 验收线：构造"worker 内再 spawn 子 agent"场景，断言峰值并发 ≤ 全局上限（旧实现会超）。
- Phase 3 验收线：第四形态 PR 的 diff 不触碰 A/B/C 内核与 prompt 层。

### 回滚
Phase 0 纯新增可留存；Phase 1/2/3 各自独立 PR，按相反顺序 revert 即回到现状。

---

## 汇总：里程碑与工作量估计

| 序 | 项 | 风险 | 估时 | 产出 |
|---|---|---|---|---|
| 1 | ② 总线重命名+迁移 | 低 | 0.5 天 | 1 PR + 兼容别名 |
| 2 | ③ bridge 工厂+退出钩子+可观测 | 低-中 | 1 天 | 2–3 PR |
| 3 | ① Phase 0 三件套接口 | 低 | 0.5 天 | 1 PR（纯新增） |
| 4 | ① Phase 1 回注统一 | 中 | 3–4 天 | 1 PR + 快照回归 |
| 5 | ① Phase 2 调度统一 | 中 | 2–3 天 | 1 PR + 压测 |
| 6 | ① Phase 3 契约+第四形态验证 | 中 | 2–3 天 | 2 PR |

先做 1–3（一周内可清的低风险债），再推 4–6（结构改造）。每项都不依赖后项，可随时停在任一里程碑。
