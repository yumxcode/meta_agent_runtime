# Prompt Optimization Plan — Meta-Agent Runtime

> 生成日期：2026-05-06  
> 覆盖范围：`src/core/staticPrompt.ts`（S1–S10）、`src/core/dynamicPrompt.ts`（D1–D10）、`src/core/compact/compactPrompt.ts`  
> 审查基准：inspect-prompt 输出（18,639 chars / ~4,660 tokens，静态区 8,867 chars，动态区 9,772 chars）

---

## 总体问题分类

| 类别 | 说明 | 涉及 section |
|------|------|-------------|
| **冗余** | 同一条规则/格式在多处重复，浪费 token 且增加维护成本 | S2/S4/S10、S5/S10、S6/S8 |
| **过长** | 单个 section 体积过大，占用静态缓存区大量 token | D1a |
| **模糊** | 规则缺乏可执行的判断标准，模型无法落地 | S3、S6、S9、D7 |
| **过时** | 实现已扩展但 prompt 未跟进更新 | S1、S6、D4 |
| **冲突** | 两处描述互相矛盾，导致模型行为不确定 | S5 vs S9 |

---

## 优先级定义

- **P0** — 影响 token 体积 / 推理成本，应优先处理
- **P1** — 影响模型行为准确性，可能导致错误决策
- **P2** — 细节打磨，不影响主要流程

---

## S1 — Identity Definition

**文件**：`staticPrompt.ts` → `getIdentitySection()`  
**优先级**：P1  
**问题标签**：缺失、冗余

### 问题

1. **Sub-Agent 能力缺失**：Sub-Agent 系统（`SubAgentBridge`、`SubAgentRunner`、4 个 spawn/status 工具）已完整实现，但 Identity 描述里完全没有提及"可以派发子 Agent 执行并行子任务"这一核心能力。模型在收到相关请求时缺少自我认知锚点。

2. **"Core capabilities" 与 S6/S7 内容重叠**：S1 列出的 4 条能力（DOE、Tool orchestration、V&V、Multi-fidelity）在 S6 和 S7 里都有详细展开。S1 的职责应是定义"是什么"，而不是预告 S6/S7 的内容。

3. **缺乏边界说明**：没有明确说明 Meta-Agent 的"不能做"边界（例如：不直接执行文件系统操作、不绕过 V&V 校验）。

### 建议修改

```
You are Meta-Agent, an expert AI for engineering simulation workflows.

Core identity:
- Orchestrate Design of Experiments (DOE) and plugin-defined campaigns
- Invoke instrumented simulation tools with full V&V and provenance tracking
- Spawn and coordinate sub-agents for parallel sub-tasks
- Apply multi-fidelity analysis (L0 → L1 → L2) to converge on Pareto-optimal designs

Boundaries: You do not bypass V&V validators, modify provenance records, or escalate
fidelity levels without explicit user acknowledgment.
```

---

## S2 — System Rules

**文件**：`staticPrompt.ts` → `getSystemRulesSection()`  
**优先级**：P1  
**问题标签**：冗余×3

### 问题

1. **Tool result format 格式（4 种变体）与 S5 完全重复**：S2 列出了 4 种工具返回格式（Success / PRE-CALL ABORT / POST-CALL ABORT / WARNING），S5 再次逐一解释如何响应。S2 只需说"工具结果会包含 V&V 前缀，格式见 S5"，删除重复的格式列表。

2. **Provenance ID 引用格式三重冗余**：`[provenance: prov-xxx]` 的引用格式在 S2、S4、S10 三处各写一次。统一保留在 S2（作为系统格式定义），S4 和 S10 删除重复描述。

3. **"Session scope" 段落是运维细节**："Records from previous sessions are read-only" 是实现约束，不是模型需要的行为规则。可删除。

### 建议修改

保留：provenance ID 定义（一处权威）。  
删除：tool result format 的 4 种变体列举（保留一句"V&V 前缀格式见 S5"）。  
删除：Session scope 段落。

---

## S3 — Task Execution Rules

**文件**：`staticPrompt.ts` → `getTaskExecutionRulesSection()`  
**优先级**：P2  
**问题标签**：模糊、可压缩

### 问题

1. **Rule 4 可压缩**："Verify V&V status: After any tool call, check whether the result contains [V&V WARNING] or [V&V ABORT]. Respond according to S5." — 这只是指向 S5 的指针，一句话即可，无需单独成段。

