# 长周期任务目标一致性审查报告（Robotics + Agentic 模式）

日期：2026-06-12
审查目标：长周期任务中 LLM 交互时，(A) 整体任务目标不偏移；(B) 不额外引入噪音；(C) 准确理解并遵守用户指令。
审查范围：kernel 主循环与消息流、compact 管道、RoboticsSession 全链路、AgenticSession / MetaAgentSession 全链路、sub-agent 桥接。

---

## 1. 总体结论

整体架构对"目标不偏移"做了多层防御，设计质量高：目标锚定有 5 层冗余（originalUserGoal 确定性锚 → TaskContract D0 → compact 9 段摘要 → continuity anchors → keep-set 逐字保留），噪音控制有明确的 stable/volatile 分层与逐轮剥离机制。**未发现 P0 级缺陷**。

但存在 **3 个 P1 问题**，全部集中在"跨会话 resume"与"压缩后内容重复"两个场景——恰好是长周期任务最依赖的场景：

| 级别 | 编号 | 问题 | 维度 |
|---|---|---|---|
| P1 | F-1 | resume 路径丢失消息元标志，compact 摘要可能被误认作用户原始目标 | A 目标偏移 |
| P1 | F-2 | keep-set 与 continuity anchors 双重保留同一批近期消息，压缩后内容重复 | B 噪音 |
| P1 | F-3 | keep-set 克隆的"最后用户消息"无标记，嵌套压缩/恢复后被当作会话首条目标 | A 目标偏移 |
| P2 | F-4 ~ F-10 | 见 §4 | A/B/C |

---

## 2. 目标传递链路梳理（现状）

### 2.1 共用 kernel 层

```
用户消息 → KernelSession.submitMessage
  ├─ originalUserGoal：捕获前 3 条真实用户消息（过滤 meta/steering/compact 产物，
  │   剥离 volatile 前缀；2026-06-12 起为多消息捕获）
  ├─ steering 队列：仅在 turn 进行中接收，loop 边界注入，idle 时丢弃过期项 ✅
  └─ KernelLoop 每轮：
       applyToolResultBudget → autoCompactIfNeeded → 流式调用 → 工具执行
       防护：no-progress 重复守卫（3 次）、A↔B 振荡守卫（ABABAB）、
             maxTurns、maxBudgetUsd、流错误注入式恢复（≤2 次）
```

### 2.2 compact 管道（目标保真的核心）

```
compactConversation
  ├─ 摘要侧调用：9 段结构化提示（§1 Primary Request、§6 All User Messages 逐字）
  │   + VOLATILE_CONTEXT_INSTRUCTION（丢弃 <context> 块）+ 模式自定义指令
  ├─ enrichCompactSummaryWithContinuity：确定性 anchors（原始目标、窗口内首/末
  │   用户请求、terse 时附近期逐字消息、工具活动统计、模式 extraAnchors）
  ├─ 空响应/PTL 双兜底：buildFallbackCompactSummary（本地确定性摘要）
  └─ buildPostCompactMessages：boundary → summary → keep-set → 文件提醒
       keep-set = 最后非 steering 用户消息克隆 + 孤儿 steering 克隆
                  + ≤40k token 的完整 assistant⇄tool_result 单元
```

### 2.3 Robotics 模式

stable system prompt（R1 域身份 / R4 硬件快照 / W1 / team）与 volatile 用户前缀（D1b 记忆 / R2 经验 / R3 子代理状态 / R5 进度 / D11 通知）分离；compact 时经 customInstructions + deterministicAnchors 双通道注入活任务 ID、phase、硬件安全限值、经验工作集。R4/R5 快照带双语 staleness 免责声明 ✅。

### 2.4 Agentic 模式

MetaAgentSession 同构：D0 TaskContract（system prompt 内、天然抗压缩、含 Non-Goals/硬约束/验收标准 + "不得违反合同"指令）+ agenticCompactAnchors（sub-agent 活任务/终态任务/合同身份，compact_start 事件时刷新快照）。

---

## 3. P1 发现详述

### F-1（P1 / 目标偏移）resume 路径丢失全部消息元标志

