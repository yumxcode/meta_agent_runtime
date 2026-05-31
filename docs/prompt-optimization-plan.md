# Prompt 演进记录

> **状态：📦 归档（原优化计划已落地）**  
> 本文档记录 prompt 系统的演进历程，取代原始的"优化计划"规划文档。  
> 当前 prompt 架构的完整参考见：[meta-agent-architecture.md](architecture/meta-agent-architecture.md) §2-3

---

## 演进概要

### Phase 1：静态区优化（S1-S10 重构）

**背景**：初始静态区 ~8,867 chars，4 个主要问题：冗余、过长、模糊、过时。

| 项目 | 状态 | 说明 |
|------|------|------|
| S2/S4/S10 三重 prov-ID 格式冗余 | ✓ 解决 | 统一保留在 S2，S4/S10 引用删除 |
| S5/S9 冲突（POST-CALL ABORT 重试） | ✓ 解决 | S9 改为"V&V ABORT 时不重试，按 S5 执行" |
| S6 Campaign 状态机只覆盖 DOE | ✓ 解决 | 改为描述插件框架通用能力，具体相位由 D10 动态注入 |
| D1a 过长（~90行 XML 格式） | ✓ 解决 | **D1a 整节移除**（见下方） |
| S1 缺少 Sub-Agent 能力描述 | ✓ 解决 | S1 补充"Spawn and coordinate sub-agents" |

### Phase 2：动态区结构调整（D-sections 重组）

这是最重要的一轮演进，影响整个 prompt 架构。

#### S4 → D4c 迁移

`tool_invocation_protocol` 从静态区（S4）迁移到动态区（D4c），因为：
- 不同 mode 有不同工具调用规则（robotics 不需要 V&V 协议）
- 静态区缓存意味着所有 mode 共享同一份工具规则，不合理

D4c 现按 mode 裁剪内容：

| mode | D4c 内容 |
|------|---------|
| `direct` | 通用规则 |
| `robotics` | 通用规则（无 V&V） |
| `agentic` | 通用规则 + 溯源工具指南 |
| `campaign` | 通用规则 + 溯源工具指南 + V&V 规则 |

#### D1a 整节移除

**原设计**：D1a（memory_guidance）在所有 mode 下注入，告知模型如何写入 Memory。  
**问题**：memory 写入不是主 agent 的职责——写入判断由 post-session 子 agent 承担；主 agent 只读（D1b）。  
**决策**：D1a 从所有 mode 的 dynamic prompt 中移除。memory 写入协议在子 agent 的 system prompt 中定义。

#### D4a 从 robotics 移除

`engineering_standards`（D4a）仅对 `agentic` 和 `campaign` mode 注入。  
robotics 当前阶段不需要工程计算规范（V&V / 溯源 / 精度标准），注入只增加噪音。

#### D2 tools 字段移除

`env_info`（D2）原来包含已注册工具列表。  
工具列表在每次 API 调用时随 `tools` 参数自动传递，在 prompt 中重复展示是冗余的。  
移除后 D2 只保留：当前日期、知识截止日期。

### Phase 3：Robotics mode 专属优化

#### R1 平台名移除

R1 原本包含 `## Robotics Algorithm Development Mode — <robot_name>` 的平台名标题。  
R4（hardware_profile）已包含硬件规格，R1 的平台名是重复。移除后 R1 聚焦于协调规则。

#### R5 条件注入

R5（progress_notes）仅在以下情况注入：
- resumed session（`isResumed === true`），或
- 已有进度笔记（`progressNotes.length > 0`）

新建 session 且无进度时，R5 返回 `null`，不占用 prompt 空间。价值随使用积累自然呈现。

#### W1 去重

W1 原设计注入当前阶段的完整内容（phase content）。  
但 D1c 已加载完整 AGENT.md（包含所有阶段定义），重复注入浪费 token。  
W1 现只输出运行时执行状态：当前阶段位置、gate 完成情况、advance 提示。  
See: [workflow-system-design.md](./workflow-system-design.md) §W1 for details.

### Phase 4：modeExtensions 扩展点

**问题**：RoboticsSession 需要将 R1-R5 节注入 `buildDynamicSections()`，但 `core/` 不能依赖 `robotics/`。

**解决方案**：在 `DynamicSectionOptions` 增加 `modeExtensions?: SystemPromptSection[]` 字段，在 D4c 之后、D5 之前插入。

```typescript
// RoboticsSession 用法
buildDynamicSections({
  mode: 'robotics',
  modeExtensions: this._getRoboticsExtensions(),  // [R1, R2, R3, R4, R5, (W1)]
  ...
})
```

这保持了依赖单向性：`core/` 声明扩展点，`robotics/` 使用扩展点，`core/` 不依赖 `robotics/`。

---

## 当前 token 消耗（估算）

> 注：原优化计划基准为 18,639 chars (~4,660 tokens)，以下为优化后的结构变化。

| 变更 | 影响 |
|------|------|
| D1a 移除 | -~900 tokens（每轮） |
| D2 tools 字段移除 | -变量（工具数量 × ~15 tokens） |
| D4a robotics 移除 | -~400 tokens（robotics mode） |
| S4 → D4c（mode 裁剪） | robotics/direct mode 减少 V&V 规则 |
| R5 条件注入 | 新建 session 节省 ~100 tokens |
| W1 去重 | -~200 tokens（phase content） |

---

## 原计划未实现的项目

以下优化计划中的项目未实现（已评估为不必要或优先级低）：

| 项目 | 原因 |
|------|------|
| D9 上限策略（abort 优先 + 上限 10） | D9 是 campaign mode 专属，robotics 无此问题 |
| compact Ch7 用户消息上限 | 实践中 compact 触发频率很低（DeepSeek 1M 窗口） |
| D10 fallback 提示改进 | Campaign plugin 框架已在 D10 直接提供 phase guidance |
| S7 Unicode 上标修复 | 现有终端兼容性问题未实际报告 |

---

*文档状态：归档。不再更新。当前 prompt 架构见 `docs/architecture/meta-agent-architecture.md`。*