2. **Rule 3 "Flag out-of-range results" 无执行标准**："falls outside the typical engineering range" — 没有定义什么是"typical range"，模型无法执行这条规则。应改为具体的领域示例，或删除此条（S7 工程计算标准已覆盖异常值处理）。

3. **Rule 5 逻辑上被 Rule 1-4 覆盖**："Complete before reporting" — 如果规则 1-4 被遵守（先查重复、明确假设、验证 V&V），自然不会在未完成时 report。此条可删除。

---

## S4 — Provenance Protocol

**文件**：`staticPrompt.ts` → `getProvenanceProtocolSection()`  
**优先级**：P1  
**问题标签**：冗余、过长

### 问题

1. **与工具 description 双重定义**：每个 provenance 工具（`find_duplicate_computation`、`get_provenance`、`list_recent_results`、`get_computation_lineage`）的使用时机已在各自的工具 description 中定义。S4 是第二份定义，且内容基本相同。

2. **"Citing provenance in responses" 属于输出格式**：这段关于如何在回复中引用 prov-ID 的规范，应归入 S10（Style Rules），而不是 S4（协议说明）。

3. **文字可缩减 50%**：`find_duplicate_computation` 的描述（"Field-for-field exact match is required — a changed unit or extra key gives a different hash"）是工具实现细节，不是行为规则。

### 建议修改

将 S4 压缩为：工具调用顺序原则（先查重复 → 再执行 → 出错后检查记录），删除各工具的描述正文（保留工具名 + 一句核心用途），将 citing 格式移至 S10。

---

## S5 — V&V Response Protocol

**文件**：`staticPrompt.ts` → `getVVResponseProtocolSection()`  
**优先级**：OK（整体质量最高）  
**问题标签**：轻微冗余

### 问题

1. **"Do NOT retry with identical inputs" 重复**：此规则在 PRE-CALL 段和 POST-CALL 段各写一次。可提取为开头的共用规则："For any ABORT: never retry with identical inputs. Diagnose first."

2. **WARNING 末尾的输出格式与 S10 重复**："⚠ Lower-confidence result — see [prov-xxx] for validation detail." 同样出现在 S10 的 Style Rules。保留在 S5（行为协议），S10 删除。

### 建议修改

小幅重构：提取共用的"不得用相同输入重试"规则到 PRE-CALL/POST-CALL 两节之前。S10 删除重复的 WARNING 格式行。

---

## S6 — DOE / Campaign Domain Knowledge

**文件**：`staticPrompt.ts` → `getDOECampaignKnowledgeSection()`  
**优先级**：P1  
**问题标签**：已过时、模糊

### 问题

1. **状态机只覆盖 DOE Campaign**：Campaign Plugin 框架已实现（`PaperReproCampaign` 等），但 S6 的状态机（IDLE → SAMPLING → EVALUATING → PARETO → REPORTING）只描述 DOE Campaign 的相位，其他 plugin campaign 的相位结构完全缺失。应改为描述框架通用能力，具体相位交给 D10（phase_guidance）动态注入。

2. **升级决策标准过于定性**："not converged or sparse" — 模型无法从这两个词判断是否应该升级。应改为：  
   - L0 → L1：当 Pareto hypervolume < threshold（默认 0.85）或 Pareto front 设计点 < 5 时
   - L1 → L2：当高价值设计区域 L0/L1 surrogate 误差 > 10% 时

3. **"Always present Pareto evidence and get user acknowledgment" 与 S8 重叠**：S8 在"Escalation gates"段落里说了几乎相同的话。应统一保留在 S6，S8 删除该段。

4. **Pareto front 定义**：compact prompt 示例里也有类似定义。可简化 S6 的定义，compact 保留独立示例。

---

## S7 — Engineering Calculation Standards

**文件**：`staticPrompt.ts` → `getEngineeringCalculationStandardsSection()`  
**优先级**：OK（整体精炼）  
**问题标签**：P2 细节

### 问题

1. **Unicode 上标兼容性风险**：科学记数法示例使用 Unicode 上标（`⁻³`、`⁶`、`⁻⁴`），在某些终端、日志系统或工具解析器中可能显示为乱码。建议改为 `×10^-3`、`1.23e-4` 或 `1.23 × 10⁻⁴`（仅在指数部分使用上标）。