`AgenticSession.toKernelMessages()`（`src/modes/AgenticSession.ts:23-31`）将 `ConversationMessage` 转为 `KernelMessage` 时只映射 `role` 和 `content`，而 `ConversationMessage`（`src/core/types.ts:326-336`）本身就**没有** `isCompactSummary / isCompactBoundary / isMeta / isSteering` 字段。后果链：

1. resume 进来的 compact 摘要消息失去 `isCompactSummary` 标志 → `KernelSession` 构造函数里 `collectOriginalUserGoalParts()` 把摘要文本（"This session is being continued…"）当作用户原始目标捕获——**目标锚被摘要污染，且此后所有嵌套压缩都会确定性地传播这个错误锚**。
2. boundary 失去 `isCompactBoundary` → `getMessagesAfterCompactBoundary` 找不到边界，已压缩的旧消息可能重新计入。
3. 下一次压缩时 `selectAnchorMessageIds` / `isRealUserMessage` 的过滤全部失效，摘要消息会被当作普通用户消息再次摘要（telephone game 防护被绕过）。

建议：在 `ConversationMessage` 上增加可选元标志并在 `toKernelMessages` 透传；过渡期可在 `extractUserGoalText` 增加内容启发式拦截（识别 compact 摘要的固定前缀句）。

### F-2（P1 / 噪音）压缩后同一批近期消息出现两份

当摘要 < 2000 字符（terse）时，`buildCompactContinuityAnchors` 在摘要**内部**附加最近 10 条用户、8 条 assistant、10 条 tool_result 的逐字内容（`CompactPrompt.ts:351-366`）；同时 `buildPostCompactMessages` 在摘要**外部**以 keep-set 形式保留最后用户消息 + ≤40k token 的近期 tool 单元。两者来源重叠但互不知情 → post-compact 上下文中同一段近期对话/工具输出出现两份。

危害：(a) token 浪费直接侵蚀压缩收益；(b) 旧 tool 输出以两种"权威形态"并存，模型可能把摘要内的副本误读为独立的新事件。

建议：`compactConversation` 已持有 `options.messagesToKeep`，将其 uuid 集合传入 `enrichCompactSummaryWithContinuity`，从 recent-detail 候选中排除。

### F-3（P1 / 目标偏移）keep-set 用户消息克隆无任何标记

`cloneLastRealUserTextMessage`（`KernelLoop.ts:123-147`）生成的克隆是一条无标志的普通 user 消息。两个后果：

1. **嵌套压缩**：压缩 #2 时 `selectAnchorMessageIds` 把这条克隆当作"first user"锚保护——它实际是压缩 #1 时刻的*最近*请求，不是会话目标（continuity anchors 的标签已澄清 window-scoped，部分缓解）。
2. **跨会话恢复**（叠加 F-1）：持久化历史里这条克隆排在最前，`collectOriginalUserGoalParts` 把它当作会话第 1 条目标消息——用户长周期任务中途的某条操作指令（如"重跑一下 run-42"）会被钉成"原始会话目标"并写进之后每一份摘要。

建议：为克隆消息加 `isKeepSetClone`（或复用 `isMeta` 语义的新标志），goal 捕获与 anchor 选择时跳过；并将 `originalUserGoalParts` 持久化到 SessionStore，resume 时优先读取持久化值而非从历史重建。

---

## 4. P2 发现

**F-4（B 噪音 / C 遵守）压缩摘要消息的"不要再询问用户"指令过强。** `buildCompactSummaryMessage` 固定附加 "Continue … without asking the user any further questions"（`CompactPrompt.ts:152`）。若压缩恰好落在需要用户确认的节点（如 sub-agent 结果 `pending_human_approval=true`，D11 文案要求 "MUST present the result to the user"），两条指令直接冲突，模型可能跳过本应有的人工确认。建议改为"不要为摘要本身向用户提问/不要复述摘要"，保留任务性提问的合法性。

