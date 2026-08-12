# Robotics 模式场景手册：loop / compact / prompt 全行为示例

日期：2026-06-12（含 F-1/F-2/F-3 修复后的行为）
贯穿示例：用户在 X1 人形机器人上调平滑落地策略，目标合并到 `v9-smooth-landing` 分支。

---

## 场景 1：新会话第 1 轮 —— prompt 如何组装

用户输入：`帮我看看 X1 落地抖动的问题`

```
RoboticsSession.submit()
 ├─ 首轮：flash 分类 agent mode（single/multi；multi 需用户确认升级）
 ├─ QueryAnalyzer 并行启动（意图 → 经验预加载）
 ├─ 稳定 system prompt（仅变更时才 setAppendSystemPrompt，保 KV 缓存）：
 │    S1-S6 静态 + R1(域身份) + R4(硬件快照+staleness声明) + R5(里程碑快照) + W1/team
 ├─ 易变前缀（每轮重建，挂在 user 消息上）：
 │    <context>
 │      <memory>D1b: MEMORY.md 索引 + 按本句 query 召回的主题文件</memory>
 │      <experience_index>R2: manifest + 预加载经验槽位</experience_index>
 │      <subagent_status>R3: 活跃子代理表（无则省略）</subagent_status>
 │      <notifications>D11: 子代理完成通知（无则省略）</notifications>
 │    </context>
 │    ---
 │    帮我看看 X1 落地抖动的问题
 └─ KernelSession.submitMessage()
      └─ goal 捕获：第 1/3 条 → originalUserGoalParts = ["帮我看看 X1 落地抖动的问题"]
         （剥离 <context> 前缀后捕获，volatile 内容不进 goal）
```

要点：volatile 前缀**不进 system prompt**（保 DeepSeek KV 前缀缓存）；goal 锚捕获的是剥离前缀后的纯用户文本。

---

## 场景 2：第 2、3 轮 —— goal 锚填满、旧前缀剥离

第 2 轮：`曲线在 logs/run-42/，目标落地速度 < 0.45 m/s`
第 3 轮：`最终要合并到 v9-smooth-landing 分支`

```
每轮 submitMessage 开头：stripVolatileContextFromMessages(history)
  → 上一轮 user 消息的 <context> 前缀被剥掉，历史中任意时刻只有最后一条
    user 消息带前缀（旧的 memory/经验/通知不在历史中累积 → 噪音不滚雪球）

goal 锚（仅内存捕获，此后冻结，不再吸收新消息）：
  [user message 1] 帮我看看 X1 落地抖动的问题
  [user message 2] 曲线在 logs/run-42/，目标落地速度 < 0.45 m/s     (≤700 字符)
  [user message 3] 最终要合并到 v9-smooth-landing 分支              (≤700 字符)
```

注意：goal 锚**不在任何轮次的 prompt 中出现**——平时只存内存（零 token 成本），
**仅在压缩发生时**注入摘要文本，措辞为弱化表述并明确让位于用户的显式改目标：

