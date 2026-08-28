# auto 唤醒 fence 事故 — 根因与修复

> 日期：2026-08-27
> 影响：一次无人值守 run（$23.73、290k input token）在可恢复的停止点被判死
> 症状：`fence rejected … history moved on: loaded 826 messages, wake was armed at 818` → `cancelled`（终态）

## 1. 事故链

| # | 环节 | 位置 |
| --- | --- | --- |
| 1 | judge 完成审核，但输出散文而非带 `done` 布尔的 JSON | `VerifyJudge.parseVerdict` |
| 2 | 两个通道（`return_result.data` / 尾部 JSON 块）均未命中 → `null` | `verdictChannel.parseFromVerdictChannels` |
| 3 | gate 返回 `skipped`，KernelLoop 按 `autoGateMaxAttempts`=2 重跑整个 judge，仍 skipped | `KernelLoop:1519` |
| 4 | 默认策略 `checkpoint_pause` → `done('auto_verify_unavailable')` | `KernelLoop:1560` |
| 5 | 映射为 `error_during_execution` | `KernelSession:923` |
| 6 | **post-turn 检查抛出普通 Error** | `singleTurn.ts:441`（修复前） |
| 7 | 调度器按「普通 Error = turn 未运行，可安全重试」重试 | `AutoScheduler:230` |
| 8 | 重试撞上 history fence（826 ≠ 818）→ `cancelled` | `singleTurn.ts:367` |
| 9 | `cancelled` 是终态，会话再不会被唤醒 | `isTerminalWakeStatus` |

**第 1–5 步全部是设计意图**：无人值守时不采信模型自称完成。真正的缺陷是第 6 步，它把「本轮无法验证，下次继续」变成了「会话永久死亡」。

## 2. 根因

`AutoWakeConsumedError` 这个护栏早就存在，它的 docstring 甚至一字不差地预言了本次事故：

```
 *   attempt 1 → turn runs, history grows, arming throws → scheduler retries
 *   attempt 2 → history.length !== record.historyMessageCount → cancelled (terminal)
```

但它只包住了 `runSingleTurn` 这一次**调用**：

```ts
try {
  turn = await runSingleTurn(...)
} catch (error) {
  throw new AutoWakeConsumedError(record.sessionId, error)   // 只覆盖「抛异常」
}
const result = turn.result
if (result.subtype === 'error_during_execution') {
  throw new Error(...)      // ← 「返回错误结果」，同样在 turn 之后，却是裸 Error
}
```

「turn 抛异常」和「turn 正常返回一个错误结果」在时间上是**同一个位置** —— 都在这一轮已经跑完、已经往 history 写入之后。但只有前者被分类为「已消费」。

调度器的契约是明写的：*"Everything else failed BEFORE the turn ran, so the wake is still unconsumed and safe to retry."* 它收到裸 Error 就照此执行 —— 而这个前提在第 441 行的路径上是假的。

## 3. 修复

### 3.1 把整个 post-turn 区域包起来（`singleTurn.ts`）

不再逐个抛出点分类，而是划出一条**消费边界**：`runSingleTurn` 之后的所有代码 —— turn 调用、结果检查、checkpoint 更新 —— 统一走 `withConsumedWakeGuard()`，任何抛出都被标记为 `AutoWakeConsumedError`。

这样将来新增第三条 post-turn 失败路径时，无需任何人记得去分类它。已标记的错误原样透传，不会二次包裹掩盖原因。

### 3.2 调度器重试前的 fence 探针（`AutoScheduler.ts`）

新增可选 `isWakeStillRunnable`。重试之前问一句：这条记录现在还能通过 fence 吗？答否则说明 turn 确实跑过了 —— 无论错误类型怎么说 —— 重试唯一能达成的结果就是那次 `cancelled`。

三条设计约束：