**F-5（B 噪音）D11 通知的破坏性 drain 与 volatile 丢弃指令的组合风险。** `drainNotifications()` 在 section 渲染时一次性取走通知，通知只存在于该轮 user 消息的 `<context>` 前缀中；而 compact 提示明确要求丢弃 `<context>` 块且不复制 notifications。若该轮之后模型未及时调用 `get_sub_agent_status`、随后触发压缩，通知内容仅依赖摘要模型自觉保留。robotics 有 R3 表格兜底，agentic 依赖 compact_start 快照（已缓解但属间接）。建议 drain 改为"读取+确认"两段式：模型对某 task 调用过 `get_sub_agent_status` 后才真正清除。

**F-6（A/C）keep-set 克隆只保留 text block。** 用户消息中的图片/非文本块在压缩时静默丢失（`cloneLastRealUserTextMessage` 仅 filter text）。多模态任务的目标信息（如"按这张图改"）会断链。至少应在克隆中插入占位文本（"[原消息含 N 张图片，已在压缩中移除]"）。

**F-7（C 遵守）系统注入文案语言硬编码中文。** `formatSteeringMessage`（"[用户实时补充指导]…"）与 `buildStreamErrorRecoveryText`（"[系统] 上一步模型调用失败…"）为中文硬编码，而 D-section 有 `language` 配置。非中文会话中注入中文指令既是噪音也降低遵守率。建议随 `config.language` 渲染。

**F-8（B 噪音）历史 volatile 前缀剥离破坏对话前缀缓存。** `stripVolatileContextFromMessages` 每轮改写上一轮 user 消息字节（正确地防止了噪音累积 ✅），代价是 DeepSeek KV 前缀缓存从该消息起失效——为 system prompt 稳定性做的全部字节级努力在 user 历史上被部分抵消。属已知权衡，建议在 perf 文档中显式记录，并评估"volatile 前缀作为独立 isMeta 消息注入、压缩时整条丢弃"的替代方案。

**F-9（A）经验/记忆注入的带偏风险已有缓解但缺审计出口。** R2 经验工作集与 D1b 记忆召回由 flash 模型相关性判断驱动，错误注入会系统性带偏后续推理。现有缓解：R1 文案要求"把命中当作待验证假设"、`appliesBecause` 字段、`_lastExperiencePreloadTrace`。建议把 preload trace 暴露为调试事件/日志（当前仅存内存字段），长会话出现漂移时可回溯是哪次注入引入的。

**F-10（A）`maxStreamErrorRecoveries` 注入消息是 isMeta 但参与目标捕获前的消息计数。** 影响极小（extractUserGoalText 已过滤 isMeta），仅提示：任何新增系统注入消息务必设置 `isMeta`，这是噪音过滤的唯一依据，建议加 lint 级约定或工厂函数强制。

---

## 5. 已验证为健壮的设计（无需改动）

逐项核对过、值得保持的点：steering 的全生命周期（idle 丢弃→边界注入→keep-set 孤儿克隆→压缩分类保留）；volatile 前缀的统一 sentinel 解析（首次匹配、防用户粘贴转义）；originalUserGoal 三路径（rich/terse/fallback）确定性注入与 4000/3600 裁剪预算匹配；compact 失败的熔断（3 次）+ 本地 fallback 摘要 + PTL 锚保护裁剪；工具结果三级限幅（per-block 4k / 总预算 80k / per-tool budget）；R4/R5 快照 staleness 免责声明；TaskContract 放 stable system prompt 的抗压缩定位；sub-agent 空工具集 fail-loud；压缩后文件缓存清空 + "re-read before relying" 提醒。

---

## 6. 建议落地顺序

1. **F-1 + F-3 一起修**（同一根因：元标志在持久化/克隆边界丢失）——直接决定 resume 后长周期任务的目标正确性。
2. **F-2**——一处参数透传 + 一个 uuid 过滤，收益立竿见影（压缩后上下文净化）。
3. **F-4 / F-7**——纯文案改动，低风险。
4. **F-5 / F-6 / F-9**——需要小的机制设计，可排入下个迭代。

修复 F-1/F-3 时建议补充测试：带 compact 摘要的历史 resume 后 `originalUserGoal` 不被污染；嵌套压缩两次后 goal anchor 仍为首三条真实用户消息。
