/**
 * Meta-Agent Compact Prompt
 *
 * Used by two paths:
 *   A. MetaAgentSession auto-compact (replaces conversation history when context fills)
 *   B. KernelBridge compact instructions (injected into CC's compact via system prompt)
 *
 * Differs from CC's compact (src/services/compact/prompt.ts) in three ways:
 *   1. Chapter 3 "Campaign State" replaces "Files and Code Sections"
 *   2. Chapter 4 "Computations and Results" is new — preserves provenance IDs verbatim
 *   3. Chapter 5 "V&V Events" replaces/extends "Errors and fixes"
 *
 * The <analysis> scratchpad pattern and NO_TOOLS preamble are identical to CC.
 */

import type { RuntimeContext } from '../../runtime/RuntimeContext.js'
import { MetaAgentContextStore } from '../index.js'
import type { CompactStateSnapshot } from './stateSnapshot.js'
import type { TaskContract } from '../../core/contract/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Shared blocks (identical purpose to CC's equivalents)
// ─────────────────────────────────────────────────────────────────────────────

export const NO_TOOLS_PREAMBLE = `严禁调用任何工具，仅输出纯文本。

- 不得调用 find_duplicate_computation、get_provenance、list_recent_results 或任何其他工具。
- 对话记录已包含你所需的全部上下文。
- 工具调用将被拒绝，并消耗你唯一的输出机会——任务将因此失败。
- 整个回复必须是纯文本：一个 <analysis> 块，紧接一个 <summary> 块。

`

const NO_TOOLS_TRAILER =
  '\n\n提醒：严禁调用任何工具。仅输出纯文本——' +
  '一个 <analysis> 块，紧接一个 <summary> 块。' +
  '工具调用将被拒绝，任务将因此失败。'

const DETAILED_ANALYSIS_INSTRUCTION = `在输出最终摘要前，将你的分析过程包裹在 <analysis> 标签中。分析时请：

1. 按时间顺序逐条分析每条消息，识别：
   - 用户明确的工程需求和意图
   - 每次工具调用、其 provenance ID，以及是否通过 V&V
   - 升级决策及其支撑数据
   - V&V 中止/警告事件及处理方式
2. 核查对话中出现的 **每一个** provenance ID（prov-xxx）是否都已记录在第 4 章。
3. 确认"可选下一步"中的引用确实来自最近消息的原文。`

// ─────────────────────────────────────────────────────────────────────────────
// Meta-Agent Compact Prompt (10 chapters)
// ─────────────────────────────────────────────────────────────────────────────

