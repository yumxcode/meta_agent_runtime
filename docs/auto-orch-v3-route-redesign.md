# auto_orch loop v3 — mode / route / status 重设计（2026-07-09）

> 目标：每一个状态、每一个标签、每一个步骤语义与动作完全对齐。凡是内核不会执行的取值，
> 在类型上就不存在；凡是账本里出现的词，都恰好有一个产生者。

## 0. v2 的病灶（本次修复清单）

| # | 病灶 | v3 修复 |
|---|---|---|
| 1 | `TripwireAction {mode?, escalate?, stop?}` 可组合出 8 种形态，内核只解释 3 种 | 判别联合三选一，无效组合不可表达 |
| 2 | validator 把 `mode:'finalize'` 当终止绊线，内核却不停（可无限跑） | validator 与内核语义同一来源：`act:'finalize'` 就是终止 |
| 3 | `mode:'finalize'` 写出 progress `completed` 但 loop 继续跑 | `completed` 只有终止路径能写 |
| 4 | `mode:'attention'` 无任何内核分支（死标签） | 删除；旧值迁移为 `{act:'escalate',reason:'attention'}` |
| 5 | 绊线每轮求值两次（轮首 MODE + 轮末 ROUTE），pivot 靠重复命中间接生效 | 单点求值（ROUTE）；pivot 是一次性调度指令 |
| 6 | re-arm 后同一 escalate 绊线立即再命中 → 原地再暂停 | re-arm 重置触发绊线的 meters（onResume/默认 AST 引用集） |
| 7 | `statusFor` 硬编码魔法名 `stale_count` | charter 可声明 `health.staleWhen`；无则显式回退约定 |
| 8 | route 是字符串拼接（`finalize+stop` / `mode:pivot`），词汇横跨三个命名空间 | `RouteDecision` 结构化对象，渲染集中在 `renderRoute` |
| 9 | pivot 绊线在缺 pivoter 座位时静默退化 | validator 双向强制 pivot ⇔ pivoter |

## 1. 三条不变式

1. **一词一域**：轮模式（RoundMode）、路由动作（RouteDecision）、实例状态（LoopInstanceStatus）、
   工作状态（ProgressStatus）是四个独立命名空间，词汇不复用。
2. **语义即行为**：每个枚举值对应内核恰好一条代码路径。类型上用判别联合让无意义组合不可表达。
3. **单点求值**：绊线每轮恰好求值一次（轮末 ROUTE、最新 meters）；结果要么立即执行
   （finalize/escalate），要么持久化为下一轮的显式指令（pivot → `progress.nextRoundMode`）。

## 2. 管线

```
WAKE ▶ RECONCILE ▶ MODE ▶ CAPSULE ▶ SEAT ▶ GATE ▶ METER ▶ LEDGER ▶ ROUTE
```

- **MODE**（不读绊线）：① 内置预算守卫——lifetime 预算已耗尽则一分钱不再花，按
  `terminalRouteForExhaustion` 终止（charter 若有命中的 escalate/finalize 绊线可接管这个边界，
  否则内核 finalize(budget)）；② 消费上一轮 ROUTE 留下的一次性 pivot 指令。
- **ROUTE**（唯一绊线求值点）优先级：
  1. 内置验收：judge `goal_satisfied=true` → `finalize(accepted)`；
  2. 首个命中的 charter 绊线（声明序）；
  3. 内置预算兜底（本轮成本入账后重新计算，不浪费空轮）→ `finalize(budget)`；
  4. continue。
- **分工不变式**：内核独占"loop 是否还允许跑"（预算、验收）；charter 独占"何时转向/收尾/叫人"。

## 3. TripwireAction（判别联合）

```ts
type TripwireAction =
  | { act: 'pivot' }                                          // 调度下一轮为转向轮（一次性）
  | { act: 'finalize'; reason?: string }                      // 优雅终止
  | { act: 'escalate'; reason: string;                        // 暂停交人（非终止）
      onResume?: { resetMeters: string[] } }
```