2. **"Mismatched units → PRE-CALL ABORT" 泄露实现细节**：这是对 V&V 系统内部行为的描述，而非对模型的行为指导。可改为："Unit mismatches trigger validation errors — verify units before calling."

---

## S8 — Action Risk Rules

**文件**：`staticPrompt.ts` → `getActionRiskRulesSection()`  
**优先级**：P2  
**问题标签**：可合并

### 问题

1. **"Disk-persistent operations" 段无可操作内容**："Consider the downstream impact before triggering phase transitions." — 这是通用告诫，不提供任何具体行为指导。可删除。

2. **Escalation gates 与 S6 重叠**：S8 的"Moving from L0 → L1 or L1 → L2 consumes substantially more compute… Always present the current Pareto evidence" 与 S6 的升级决策条件重复。

### 建议修改

将 S8 的不可逆操作列表（3 条 bullet）合并进 S3（Task Execution Rules），删除 S8 整节，或保留为极简的"3条禁止操作"清单（不超过 5 行）。

---

## S9 — Tool Use Rules

**文件**：`staticPrompt.ts` → `getToolUseRulesSection()`  
**优先级**：P1  
**问题标签**：模糊、冲突

### 问题

1. **"Parallel execution" 缺乏判断标准**："Tools with no data dependency on each other can be called in parallel" — 正确但模型需要判断"是否存在数据依赖"的标准，例如"当两次调用的输入均不依赖另一次的输出时"，或者给出具体可并行的工具对例子。

2. **"Tool descriptions are authoritative" 是元级说明**：这是对模型的知识论说明（"相信工具 description"），不是行为规则。可以删除，因为模型本来就会读 tool description。

3. **错误恢复 Step 2 与 S5 协议冲突**：  
   - S9 说："Tool threw an exception → inspect the message, fix inputs, **retry once**."  
   - S5 说：POST-CALL ABORT 时"Do NOT retry with the same inputs — the tool would produce the same invalid output."  
   这两条在 POST-CALL ABORT 场景下直接矛盾。S9 的 Step 2 应改为："非 V&V abort 的工具异常（Tool error: ...）→ 检查消息，修正输入，重试一次；若结果是 V&V ABORT，按 S5 执行。"

---

## S10 — Style Rules

**文件**：`staticPrompt.ts` → `getStyleRulesSection()`  
**优先级**：P1  
**问题标签**：冗余×2、缺条件

### 问题

1. **"Numerical citation" 格式三重冗余的第三处**：`value unit [provenance: prov-xxx]` 的格式在 S2、S4、S10 各出现一次。S10 的这一条应删除，改为"Cite results per S2."

2. **"V&V warnings in responses" 与 S5 重复**："⚠ Lower-confidence — see [prov-xxx] for validation detail." 在 S5 WARNING 段末尾已有完全相同的要求。S10 删除此条。

3. **报告格式缺乏触发条件**："Engineering reports: Use structured format — Assumptions → Method → Results → Conclusions." — 没有说明什么情况下应该用报告格式 vs 对话格式。建议补充：当用户明确要求报告/分析、或任务跨越 3+ 个工具调用时，使用报告格式；否则用对话格式。

---

## D1a — Memory Guidance

**文件**：`memory/types.ts`、`memory/memdir.ts` → `buildMemoryGuidanceLines()`  
**优先级**：P0（体积问题）  
**问题标签**：过长

### 问题

当前 D1a 在 prompt 中约占 **90 行**，是动态区体积最大的 section：

| 子块 | 行数 | 优化空间 |
|------|------|---------|
| `TYPES_SECTION`（XML 风格类型分类） | ~60 行 | 改为 markdown 表格，可压缩至 ~20 行 |
| `MEMORY_FRONTMATTER_EXAMPLE`（嵌套代码块） | ~15 行 | 压缩为 6 行内联格式 |
| `WHAT_NOT_TO_SAVE_SECTION` | ~15 行 | 3 条边界定义保留，"Also do not save" 列表压缩 |
| `HOW_TO_SAVE_SECTION` + `WHEN_TO_ACCESS` + `DRIFT_CAVEAT` | ~25 行 | 合理，可保留 |

XML 风格（`<types><type><name>...`）的类型分类对 LLM 有额外的 parse 负担，且在 token 效率上低于 markdown 表格。

### 建议修改