- **探针缺席或抛错 → 视为「说不准」→ 照常重试**。探针是兜底，不是闸门；因探针故障而压制合法重试，正是这套机制要避免的另一面伤害。
- **已标记 `AutoWakeConsumedError` 的路径不走探针**。那条判断本身是确定的，不能让探针故障把它变回重试。
- **探针复用 `checkResumeFences()`，与真实 fence 同源**。另写一份平行实现必然漂移，而与 fence 不一致的探针比没有探针更糟。

为此把 `resumeAutoContinuation` 里的 fence 判断抽成 `checkResumeFences()`，两处共用。

### 3.3 attached 路径的同一个洞（`AttachedAutoScheduler.ts`）

attached 与 detached 共用 `resumeAutoContinuation`，因此同样会收到 `AutoWakeConsumedError`；但它的 catch 一律 `release(..., 'pending', current.fireAt)` —— 把一个 fence 已失效、fireAt 已过期的 wake 交还队列。下一个调度器认领它 → 同样 `cancelled`，只是晚一跳。

修复：`AutoWakeConsumedError` 释放为 `done` 并说明原因；普通失败的重新入队行为不变。

### 3.4 让 judge 的「部分完成」有确定落点（`VerifyJudge.ts`）

原 rubric 只说了 `done=true 时 unfinished 必须为空数组`，从未说明**部分完成**该往哪放。而本次 judge 恰恰处在这个状态 —— 你贴的原文里「验收指标已达成的实测证据……」与「剩余为位置精度/完成率/间隙判据，需……修复后收敛」并存。模型在拿不定主意时倾向于写散文。

新增规则：`done` 是二值判断，没有第三种取值；部分达成、有已知遗留、证据不足确认，**全部**记 `done: false` 并逐条写进 `unfinished`。

并且明确告知**后果**——散文会被判定为「无法裁决」，整轮作废并重跑一次完整 judge。给模型一个承诺布尔值的理由，比单纯下指令更有效。

### 3.5 顺带：judge 自身预算旋钮的宽松解析

`verifyEnvInt/Float` 仍在用 `parseInt/parseFloat`（8-27 评审 P2-3 同类）。`META_AGENT_VERIFY_MAX_TURNS=1oops` → 1，一个单轮 judge 无法取证、因而无法给出裁决 —— 正好复现本文开头那个 "verify unavailable" 停止。已改为全串严格解析。

## 4. 修复后这次事故的走向

judge 解析失败 → 停止 → 日志给出：

```
[auto-scheduler] wake consumed for <session> (<wake>) but the turn failed afterwards
— NOT retrying (a retry would cancel the session). Cause: verify skipped: 无法解析 judge 裁决 JSON.
Session history is persisted; resume it with:
meta-agent --mode auto --resume <session> "继续"
```

会话完好保留，等待人工或后续唤醒继续。

## 5. 验证

```text
npm run typecheck        PASS
npm test                 302 files / 3402 tests，全绿（此前 301/3381）
npm test (符号链接 TMPDIR) 302 files / 3402 tests，全绿
npm run test:integration  11 + 6，全绿
npm run check:manifest   PASS
npm run version:check    PASS (0.9.5)
```

新增 21 个回归用例。三处修复均已**实测**对修复前代码失败：

| 用例组 | 对修复前代码 |
| --- | --- |
| `autoResumeConsumedWake.test.ts`（8 例） | 6 例失败 |
| `AutoScheduler.test.ts` 探针组（6 例） | 2 例失败（其余为「不应改变的行为」正向断言） |
| `AttachedAutoScheduler.test.ts` 消费组（3 例） | 覆盖 attached 路径的 done/pending 分流 |

其中最关键的一例直接复刻了事故的错误文本：

```ts
async () => { throw new Error(
  'Stopped (auto mode): completion could not be independently verified. ' +
  'Reason: verify skipped: 无法解析 judge 裁决 JSON') }
```

## 6. 说明

本次未改变任何成功路径语义。行为收紧仅两处，方向都是 fail-safe：post-turn 失败不再被重试，consumed wake 不再被重新入队。