| act | ROUTE 行为 | 终态 |
|---|---|---|
| pivot | 写 `progress.nextRoundMode='pivot'`；下一轮 MODE 消费并清除；pivoter 跑一次、directive 注入胶囊 | 不终止 |
| finalize | （可选）finalizer 座位补叙事 → final_report.md → 取消 wakes → instance `done` | `completed` |
| escalate | attention_report.md → 取消 wakes → instance `paused_attention`；`record.lastEscalation` 记录命中绊线 | 等人 |

**re-arm**（`loop migrate` = human ack）：重置触发绊线的 meters——显式 `onResume.resetMeters`
优先，默认 = 绊线表达式 AST 引用的标识符 ∩ meters（`lastEscalation.tripwireIndex` 缺失时对全部
escalate 绊线取并集）。保证恢复后不会原地再暂停。审计入 `migrations.jsonl.resetMeters`。

## 4. 四个状态命名空间

- **RoundMode** = `'normal' | 'pivot'`。终止不是模式。旧账本的 `finalize/attention` 读入时归一化为 normal。
- **RouteDecision** = `{kind: continue|pivot|finalize|escalate, cause?: accepted|budget|tripwire, tripwireIndex?, reason?}`，
  写入 `rounds.jsonl.route`（旧字符串 route 读取容忍，`renderRoute` 统一渲染）。
- **ProgressStatus**（progress.json，route 的全函数，每值恰一个产生者）：

  | 值 | 产生者 |
  |---|---|
  | `healthy` / `stale` | route=continue（health 规则） |
  | `pivot_scheduled` | route=pivot |
  | `paused_attention` | route=escalate（与实例状态同词——同一事实） |
  | `completed` | route=finalize（accepted/budget/tripwire 三入口，仅此） |

  health 规则：`charter.health.staleWhen`（true→stale）；未声明回退 `stale_count>0` 约定；两者皆无恒 healthy。
- **LoopInstanceStatus** 不变：`idle|running|waiting|paused_attention|done|failed`（新增可选
  `record.lastEscalation`，re-arm 时消费并清除）。

## 5. 座位

- pivoter：不变；validator **双向强制** pivot 绊线 ⇔ pivoter 座位（任一侧缺失都是 create 时错误）。
- **finalizer（新，可选）**：isolated、无工具、证据内嵌（默认 `ledger/progress.json`、`findings.jsonl`、
  `directions.json`）。仅在优雅 finalize 时跑一次，产出 `{"narrative": …}` 渲染进 final_report 的
  "Narrative (finalizer seat)" 段；fail-open（座位失败不影响代码模板报告）；成本计入 progress.totalCostUsd。

## 6. 迁移与兼容

- **charter 加载层自动迁移**（`normalizeCharter`，validate/freeze/loadInstance 全部入口）：
  `{escalate:x}`→`{act:'escalate',reason:x}`；`{stop:true}` 与 `{mode:'finalize'}`→`{act:'finalize'}`；
  `{mode:'pivot'}`→`{act:'pivot'}`；`{mode:'attention'}`→`{act:'escalate',reason:'attention'}`。
  映射保持旧内核实际优先级（escalate > stop/finalize > pivot）。幂等、确定性；磁盘冻结快照与 hash 不动。
- 旧 `rounds.jsonl` 的字符串 route / 旧 mode 值：读取容忍（renderRoute / normalizeRoundMode）。
- progress.status 旧词（`pivot_required`、`attention_required`）不再产生，消费方（CodeNodeAuthor
  示例词表、reduce 图）已同步为新词表。
- Distiller system prompt 已注入 v3 全套语义（管线、三动作、内置终止、health、finalizer、onResume），
  蒸馏出的 charter.draft.json 直接是 v3 形态。

## 7. 回归测试锚点

`src/loop/__tests__/routeV3.test.ts`：pivot 一次性（调度→消费→清除，pivoter 恰跑一次）、
status 词表逐轮断言、escalate→migrate→重置→真跑一轮不复暂停、finalizer 叙事+成本入账。
`charter.test.ts`：判别联合校验、onResume/health 静态检查、pivot⇔pivoter 双向、旧形态迁移映射。
`m3m4.test.ts`：预算三路径（rounds/usd/deadline）在新单点求值下的轮数与终态。