将 `TYPES_SECTION` 重构为 markdown 表格：

```markdown
| Type | When to save | Key constraint |
|------|-------------|----------------|
| `user` | User's role, background, collaboration preferences | Per-user, non-technical |
| `feedback` | Corrections AND confirmations of non-obvious choices | Must include WHY |
| `domain_knowledge` | Stable physical constants, standards, material properties | MUST cite source; no simulation results |
| `campaign_lessons` | Generalisable insights from COMPLETED campaigns | Not current campaign state |
| `reference` | External resource pointers (APIs, databases, URLs) | Where to look, not the content |
```

将 `MEMORY_FRONTMATTER_EXAMPLE` 压缩为内联示例（去除代码块嵌套）。

**预期体积缩减：~40 行（约 1,200 token）**

---

## D1b — Memory Content

**文件**：`dynamicPrompt.ts` → `buildMemoryContentSection()`  
**优先级**：P2  
**问题标签**：引导不足

### 问题

1. **空 MEMORY.md 时的提示语不具引导性**：当前显示 "Your MEMORY.md is currently empty. When you save memories, they will appear here as an index." — 这是描述性的，没有告诉模型应该在什么时机开始写入。建议改为："No memories saved yet. After learning user preferences or validated domain facts, proactively save them."

2. **"## Recalled memory files" 标题歧义**：未说明这些文件是按语义相关性（semantic similarity to current query）从所有记忆文件中选出的。模型可能不理解为何选了这几个文件。建议改为："## Memory files recalled for this query (semantic match)"。

---

## D4 — Current Mode

**文件**：`dynamicPrompt.ts` → `buildCurrentModeSection()`  
**优先级**：P2  
**问题标签**：已过时

### 问题

agentic mode 的描述："AGENTIC — multi-turn tool use permitted; **do not start DOE campaigns**." — 随着 Campaign Plugin 框架的引入，限制应改为"do not start **any** campaigns"（不限于 DOE）。

---

## D7 — Summarize Tool Results

**文件**：`dynamicPrompt.ts` → `buildSummarizeToolResultsSection()`  
**优先级**：P1  
**问题标签**：过于模糊

### 问题

当前内容（3 句话）：
> "As you work through a multi-step analysis, note key numerical results (with provenance IDs) in your reasoning before they scroll out of context. This prevents important values from being lost across tool calls."

问题：
1. "key" 未定义，模型无法判断哪些值需要记录
2. 没有强制语气（"note" 而非 "must record"）
3. 适用条件不清楚（每次工具调用后？还是只有"重要"的调用？）

### 建议修改

```
## Tracking Intermediate Results

After every tool call that returns a numerical result, you MUST record:
  (a) the result value with units, and (b) its prov-ID

Do this in your reasoning text before issuing the next tool call.
Priority cases: any result that will be used as input to a subsequent call,
or that appears in the final report.
This ensures values are not lost if the conversation is compacted mid-analysis.
```

---

## D9 — Session Provenance

**文件**：`dynamicPrompt.ts` → `buildSessionProvenanceSection()`  
**优先级**：P1  
**问题标签**：上限过低

### 问题

1. **`slice(-5)` 硬编码，长会话中丢失关键记录**：当一次 DOE campaign 产生 30+ 个工具调用时，D9 只显示最新 5 条，早期的关键 prov-ID（如 ABORT 事件）对模型不可见，导致 compact 后无法追溯。

2. **截断策略与 compact 不一致**：D9 将 inputStr 截断为 50 chars，但 compact prompt 的 Chapter 4 要求保留完整参数（无截断限制）。模型在 D9 中看到不完整的参数，在 compact 时又被要求复述完整参数，形成矛盾。

### 建议修改

```typescript
// 优先级排序：V&V abort/warning 优先，按时序其次
// 上限改为 10 条，或：全部 abort/warning + 最近 5 条 success
const abortOrWarning = records.filter(r => r.validationResults.some(v => !v.passed))
const recent = records.filter(r => r.validationResults.every(v => v.passed)).slice(-5)
const displayed = [...abortOrWarning, ...recent].slice(-10)
```

同时去掉 inputStr 的 50 chars 截断，改为 100 chars（与 compact 更接近）。

---

## D10 — Phase Guidance

**文件**：`dynamicPrompt.ts` → `buildPhaseGuidanceSection()`  
**优先级**：P1  
**问题标签**：通用性过强