> Original session goal (verbatim earliest user messages, captured at session
> start — they LIKELY reflect the user's original objective. Trust them over
> any paraphrase in summaries; but if the user later EXPLICITLY changed the
> goal, the user's later instruction prevails)

即：锚只用来压制**摘要转述漂移**，不压制用户中途合法变更目标。
第 4+ 轮的任何指令只存在于对话流/摘要里，不会改写这组捕获。

---

## 场景 3：中途 steering（不打断流）

模型正在跑第 7 个工具循环，用户按热键输入：`不要再改 reward，只调 lr`

```
KernelSession.steer() → 入队（turn 进行中才接收；idle 时入队会被下一次 submit 丢弃）
KernelLoop 下一个迭代边界（Step 0）：
  append(user 消息 { isSteering: true }，文本包装为：
    "[用户实时补充指导]\n不要再改 reward，只调 lr\n\n请将上述指导纳入考虑…")
→ 下一次 API 请求即可见；模型不被 abort，自然边界生效
```

steering 消息**不参与** goal 捕获（isSteering 被过滤），不会篡改原始目标。

---

## 场景 4：长会话触发 auto-compact（rich 摘要，正常路径）

第 40 轮后上下文接近阈值（effectiveWindow − 13k buffer）：

```
KernelLoop:
 1. shouldAutoCompact = true → yield compact_start
 2. RoboticsSession 截获 compact_start：刷新 R4/R5 快照、置 _forceExperienceCandidateLoad
 3. buildMessagesToKeepAfterCompact：
      keep-set = [最后非steering用户消息克隆{isKeepSetClone,sourceUuid}]
               + [≤40k token 的完整 assistant⇄tool_result 单元（原 uuid 保留）]
 4. compactConversation 侧调用（flash 模型，9 段结构化摘要提示
      + Robotics customInstructions 懒求值：活任务ID/phase/硬件安全限值/经验工作集）
 5. 摘要 3200 字符 ≥ 2000（rich）→ recent-detail 不附加，只追加：
      原始目标锚（场景2的三条，逐字）+ 窗口首/末用户请求一行锚
      + 工具活动统计 + Robotics 确定性状态锚（deterministicAnchors）
 6. 替换历史：
      [boundary] [summary] [keep-set…] [文件提醒: 压缩前读过的文件需重读]
```

压缩后模型看到：摘要（含目标锚）+ 最近工作现场逐字 + "文件需重读"提醒。

---

## 场景 5：auto-compact（terse 摘要）—— F-2 修复后的去重形态

同场景 4，但 flash 模型只返回 600 字符摘要（< 2000 阈值）：

```
enrichCompactSummaryWithContinuity(includeRecentDetail = true)
  排除集 = keep-set 全部 uuid ∪ 克隆的 sourceUuid          ← F-2 修复
  Recent User Requests / Assistant Progress / Tool Results 三节：
    只取排除集之外的消息 → 自然落在 keep-set 够不着的"中段区域"
    （即将被摘要折叠、且 terse 摘要没写好的部分 —— 兜底价值最大处）

修复前：尾部 m180-m185 在摘要内（1600字符裁剪版）和 keep-set（全保真）各一份
修复后：尾部只在 keep-set 一份；摘要内 recent-detail 配额全部用于中段
保留项：'Latest explicit user request' 一行定位锚（廉价、非内容保留）
```

---

## 场景 6：compact 模型空响应 → 本地 fallback 摘要

flash 模型返回空文本（或 3 次 PTL 重试耗尽）：

```
buildFallbackCompactSummary（纯本地、确定性，不再调用任何模型）：
  ## 1. Primary Request and Intent
     - Original session goal（三条目标锚，逐字）
     - First explicit user request
  ## 6. All User Messages（最近 8 条，排除 keep-set 覆盖项 ← F-2）
  ## 8. Current Work（最近消息行，排除 keep-set 覆盖项 ← F-2）
  + 既有摘要（最近 2 个）+ continuity anchors + Robotics 确定性锚
→ 会话继续推进而不是反复重试坏掉的 compact 模型直到撞 blocking limit
```

连续失败 3 次触发熔断（circuit breaker），此后不再尝试 auto-compact。

---

## 场景 7：请求已超限 → reactive compact

API 直接抛 PromptTooLongError（proactive 阈值漏判，如缓存 token 数过期）：

```
KernelLoop catch:
  未做过 reactive compact → yield compact_start → 强制 compactConversation
  成功 → 替换历史 → continue（同一轮重试）
  失败/已做过 → 返回 blocking_limit，向用户明示
```

---

## 场景 8：压缩后的下一轮 —— 快照刷新生效

```
下一次 submit()：
  稳定 prompt 重组：R4（硬件）/ R5（里程碑）用 compact_start 时刷新的新快照
    → setAppendSystemPrompt 仅在字节变化时调用
  R2 经验：_forceExperienceCandidateLoad=true → 候选池整体重载
  R3 子代理表：照常按活任务实时渲染（压缩不影响——数据在 RoboticsProjectStore，
    不在对话历史里）
```

状态分层是抗压缩的根本：**进程外持久化状态（任务ID/硬件/里程碑）压缩后照常注入；只有对话叙事依赖摘要。**

---

## 场景 9：跨会话 resume —— F-1/F-3 修复后的行为

前一会话历经 2 次压缩后关闭。用户 `--resume` 选中该会话：

```
SessionStore.loadHistory：history.jsonl 整对象反序列化
  → isCompactSummary / isCompactBoundary / isKeepSetClone / sourceUuid 全部在档
超过 MAX_RESUME_MESSAGES 时本地裁剪摘要 { isCompactSummary: true }   ← F-1 修复
toKernelMessages（messageBridge 统一实现）：标志+uuid 透传            ← F-1 修复

KernelSession 构造：collectOriginalUserGoalParts(restored)
  跳过：摘要(isCompactSummary)、克隆(isKeepSetClone)、meta、steering   ← F-3 修复
  → goal 锚 = 历史中最早的真实用户消息，而不是
    ✗ "This session is being continued…"（摘要文本，修复前会发生）
    ✗ "重跑一下 run-42"（keep-set 克隆的中途指令，修复前会发生）

RoboticsSession.init：findBySession 绑定原会话 → R5 显示 resume banner
  + 进度笔记；陈旧 worktree 回收；_storeSessionId 沿用原 UUID
```

---

## 场景 10：嵌套压缩 —— 目标穿透摘要链

会话继续增长，触发第 2、3 次压缩：

```
每次压缩输入窗口 = [上次 boundary 之后]：上次摘要 + keep-set + 新增对话
  - 上次摘要(isCompactSummary)：被 'Existing Summaries Carried Forward'
    锚保留（最近 3 个），且 PTL 裁剪时受 anchor 保护
  - keep-set 克隆(isKeepSetClone)：可作为窗口内用户锚参与下次 keep-set 选取
    （窗口内可能只有它一条用户消息——这是正确行为），但永不进入 goal 捕获
  - originalUserGoal：由 KernelSession 内存持有，与历史无关，每次压缩
    逐字重新注入 → 摘要链再长，"传话游戏"也无法改写三条原始目标
```

防卡死兜底（与压缩正交）：同一工具签名连续 3 次 → no_progress 终止；
A↔B 振荡 3 个周期 → no_progress；maxTurns / maxBudgetUsd 终止线。

---

## 速查表：哪类信息靠什么活过压缩

| 信息 | 载体 | 保真度 |
|---|---|---|
| 会话原始目标（前3条用户消息） | originalUserGoal 内存锚，每条摘要逐字注入 | 逐字 |
| 最近一条任务指令 + 工作现场 | keep-set（克隆+完整工具单元，≤40k token） | 逐字 |
| 临近压缩的 steering 纠正 | keep-set 内随单元保留；溢出则孤儿克隆 | 逐字 |
| 活跃/已完成子代理任务 ID、phase | Robotics deterministicAnchors（每条摘要尾部） | 逐字 |
| 硬件安全限值 | R4 快照（system prompt）+ compact 锚双保险 | 逐字(400字符) |
| 中段对话叙事 | flash 摘要；terse 时 recent-detail 兜底（已去重） | 有损 |
| 读过的文件内容 | 不保留——压缩后注入"重读提醒" | 故意丢弃 |
| memory/经验/通知（volatile 前缀） | 不保留——压缩提示明确丢弃，下轮重新注入 | 每轮重建 |