const METAAGENT_COMPACT_BODY = `你的任务是为本次工程会话创建详尽摘要，确保后续工作能在不丢失任何计算上下文的情况下继续进行。

${DETAILED_ANALYSIS_INSTRUCTION}

摘要**必须**包含以下章节：

0. Task Contract（目标锚点）
   [若本次会话无活跃 TaskContract，完全跳过本章。]
   **严禁修改或缩短** Task Contract 中的任何内容，逐字复制以下字段：
   - Primary Goal（主要目标）
   - Non-Goals（非目标，明确超出范围的事项）
   - Hard Constraints（硬性约束）
   - Acceptance Criteria（验收标准，含每项的 pass/fail/unknown 状态）
   - User-Approved Decisions（用户批准决策日志）
   - Current Plan（当前计划步骤）
   - Open Questions（待解决的开放性问题）

1. 主要需求与意图
   详细记录用户全部明确的工程需求和意图。

2. 关键技术概念
   列出讨论中涉及的重要工程概念、DOE 策略、仿真工具、领域常量及框架。

3. Campaign 状态
   [若本次会话未激活工程 campaign，完全跳过本章。]
   - Campaign ID、项目名称及当前阶段
   - 时间线：campaign 如何推进至当前阶段（升级决策及数值依据，例如"L0 Pareto 超体积 0.73 < 阈值 0.85 → 升级至 L1"）
   - 当前 Pareto 前沿：非支配设计数量、关键权衡点的目标值
   - Campaign 的下一步预期动作

4. 计算记录与结果  ← 关键：必须逐字保留每个 provenance ID
   列出本次会话中**每一次**工具调用。格式：
     [prov-xxx] tool_name(key=val, key=val, ...) → ✓/⚠/✗  fidelity=L0/L1/L2
   这些 ID 是压缩后查询计算历史的唯一入口。
   不得汇总或省略任何 ID——它们是磁盘持久化记录的永久句柄。
   压缩后：使用 \`get_provenance(<id>)\` 查询单条记录，或
   使用 \`list_recent_results\` 按工具名/时间范围搜索。

5. V&V 事件
   列出所有验证/核查事件：
   - PRE-CALL ABORT：[prov-xxx] tool_name — 触发的钩子、问题所在、处理方式
   - POST-CALL ABORT：[prov-xxx] tool_name — 原始输出问题、已采取的替代动作
   - WARNING：[prov-xxx] tool_name — 提出的顾虑、结果是否附条件使用

6. 问题解决
   记录已解决的工程问题及正在进行中的排查工作。

7. 全部用户消息
   逐字列出**所有**用户消息（不含工具调用结果），最多保留最近 30 条。
   若超过 30 条，保留最早 2 条 + 最近 28 条。
   这些消息对理解意图变化至关重要。

8. 待办事项
   列出用户明确要求的所有待处理任务。

9. 当前工作
   精确描述本次压缩前正在进行的工作，包括最近一次工具调用及其结果。

10. 可选下一步
    与用户最近明确请求**直接相关**的下一步行动。
    重要：必须包含最近消息的原文引用，以证明任务判断无偏差。
    若为 campaign 工作，注明当前阶段名称及最后引用的 provenance ID。

输出格式示例：

<example>
<analysis>
[按时间顺序的分析，覆盖所有 provenance ID 及关键决策]
</analysis>

<summary>
1. 主要需求与意图：
   [详细描述]

2. 关键技术概念：
   - [概念]

3. Campaign 状态：
   Campaign: my-battery-project (ID: camp-abc) | 阶段：PARETO_READY_L1
   推进路径：L0 完成（24 个点）→ 超体积 0.73 < 阈值 0.85 → 用户批准升级至 L1
   L1 Pareto 前沿：3 个非支配设计；最佳权衡点 capacity=4.2 Ah, η=0.91
   下一步：审查 L1 Pareto，决定升级至 L2 或进入报告阶段

4. 计算记录与结果：
   [prov-a1b2c3] battery_capacity_sim(capacity=4.2, temp=25) → ✓  fidelity=L0
   [prov-d4e5f6] battery_capacity_sim(capacity=4.5, temp=35) → ⚠  fidelity=L0
   [prov-g7h8i9] surrogate_eval(design_id=42) → ✓  fidelity=L1

5. V&V 事件：
   ⚠ [prov-d4e5f6] battery_capacity_sim — POST-CALL WARNING：效率 1.12 > 1.0（超出物理上限）；附条件使用，待 L1 确认

6. 问题解决：
   [描述]

7. 全部用户消息：
   - "为电池优化运行 DOE，容量 4–5 Ah，温度 20–40 °C"
   - "批准 L1 升级"

8. 待办事项：
   - 审查 L1 Pareto 前沿并决定升级路径

9. 当前工作：
   正在审查 L1 Pareto 前沿结果。最后一次计算：[prov-g7h8i9] surrogate_eval 返回 3 个非支配设计。

10. 可选下一步：
    向用户呈现 L1 Pareto 前沿，询问："升级至 L2 还是进入 REPORTING 阶段？"
    （来自最近消息原文："批准 L1 升级"）
</summary>
</example>

请按上述结构输出摘要，确保精确、完整。
`

// ─────────────────────────────────────────────────────────────────────────────
// Public: full compact prompt for MetaAgentSession path
// ─────────────────────────────────────────────────────────────────────────────