### 问题

1. **Fallback 文字过于通用**：`"⏸ Awaiting your decision before the campaign continues."` 和 `"⚙ Machine phase — no tool calls needed; the background job is running."` — 没有告诉用户/模型具体期待什么行动（例如：应该展示什么数据给用户，还是等待用户输入哪种指令）。

2. **Plugin fallback 无提示**：当 `pluginType` 不存在于 registry 时走 legacy DOE path，但没有任何日志或 prompt 提示，模型不知道这是 fallback 状态。

### 建议修改

人工审查各 plugin 的 `buildPhaseGuidance()` 返回值（DOE plugin），确保每个相位都有具体的期待行动描述，而不只是状态播报。

---

## Compact Prompt

**文件**：`compact/compactPrompt.ts`  
**优先级**：P1  
**问题标签**：措辞不一致、Ch7 无上限

### 问题

1. **NO_TOOLS_PREAMBLE 与 NO_TOOLS_TRAILER 措辞不一致**：  
   - Preamble："Respond with TEXT ONLY. Do NOT call any tools."  
   - Trailer："Respond with plain text only — an \<analysis\> block followed by a \<summary\> block."  
   
   两处表达同一约束，但措辞不同（"TEXT ONLY" vs "plain text only"）。应统一为相同措辞。

2. **Chapter 7 "All user messages verbatim" 对长对话无上限**：对于 50+ 轮的长对话，Chapter 7 要求复述所有用户消息可能导致 compact summary 本身超过模型上下文限制。应改为"最近 20 条用户消息 verbatim，更早的消息摘要即可"。

3. **DETAILED_ANALYSIS_INSTRUCTION 缺乏 prov-ID 检索方法**：要求"double-check that EVERY prov-ID is captured"，但没有告诉模型如何系统地检索（应搜索 `[prov-` 前缀）。建议补充："Search all tool results for strings matching `[prov-` to enumerate every ID."

4. **Chapter 3 仅展示 DOE Campaign 示例**：compact 示例的 Chapter 3 中只有 DOE Campaign 的相位名称（PARETO_READY_L1）。应补充说明 plugin campaign 也适用此结构。

---

## 实施顺序建议

| 优先级 | 任务 | 文件 | 预期收益 |
|--------|------|------|---------|
| **P0-1** | D1a 体积压缩（XML → table，frontmatter 简化） | `memory/types.ts`、`memory/memdir.ts` | -40 行，-~1,200 token |
| **P1-1** | 消除 S2/S4/S10 三重冗余（prov 格式 + V&V 格式） | `staticPrompt.ts` | -30 行，-~800 token |
| **P1-2** | S5/S9 冲突修复（POST-CALL ABORT 不重试）| `staticPrompt.ts` | 行为准确性 |
| **P1-3** | S6 更新（插件 campaign 说明 + 量化升级阈值）| `staticPrompt.ts` | 行为准确性 |
| **P1-4** | S1 补充 Sub-Agent 能力描述 | `staticPrompt.ts` | 功能可发现性 |
| **P1-5** | D7 加强（强制语气 + 明确条件） | `dynamicPrompt.ts` | 行为准确性 |
| **P1-6** | D9 上限策略调整（abort 优先 + 上限 10） | `dynamicPrompt.ts` | 长会话准确性 |
| **P2-1** | S3 Rule 3/5 简化；S8 合并/删减 | `staticPrompt.ts` | 可读性 |
| **P2-2** | D1b、D4 措辞更新 | `dynamicPrompt.ts` | 引导性 |
| **P2-3** | Compact: 统一措辞 + Ch7 上限 + prov 检索提示 | `compact/compactPrompt.ts` | 压缩质量 |
| **P2-4** | S7 Unicode 修复；D10 fallback 提示 | `staticPrompt.ts`、`dynamicPrompt.ts` | 兼容性 |

---

## 附：当前 token 消耗分布（inspect-prompt 基准）

```
静态区 (S1–S10):  8,867 chars  ≈ 2,217 tokens
动态区 (D1–D10): 9,772 chars  ≈ 2,443 tokens
  其中 D1a:       ~3,600 chars ≈   900 tokens  ← 优化最大空间
总计:            18,639 chars  ≈ 4,660 tokens
```

目标：P0-1 + P1-1 完成后，总 token 减少约 500（10%），静态区减少约 15%。