export function getMetaAgentCompactPrompt(): string {
  return NO_TOOLS_PREAMBLE + METAAGENT_COMPACT_BODY + NO_TOOLS_TRAILER
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: parse compact summary (strips <analysis> scratchpad)
// ─────────────────────────────────────────────────────────────────────────────

export function formatCompactSummary(raw: string): string {
  // Strip analysis scratchpad
  let out = raw.replace(/<analysis>[\s\S]*?<\/analysis>/, '')

  // Unwrap <summary> tags
  const match = out.match(/<summary>([\s\S]*?)<\/summary>/)
  if (match) {
    out = out.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${(match[1] ?? '').trim()}`)
  }

  return out.replace(/\n\n+/g, '\n\n').trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: ## Compact Instructions block for KernelBridge path
//
// CC's compact prompt explicitly checks for "## Compact Instructions" in the
// conversation context and follows those instructions when compacting.
// KernelBridge appends this to its system prompt so CC's auto-compact
// preserves provenance IDs and campaign state.
// ─────────────────────────────────────────────────────────────────────────────

export async function buildCompactInstructions(
  rtx: RuntimeContext | undefined,
  sessionId: string,
  sessionStartMs: number,
  /** Optional pre-compact snapshot — used to fill records produced during the
   *  current turn that aren't yet reflected in the live provenanceTracker
   *  query (race condition: compact fires mid-turn). */
  snapshot: CompactStateSnapshot | null = null,
  /**
   * Pre-fetched provenance records (Fix #10).  When the caller has already
   * queried the tracker (e.g. KernelBridge fetches them to build the snapshot),
   * pass them here to avoid a redundant list() call inside this function.
   * When omitted, the function fetches them itself.
   */
  prefetchedRecords?: Awaited<ReturnType<NonNullable<RuntimeContext['provenanceTracker']>['list']>>,
  /**
   * Active TaskContract for the current session.
   * When provided, the compact instructions include a verbatim copy of the
   * contract fields and a hard prohibition on modifying them, so compaction
   * can never silently drop or rewrite the goal anchor.
   */
  taskContract?: TaskContract,
): Promise<string> {
  const lines: string[] = [
    '## Compact Instructions',
    '',
    '压缩本次会话时，除标准章节外，还必须包含以下内容：',
    '',
    '**计算记录与结果**（关键——不得遗漏任何 provenance ID）：',
    '格式：[prov-xxx] tool_name(key_params) → ✓/⚠/✗ fidelity=L0/L1/L2',
    '',
    '**V&V 事件**：',
    '列出所有带 provenance ID 的 PRE-CALL ABORT、POST-CALL ABORT 和 WARNING。',
    '',
    '**Campaign 状态**（若有活跃 campaign）：',
    '包含阶段、带数值依据的升级决策，以及当前 Pareto 摘要。',
    '',
    '**可选下一步**必须包含最近消息的原文引用。',
  ]

  // ── Task Contract preservation ────────────────────────────────────────────
  //
  // When a TaskContract is active, inject the full contract verbatim into the
  // compact instructions.  The compact model MUST reproduce it word-for-word in
  // the summary's Chapter 0 — this prevents any compaction from silently
  // dropping the goal anchor or rewriting the primary goal.

  if (taskContract) {
    lines.push(
      '',
      '**Task Contract（目标锚点，严禁修改——必须逐字出现在摘要第 0 章）：**',
      `  contractId: ${taskContract.contractId}`,
      `  Primary Goal: ${taskContract.primaryGoal}`,
    )
    if (taskContract.nonGoals.length > 0) {
      lines.push(`  Non-Goals: ${taskContract.nonGoals.join(' | ')}`)
    }
    if (taskContract.constraints.length > 0) {
      lines.push(`  Hard Constraints: ${taskContract.constraints.join(' | ')}`)
    }
    if (taskContract.acceptanceCriteria.length > 0) {
      lines.push('  Acceptance Criteria:')
      for (const ac of taskContract.acceptanceCriteria) {
        const icon = ac.status === 'pass' ? '✅' : ac.status === 'fail' ? '❌' : '⬜'
        lines.push(`    ${icon} [${ac.id}] ${ac.description}`)
      }
    }
    if (taskContract.userApprovedDecisions.length > 0) {
      lines.push('  User-Approved Decisions:')
      for (const d of taskContract.userApprovedDecisions) {
        lines.push(`    [${d.at.slice(0, 10)}] ${d.decision}`)
      }
    }
    if (taskContract.currentPlan.length > 0) {
      lines.push('  Current Plan:')
      taskContract.currentPlan.forEach((step, i) => lines.push(`    ${i + 1}. ${step}`))
    }
    if (taskContract.openQuestions.length > 0) {
      lines.push(`  Open Questions: ${taskContract.openQuestions.join(' | ')}`)
    }
  }

  // ── Provenance records ────────────────────────────────────────────────────
  //
  // Strategy: collect live records from the tracker, then backfill any IDs
  // present in the snapshot but NOT in the live list (these are records produced
  // after _buildEnrichedSuffix() ran — the snapshot was written more recently).

  const liveLines: string[] = []
  const seenIds = new Set<string>()

  if (rtx?.provenanceTracker) {
    try {
      // Use pre-fetched records when available to avoid a redundant list() call
      // (Fix #10: KernelBridge._buildEnrichedSuffix already fetches them for
      // the snapshot; passing them here eliminates a second round-trip).
      const records = prefetchedRecords
        ?? await rtx.provenanceTracker.list({ since: sessionStartMs })
      for (const r of records) {
        seenIds.add(r.id)
        const vv = r.validationResults.some(v => !v.passed) ? '✗'
          : r.validationResults.some(v => v.severity === 'warning') ? '⚠'
          : '✓'
        const inputSummary = Object.entries(r.input ?? {})
          .slice(0, 3)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ')
        liveLines.push(`  [${r.id}] ${r.toolName}(${inputSummary}) → ${vv} fidelity=L${r.fidelityLevel}`)
      }
    } catch { /* swallow — compact instructions are advisory */ }
  }

  // Backfill from snapshot: records the live tracker doesn't know about yet
  const snapshotLines: string[] = []
  if (snapshot && snapshot.provenanceRecords.length > 0) {
    for (const r of snapshot.provenanceRecords) {
      if (!seenIds.has(r.id)) {
        snapshotLines.push(
          `  [${r.id}] ${r.toolName}(${r.inputSummary}) → ${r.vv} fidelity=L${r.fidelityLevel}  ` +
          `[快照@${new Date(snapshot.capturedAt).toISOString().slice(11, 16)}Z]`,
        )
      }
    }
  }

  if (liveLines.length > 0 || snapshotLines.length > 0) {
    lines.push('', '当前会话 provenance 记录（必须全部出现在压缩摘要中）：')
    lines.push(...liveLines)
    if (snapshotLines.length > 0) {
      lines.push('  [快照补录——以下记录产生于压缩指令构建之后：]')
      lines.push(...snapshotLines)
    }
  }

  // ── Campaign state ────────────────────────────────────────────────────────
  //
  // Prefer live context store; fall back to snapshot if available.

  let campaignLines: string[] = []
  try {
    const ctx = await MetaAgentContextStore.read()
    if (ctx && ctx.activeCampaigns.length > 0) {
      campaignLines = ctx.activeCampaigns.map(
        c => `  Campaign "${c.projectName ?? c.campaignId}" | Phase: ${c.phase}`,
      )
    }
  } catch { /* swallow */ }

  if (campaignLines.length === 0 && snapshot && snapshot.activeCampaigns.length > 0) {
    campaignLines = snapshot.activeCampaigns.map(
      c => `  Campaign "${c.projectName ?? c.campaignId}" | Phase: ${c.phase}  [from snapshot]`,
    )
  }

  if (campaignLines.length > 0) {
    lines.push('', '当前 campaign 状态（必须出现在第 3 章 Campaign 状态中）：')
    lines.push(...campaignLines)
  }

  // ── Campaign drift-guard: objectives + constraints from snapshot ──────────
  //
  // Inject objectives and constraints from the snapshot so the compact model
  // cannot silently drop them.  These fields are only present when
  // CampaignStateStore.load() succeeded during snapshot capture.
  if (snapshot && snapshot.activeCampaigns.length > 0) {
    const driftLines: string[] = []
    for (const c of snapshot.activeCampaigns) {
      const name = c.projectName ?? c.campaignId
      if (c.objectives && c.objectives.length > 0) {
        driftLines.push(`  [${name}] 优化目标（必须逐字保留在第 3 章）：`)
        for (const o of c.objectives) driftLines.push(`    - ${o}`)
      }
      if (c.constraints && c.constraints.length > 0) {
        driftLines.push(`  [${name}] 硬性约束（必须逐字保留在第 3 章，不得省略）：`)
        for (const ct of c.constraints) driftLines.push(`    - ${ct}`)
      }
      if (c.contextBlock) {
        driftLines.push(`  [${name}] 快照时的 campaign 状态摘要（供核对）：`)
        // Indent the contextBlock for readability
        for (const line of c.contextBlock.split('\n').slice(0, 15)) {
          driftLines.push(`    ${line}`)
        }
      }
    }
    if (driftLines.length > 0) {
      lines.push('', 'Campaign 目标与约束（防漂移保护——不得在压缩中丢失）：')
      lines.push(...driftLines)
    }
  }

  return lines.join('\n')
}
