/**
 * Meta-Agent Dynamic System Prompt — D1 through D10
 *
 * Two groups of sections (mirrors meta-agent-architecture.md §4.1 Dynamic Zone):
 *
 * PUBLIC BASE (all modes):
 *   D1c agent_directives [memoized] — AGENT.md: workflow procedures, project rules, caveats
 *   D1d skill_manifest   [memoized] — compact index of user-defined skills for this mode
 *   D0  task_contract    [memoized, keyed on updatedAt] — goal anchor (when present)
 *   D1b memory_content  [uncached]  — MEMORY.md index + per-query recalled topic files
 *
 * NOTE: D1a (memory_guidance / write protocol) has been intentionally removed.
 *   Memory writes are handled by a post-session sub-agent that evaluates and
 *   persists valuable public memories.  The main agent only reads (D1b); it
 *   does not need to know how to write.
 *   D2  env_info              — session_id, available tools, timestamp
 *   D3  language              — user language preference
 *   D4  current_mode          — single-line mode announcement
 *   D4a engineering_standards — units/sig-figs/notation (agentic + campaign only)
 *   D4b campaign_knowledge    — DOE phases/fidelity/Pareto (mode === 'campaign')
 *   D4c tool_invocation_protocol — mode-specific tool rules (moved from static S4):
 *         robotics: general rules only (no provenance tools, no V&V)
 *         direct:   general rules only
 *         agentic:  general rules + provenance tools (dedup before expensive calls)
 *         campaign: full rules — general + provenance tools + V&V response handling
 *   D5  mcp_instructions      — MCP tool instructions (when connected)
 *   D6  output_style          — report verbosity preference
 *   D7  summarize_tool_results — directive to note key findings mid-turn
 *
 * CAMPAIGN ASSEMBLY (CAMPAIGN mode only, appended after base):
 *   D8  campaign_context  [DANGEROUS_uncached] — active campaign phases + Pareto
 *   D9  session_provenance [memoized]          — recent computation records
 *   D10 phase_guidance    [DANGEROUS_uncached] — per-phase operational instructions
 *
 * Each exported build* function returns a SystemPromptSection that can be
 * registered with a SectionRegistry in MetaAgentSession.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { WorkflowLoader } from '../workflow/WorkflowLoader.js'
import {
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  type SystemPromptSection,
} from './systemPromptSections.js'

import { MetaAgentContextStore, USER_CHECKPOINT_PHASES, MACHINE_PHASES } from '../campaign/index.js'
import { campaignRegistry } from '../campaign/registry.js'
import type { RuntimeContext } from '../runtime/RuntimeContext.js'
import { MEMORY_DIR, MEMORY_ENTRYPOINT_NAME } from './memory/paths.js'
import {
  ensureMemoryDirExists,
  loadMemoryIndex,
} from './memory/memdir.js'
import { findRelevantMemories } from './memory/findRelevantMemories.js'
import type { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import { buildSubAgentNotificationSection } from '../subagent/SubAgentBridge.js'
import type { TaskContract } from './contract/types.js'
import { listAllSkillNames, readSkill, extractSkillDescription } from '../tools/system/skill/index.js'

// ── AgentMode ─────────────────────────────────────────────────────────────────

export type AgentMode = 'agentic' | 'campaign' | 'robotics'

// ─────────────────────────────────────────────────────────────────────────────
// P2: D8/D10 micro-cache — 500 ms TTL
//
// MetaAgentContextStore already has a 2 s TTL cache, but both D8 and D10
// call read() (or buildInjectionBlock()) independently within the same
// submit() turn.  This module-level cache ensures both sections hit the same
// in-process value without even touching MetaAgentContextStore's own cache.
//
// Invalidated whenever CampaignMonitor writes a new active-context.metaagent —
// the 500 ms window means at most one extra stale turn before the update lands.
// ─────────────────────────────────────────────────────────────────────────────

const D8_D10_CACHE_TTL_MS = 500

interface _CtxCacheEntry {
  ctx: Awaited<ReturnType<typeof MetaAgentContextStore.read>>
  ts:  number
}

let _ctxCache: _CtxCacheEntry | null = null

/** Read MetaAgentContextStore with a 500 ms in-process TTL. */
async function _readCtxCached() {
  const now = Date.now()
  if (_ctxCache && (now - _ctxCache.ts) < D8_D10_CACHE_TTL_MS) {
    return _ctxCache.ctx
  }
  const ctx = await MetaAgentContextStore.read()
  _ctxCache = { ctx, ts: now }
  return ctx
}

// ─────────────────────────────────────────────────────────────────────────────
// D1b — Memory Content  [DANGEROUS_uncached]
//
// MEMORY.md index + recalled topic files.  Recomputed every turn because:
//   1. The model can write new topic files and update MEMORY.md during a turn.
//   2. Recalled topic files depend on the current user query (per-query relevance).
// ─────────────────────────────────────────────────────────────────────────────

export function buildMemoryContentSection(
  currentQuery: string,
  client?: Anthropic,
  sessionMode?: string,
  domainScope?: string,
): SystemPromptSection {
  return DANGEROUS_uncachedSystemPromptSection(
    'memory_content',
    async () => {
      await ensureMemoryDirExists()

      const [index, relevant] = await Promise.all([
        loadMemoryIndex(),
        findRelevantMemories({ query: currentQuery, memoryDir: MEMORY_DIR, client, sessionMode, domainScope }),
      ])

      const parts: string[] = []

      // MEMORY.md index
      parts.push(`## ${MEMORY_ENTRYPOINT_NAME}`, '')
      if (index) {
        parts.push(index)
      } else {
        parts.push(
          `Your ${MEMORY_ENTRYPOINT_NAME} is currently empty.`,
          'When you save memories, they will appear here as an index.',
        )
      }

      // Recalled topic files (injected inline after the index)
      if (relevant.length > 0) {
        parts.push('', '## Recalled memory files', '')
        for (const mem of relevant) {
          const { header, content } = mem

          // Base meta: type · date
          const metaParts: string[] = []
          if (header.type) metaParts.push(header.type)
          if (header.date) metaParts.push(header.date)

          // Revalidation flag — model must re-verify before use
          if (header.requiresRevalidation) metaParts.push('🔄 requires_revalidation')

          // Source-verified badge (legacy field — domain_knowledge type no longer used)
          if (header.sourceVerified === false) {
            metaParts.push('⚠ source_unverified')
          }

          const meta = metaParts.join(' · ')
          parts.push(
            `### ${header.name}  (\`${header.filename}\`)`,
            meta ? `_${meta}_` : '',
            '',
            content,
            '',
          )
        }
      }

      return parts.filter(l => l !== undefined).join('\n')
    },
    'Memory content changes as the model writes new memories and as different topic files ' +
    'are selected per user query.',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// D1c — Agent Directives  [memoized per session]
//
// Reads AGENT.md from the project directory and injects its soft-control
// contents. Any explicit <META-WORKFLOW> block is stripped before injection
// because the workflow state machine consumes that block structurally.
// AGENT.md is the project owner's place to declare:
//   - Project procedures and preferences
//   - Project-specific rules and conventions
//   - Important caveats (e.g. deprecated APIs, known hardware quirks)
//   - Any standing instructions that must persist across compaction
//
// Discovery (first match wins):
//   1. <projectDir>/.meta-agent/AGENT.md   — project-scoped directives
//   2. <projectDir>/AGENT.md               — project root alternative
//   3. ~/.meta-agent/AGENT.md              — global user directives (fallback)
//
// The section is memoized per session: AGENT.md is read once on the first
// submit() and cached for the session lifetime.  A new session always picks
// up the latest version of the file.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unified AGENT.md loader — delegates to WorkflowLoader.loadAgentDirectives()
 * which is the single source of truth for the 3-path discovery cascade and
 * strips explicit <META-WORKFLOW> blocks before D1c injection:
 *   <projectDir>/.meta-agent/AGENT.md  →  <projectDir>/AGENT.md
 *   →  ~/.meta-agent/AGENT.md
 */
function _loadAgentMd(projectDir: string): string | null {
  return WorkflowLoader.loadAgentDirectives(projectDir)
}

export function buildAgentDirectivesSection(projectDir: string): SystemPromptSection {
  // Memoized by section name — read once per SectionRegistry (= once per session).
  // AGENT.md is a static config file; mid-session writes to it are not picked up
  // until the next session (intentional — avoids surprising prompt changes mid-turn).
  return systemPromptSection('agent_directives', () => {
    const content = _loadAgentMd(projectDir)
    if (!content) return null
    return (
      `## Agent Directives\n\n` +
      `_Loaded from AGENT.md — project-specific rules, preferences, and caveats._\n\n` +
      content
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// D1d — Skill Manifest  [memoized per session]
//
// Ultra-compact index of user-defined skills available in this mode.
// Skills are separate from tools — they are Markdown files containing
// specialised instructions, templates, or domain knowledge.  This section
// tells the model what skills exist so it can proactively call
// `skill(action="load", name="<name>")` when a skill is relevant.
//
// Token budget: ~5 tokens per skill (name only) + ~10 tokens header.
// No skill content is injected here — only names + one-line description.
//
// Discovery order (see skill/index.ts for details):
//   1. <projectDir>/.meta-agent/skills/         — project-scoped
//   2. ~/.meta-agent/skills/<mode>/             — user global, mode-specific
//   3. ~/.meta-agent/skills/                    — user global, all modes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build D1d: a compact skill manifest for the current mode.
 * Memoized — skills are read once on the first submit() per session.
 */
export function buildSkillManifestSection(mode: AgentMode, projectDir: string): SystemPromptSection {
  return systemPromptSection('skill_manifest', async () => {
    const names = await listAllSkillNames(projectDir, mode)
    if (names.length === 0) return null

    // For each skill, extract a one-line description (first non-heading line).
    // Cap at 12 skills to keep the manifest tight; extras are still loadable.
    const shown = names.slice(0, 12)
    const lines = await Promise.all(
      shown.map(async name => {
        try {
          const content = await readSkill(name, projectDir, mode)
          const desc = content ? extractSkillDescription(content) : ''
          return desc ? `  • ${name} — ${desc}` : `  • ${name}`
        } catch {
          return `  • ${name}`
        }
      }),
    )

    const overflow = names.length > 12 ? `\n  *(${names.length - 12} more — use \`skill list\`)*` : ''

    return (
      `## Available Skills\n\n` +
      `*Load any skill with \`skill(action="load", name="<name>")\` to inject its full instructions.*\n\n` +
      lines.join('\n') +
      overflow
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// D2 — Environment Info
//
// 对齐 CC computeSimpleEnvInfo 风格：只注入模型实际需要的环境信息。
// 删除 session_id（内部调度信息，模型无需引用）和工具列表（tools[] 已通过 API 传递）。
// 保留当前日期（时序判断）和知识截止日期（防止模型对截止日后的事件过度自信）。
// ─────────────────────────────────────────────────────────────────────────────

export function buildEnvInfoSection(
  sessionId: string,
  sessionStartMs: number,
): SystemPromptSection {
  return systemPromptSection('env_info', () => {
    // 从 sessionStartMs 推导当前日期（YYYY-MM-DD），供模型时序判断使用
    const currentDate = new Date(sessionStartMs).toISOString().slice(0, 10)

    const envItems = [
      `当前日期：${currentDate}`,
      `知识截止日期：2025 年 5 月（此日期之后的事件请通过工具获取最新信息）`,
    ]

    return [
      '## 运行环境',
      '',
      '当前运行环境信息：',
      ...envItems.map(item => ` - ${item}`),
    ].join('\n')
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// D3 — Language
//
// 对齐 CC getLanguageSection：
//   - 明确所有解释和沟通都使用目标语言
//   - 技术术语和代码标识符保持英文原形（CC 原文：Technical terms and code
//     identifiers should remain in their original form.）
// ─────────────────────────────────────────────────────────────────────────────

export function buildLanguageSection(language?: string): SystemPromptSection {
  return systemPromptSection('language', () => {
    if (!language) return null
    return (
      `## 语言偏好\n\n` +
      `始终使用 ${language} 回复。所有解释、注释和与用户的沟通均使用 ${language}。` +
      `技术术语和代码标识符保持英文原形。`
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// D4 — Current Mode
//
// 英文模式标识符（DIRECT/AGENTIC/CAMPAIGN）保留，便于日志和规则引用；
// 描述文本汉化。
// ─────────────────────────────────────────────────────────────────────────────

export function buildCurrentModeSection(mode: AgentMode): SystemPromptSection {
  const modeDescriptions: Record<AgentMode, string> = {
    // Agentic：说明多轮工具调用已启用即可。
    // "不得启动 campaign" 是多余的负面约束——campaign 工具根本没有注册，
    // 模型调用不了，该句只是浪费 token。
    agentic:  'AGENTIC — 多轮工具调用已启用。',
    campaign: 'CAMPAIGN — 完整多步骤 campaign 工作流已激活；按指示使用 campaign 和仿真工具。',
    robotics: 'ROBOTICS — 机器人开发专项模式；ExperienceStore、硬件配置、Git 工作区及子 Agent 编排已激活。优先查阅经验库和硬件配置，所有代码须符合绑定平台的安全限制。',
  }
  return systemPromptSection('current_mode', () => {
    return `## 当前模式\n\n${modeDescriptions[mode]}`
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// D5 — MCP Instructions
//
// 对齐 CC getMcpInstructions：按 server 分组，每个 server 独立二级标题。
// 单 server 场景（name 为空字符串）退化为无标题块，保持向后兼容。
// ─────────────────────────────────────────────────────────────────────────────

/** 单个 MCP server 的名称 + 指令，对应 CC 的 ConnectedMCPServer。 */
export interface McpServerInstruction {
  /** MCP server 名称，用作二级标题。空字符串表示匿名 server（无标题）。 */
  name: string
  /** 该 server 提供的工具使用指南。 */
  instructions: string
}

export function buildMcpInstructionsSection(
  mcpServers?: McpServerInstruction[],
): SystemPromptSection {
  return systemPromptSection('mcp_instructions', () => {
    if (!mcpServers || mcpServers.length === 0) return null

    const serversWithInstructions = mcpServers.filter(s => s.instructions.trim())
    if (serversWithInstructions.length === 0) return null

    const blocks = serversWithInstructions
      .map(s =>
        s.name
          ? `## ${s.name}\n${s.instructions}`
          : s.instructions,
      )
      .join('\n\n')

    return (
      `# MCP 服务器指令\n\n` +
      `以下 MCP 服务器提供了工具使用说明：\n\n` +
      blocks
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// D6 — Output Style
//
// 对齐 CC OutputStyleConfig 插件级扩展：
//   - 内置三种风格（BuiltinOutputStyle）保留为 default，描述汉化
//   - 支持插件/调用方传入自定义风格（CustomOutputStyle: name + prompt），
//     行为与 CC "# Output Style: ${name}\n${prompt}" 一致
//   - OutputStyle = BuiltinOutputStyle | CustomOutputStyle（向后兼容）
// ─────────────────────────────────────────────────────────────────────────────

/** 内置输出风格标识符（三种默认选项）。 */
export type BuiltinOutputStyle = 'summary' | 'detailed' | 'raw_numbers'

/**
 * 插件自定义输出风格，对应 CC 的 OutputStyleConfig。
 * 调用方可传入任意名称和完整 prompt 文本，不受内置选项限制。
 */
export interface CustomOutputStyle {
  /** 风格名称，用作输出风格标题。 */
  name: string
  /** 完整的风格指令文本，注入模型系统提示。 */
  prompt: string
}

/** 输出风格配置：内置标识符或插件自定义风格对象。 */
export type OutputStyle = BuiltinOutputStyle | CustomOutputStyle

/** 内置风格的名称和 prompt 定义。 */
const BUILTIN_STYLE_CONFIGS: Record<BuiltinOutputStyle, { name: string; prompt: string }> = {
  summary: {
    name: '简洁摘要',
    prompt: '提供简洁摘要。除非特别要求，省略中间步骤。',
  },
  detailed: {
    name: '详细展开',
    prompt: '展示完整工作过程——假设条件、中间步骤和最终结果。',
  },
  raw_numbers: {
    name: '原始数值',
    prompt: '以最少的文字返回数值结果。优先使用表格和数值，而非文字说明。',
  },
}

export function buildOutputStyleSection(style?: OutputStyle): SystemPromptSection {
  return systemPromptSection('output_style', () => {
    if (!style) return null

    // 区分内置风格（字符串）和插件自定义风格（对象）
    const { name, prompt } =
      typeof style === 'string'
        ? BUILTIN_STYLE_CONFIGS[style]
        : style

    return `## 输出风格：${name}\n\n${prompt}`
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// D4a — Engineering Calculation Standards  [memoized per mode]
//
// Injected only for agentic and campaign modes.
//   direct:   single-turn Q&A — sig-fig rules are noise.
//   robotics: hardware/controls work — not needed at current stage.
//   agentic:  multi-step computation — units + precision matter.
//   campaign: DOE / simulation — full fidelity requirements.
// ─────────────────────────────────────────────────────────────────────────────

export function buildEngineeringStandardsSection(mode: AgentMode): SystemPromptSection {
  return systemPromptSection('engineering_standards', () => {
    if (mode !== 'agentic' && mode !== 'campaign') return null
    return `\
## Engineering Calculation Standards

- **Units**: Include units with every numerical value without exception. Never report a bare number.
- **Significant figures**: Match precision to fidelity level (L0: 2–3 sig figs, L1: 3–4, L2: 4–5).
- **Scientific notation**: Use for values > 1e6 or < 1e-3 (e.g. \`1.23e-4 m\` or \`1.23E-4 m\`).
- **Dimensional consistency**: Verify that input units match tool expectations before calling. \
Mismatched units are a common source of PRE-CALL ABORT.
- **Uncertainty**: When a result has known uncertainty, state it explicitly (e.g. \`± 5 %\`).
- **Assumptions**: List all simplifying assumptions before any analysis. \
Quantify the impact of key assumptions where possible.`
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// D4c — Tool Invocation Protocol  [memoized per mode]
//
// Moved from static S4.  Content is trimmed per mode:
//
//   direct / robotics  — general rules only (parallel execution, error recovery).
//                        No provenance tools (no high-cost simulations).
//                        No V&V rules (V&V pipeline not active).
//   agentic            — general rules + provenance tool guidance (dedup before
//                        expensive calls), but no V&V response rules.
//   campaign           — full content: general rules + provenance tools + V&V
//                        response handling (PRE-CALL ABORT / POST-CALL ABORT).
// ─────────────────────────────────────────────────────────────────────────────

/** Shared across all modes: parallel execution + error recovery. */
const TOOL_GENERAL_RULES = `\
**并行执行**：彼此无数据依赖的工具可在同一轮次并行调用。\
若一个工具的输出是另一个工具的输入，必须顺序调用。

**工具描述具有权威性**：每个工具的描述中同时规定了何时使用和何时不得使用。遵守这些边界。

**错误恢复**：
1. 工具抛出异常（\`Tool error: ...\`）→ 读取错误信息，修正入参，重试一次。
2. 重试后仍失败 → 向用户报告，附上失败的具体信息。`

/** Provenance tool guidance — agentic + campaign modes. */
const TOOL_PROVENANCE_RULES = `\
### 溯源工具

**\`find_duplicate_computation\`** — 在每次高开销仿真工具调用前调用。\
对于轻量或即时操作（文件读取、简单查询），不得调用。
- 提供精确的 \`tool_name\`（字符串）和 \`input\`（完整输入对象）。
- 字段级精确匹配——单位变化或多一个 key 都会产生不同哈希。
- 若返回 \`{ duplicate: true }\`，使用现有 \`provenanceId\`，不重新运行。

**\`get_provenance\`** — 查看已知 ID 的完整记录。

**\`list_recent_results\`** — 获取本会话所有计算的概览。

**\`get_computation_lineage\`** — 追踪哪些计算影响了某个结果。`

/** V&V response rules — campaign mode only. */
const TOOL_VV_RULES = `\
### V&V 响应

**\`[V&V PRE-CALL ABORT]\`** — 工具**未执行**。
- 修正触发违规的具体输入后重试。不得以相同输入重试。
- 若输入看起来正确，调用 \`get_provenance(<id>)\` 查看完整验证详情。

**\`[V&V POST-CALL ABORT]\`** — 工具**已执行**，但输出未通过验证。
- 调用 \`get_provenance(<id>)\` 查看工具实际返回的内容。
- 不得以相同输入重试——工具会产生相同的无效输出。

**\`[V&V WARNING]\`** — 工具执行成功，但输出存在非致命问题。
- 结果可用，但置信度较低。
- 向用户呈现该结果时，始终注明"⚠ 低置信度结果——详见 [prov-xxx] 的验证说明。"`

export function buildToolInvocationSection(mode: AgentMode): SystemPromptSection {
  return systemPromptSection('tool_invocation_protocol', () => {
    const parts: string[] = ['## 工具调用协议', '', '### 通用规则', '', TOOL_GENERAL_RULES]

    if (mode === 'agentic') {
      parts.push('', TOOL_PROVENANCE_RULES)
    } else if (mode === 'campaign') {
      parts.push('', TOOL_PROVENANCE_RULES, '', TOOL_VV_RULES)
    }
    // robotics: general rules only — no provenance tools, no V&V

    return parts.join('\n')
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// D4b — Campaign Domain Knowledge  [memoized per mode]
//
// Injected only in campaign mode.  Contains general DOE/campaign conceptual
// knowledge (phase graph, fidelity levels, Pareto, escalation thresholds).
// Per-session campaign state is in D8 (campaign_context); per-phase guidance
// is in D10 (phase_guidance).
// ─────────────────────────────────────────────────────────────────────────────

export function buildCampaignKnowledgeSection(mode: AgentMode): SystemPromptSection {
  return systemPromptSection('campaign_knowledge', () => {
    if (mode !== 'campaign') return null
    return `\
## Campaign Domain Knowledge

**Campaign system**: Campaigns are plugin-based. Each plugin type (e.g. \`doe\`, \`paper-repro\`) \
defines its own phase graph. The DOE phase graph is the default reference; \
other plugins may use a subset or a different structure — always inspect \`campaignType\` before assuming DOE phases apply.

**DOE campaign phases** (state machine):
- \`IDLE\` → \`SAMPLING\` → \`EVALUATING_L0\` → \`PARETO_READY_L0\`
- \`PARETO_READY_L0\` → \`ESCALATING_L1\` → \`PARETO_READY_L1\` (if L1 warranted)
- \`PARETO_READY_L1\` → \`ESCALATING_L2\` → \`PARETO_READY_L2\` (if L2 warranted)
- Any active phase → \`REPORTING\` → \`DONE\`
- Any active phase → \`FAILED\` (on timeout, constraint violation, or explicit failure)

**Fidelity levels**:
- L0 (analytical): Fast closed-form or empirical models. Use for initial screening — 2–3 sig figs.
- L1 (surrogate): Trained surrogate models. Higher accuracy, moderate compute — 3–4 sig figs.
- L2 (high-fidelity): Full simulation (FEA, CFD, etc.). Slowest, highest accuracy — 4–5 sig figs.

**Escalation thresholds** (PARETO_READY → ESCALATING):
- Escalate L0 → L1 if: Pareto hypervolume improvement < 2 % across the last 3 iterations, \
OR fewer than 5 non-dominated designs exist, OR a high-gradient region has < 3 evaluated points.
- Escalate L1 → L2 if: top-3 Pareto designs are within 5 % of each other on all objectives \
(L1 cannot disambiguate them) AND L2 cost is within budget.
- Proceed to REPORTING if neither condition applies at the current fidelity level.
- Always present Pareto evidence and receive explicit user acknowledgment before escalating.

**Pareto front**: The set of non-dominated designs — no other design in the evaluated set \
is strictly better on all objectives simultaneously. Improvement in Pareto hypervolume \
across iterations signals that the design space is not yet fully explored.`
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// D7 — Summarise Tool Results
//
// 汉化，强制性语言（MUST / 此要求强制执行）保留，确保模型不会跳过记录步骤。
// ─────────────────────────────────────────────────────────────────────────────

export function buildSummarizeToolResultsSection(mode: AgentMode = 'agentic'): SystemPromptSection {
  return systemPromptSection('summarize_tool_results', () => {
    // 关键结果的判定条件因模式而异：
    //   campaign — 有 V&V 状态（⚠/✗）和溯源 ID，需全部标注
    //   agentic  — 有溯源 ID，无 V&V 状态
    //   robotics — 无溯源 ID，无 V&V；只需追踪数值结果用于后续步骤
    if (mode === 'campaign') {
      return (
        `## 中间结果追踪\n\n` +
        `工具调用产生关键结果时，必须在后续分析或最终报告中准确引用。` +
        `以下情况视为"关键结果"：` +
        `（a）用于后续计算，（b）将出现在最终报告中，（c）V&V 状态为 ⚠ 或 ✗。` +
        `始终包含数值、单位和溯源 ID。` +
        `不要复述无决策价值的普通工具输出。`
      )
    }
    if (mode === 'agentic') {
      return (
        `## 中间结果追踪\n\n` +
        `工具调用产生关键结果时，必须在后续分析或最终报告中准确引用。` +
        `以下情况视为"关键结果"：` +
        `（a）用于后续计算，（b）将出现在最终报告中。` +
        `结果含溯源 ID 时须一并标注。` +
        `不要复述无决策价值的普通工具输出。`
      )
    }
    // robotics
    return (
      `## 中间结果追踪\n\n` +
      `工具调用产生关键结果时，必须在后续分析或最终报告中准确引用。` +
      `以下情况视为"关键结果"：` +
      `（a）用于后续步骤，（b）将出现在最终报告中。` +
      `不要复述无决策价值的普通工具输出。`
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// D8 — Campaign Context  [DANGEROUS_uncached]
// ─────────────────────────────────────────────────────────────────────────────

export function buildCampaignContextSection(): SystemPromptSection {
  return DANGEROUS_uncachedSystemPromptSection(
    'campaign_context',
    async () => {
      // P2: Use micro-cached read so D8 and D10 share one disk round-trip per turn.
      const ctx = await _readCtxCached()
      if (!ctx || ctx.activeCampaigns.length === 0) return null
      const blocks = ctx.activeCampaigns.map(c => c.contextBlock)
      return ['## 活跃工程 Campaign', ...blocks].join('\n\n')
    },
    'Campaign state updates every few seconds during active runs; stale context ' +
    'would cause the agent to miss phase transitions and act on outdated Pareto fronts.',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// D9 — Session Provenance  [memoized, invalidated on new records]
// ─────────────────────────────────────────────────────────────────────────────

export function buildSessionProvenanceSection(
  rtx: RuntimeContext,
  sessionStartMs: number,
): SystemPromptSection {
  return systemPromptSection('session_provenance', async () => {
    try {
      const records = await rtx.provenanceTracker.list({ since: sessionStartMs })
      if (records.length === 0) return null

      // Up to 10 records: aborts/warnings first (newest-first within each group),
      // then successes (newest-first). Format mirrors compact Chapter 4:
      //   [prov-xxx] tool_name(key=val, ...) → ✓/⚠/✗  fidelity=L0/L1/L2  HH:MMZ
      // Use `list_recent_results` for the full session history.
      type VVEntry = { passed: boolean; severity?: string }
      const hasFailure = (r: { validationResults: VVEntry[] }) =>
        r.validationResults.some(v => !v.passed)
      const hasWarning = (r: { validationResults: VVEntry[] }) =>
        r.validationResults.some(v => v.passed && v.severity === 'warning')
      const isProblematic = (r: { validationResults: VVEntry[] }) =>
        hasFailure(r) || hasWarning(r)
      const problems  = records.filter(isProblematic).reverse()
      const successes = records.filter(r => !isProblematic(r)).reverse()
      const recent = [...problems, ...successes].slice(0, 10)
      const lines = recent.map(r => {
        const vv = hasFailure(r) ? '✗' : hasWarning(r) ? '⚠' : '✓'
        // Compact timestamp: HH:MM UTC (date omitted — all records are this session)
        const ts = new Date(r.timestamp).toISOString().slice(11, 16) + 'Z'
        // Short input summary ≤ 50 chars  (key=val pairs, first 3 keys)
        const inputStr = Object.entries(r.input ?? {})
          .slice(0, 3)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ')
        const inputSummary = inputStr.length > 50 ? inputStr.slice(0, 47) + '...' : inputStr
        return `  [${r.id}] ${r.toolName}(${inputSummary}) → ${vv}  fidelity=L${r.fidelityLevel}  ${ts}`
      })

      return (
        `## 本会话计算记录\n\n` +
        lines.join('\n') +
        `\n\n` +
        `工具：\`get_provenance(<id>)\` 查看完整记录 · ` +
        `\`get_computation_lineage\` 追踪派生链 · ` +
        `\`find_duplicate_computation\` 重复检查`
      )
    } catch {
      // Provenance listing is advisory; any error (missing store, corrupt record)
      // silently skips the section rather than crashing the prompt assembly.
      return null
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// D10 — Phase Guidance  [DANGEROUS_uncached]
//
// Delegates to each campaign's plugin for phase-specific guidance strings.
// No hardcoded DOE phase map here — each plugin owns its own guidance.
// ─────────────────────────────────────────────────────────────────────────────

export function buildPhaseGuidanceSection(): SystemPromptSection {
  return DANGEROUS_uncachedSystemPromptSection(
    'phase_guidance',
    async () => {
      try {
        // P2: Re-use the same micro-cached read as D8 — zero extra disk I/O per turn.
        const ctx = await _readCtxCached()
        if (!ctx || ctx.activeCampaigns.length === 0) return null

        const guidanceLines: string[] = []
        for (const campaign of ctx.activeCampaigns) {
          const phase      = campaign.phase as string
          const pluginType = campaign.pluginType

          // Look up the plugin — fall back gracefully if not registered
          let guidance = ''
          if (pluginType && campaignRegistry.has(pluginType)) {
            const plugin = campaignRegistry.get(pluginType)
            // Phase guidance doesn't need the full state — pass empty object
            // for plugins that don't inspect state in buildPhaseGuidance()
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              guidance = plugin.buildPhaseGuidance(phase as never, {} as any)
            } catch {
              // Plugin threw — skip guidance for this campaign
            }
          }

          if (guidance) {
            guidanceLines.push(
              `**${campaign.projectName ?? campaign.campaignId}** (${phase}):\n${guidance}`,
            )
          }

          // Phase-type reminders: check plugin's phase definitions if available
          if (pluginType && campaignRegistry.has(pluginType)) {
            const plugin = campaignRegistry.get(pluginType)
            const isHuman  = (plugin.phases.humanCheckpoints as readonly string[]).includes(phase)
            const isMachine = (plugin.phases.machinePhases as readonly string[]).includes(phase)

            if (isHuman) {
              guidanceLines.push(
                `  ⏸ 等待你的决策，campaign 将在确认后继续。`,
              )
            } else if (isMachine) {
              guidanceLines.push(
                `  ⚙ 机器执行阶段——无需调用工具，后台任务正在运行。`,
              )
            }
          } else {
            // Fallback for legacy DOE campaigns without pluginType in context
            if (USER_CHECKPOINT_PHASES.has(phase as never)) {
              guidanceLines.push(`  ⏸ 等待你的决策，campaign 将在确认后继续。`)
            }
            if (MACHINE_PHASES.has(phase as never)) {
              guidanceLines.push(`  ⚙ 机器执行阶段——无需调用工具，后台任务正在运行。`)
            }
          }
        }

        if (guidanceLines.length === 0) {
          // Campaigns are active but no plugin produced guidance (unregistered plugin type
          // or all plugins threw). Give the agent a minimal orientation hint.
          const names = ctx.activeCampaigns
            .map(c => `${c.projectName ?? c.campaignId} (${c.phase})`)
            .join(', ')
          return `## Campaign 阶段指导\n\n活跃 campaign：${names}。\n` +
            `当前插件类型暂无阶段专属指导。` +
            `可调用 \`get_campaign_status\` 查看详情，或调用 \`list_campaigns\` 检查状态。`
        }
        return `## Campaign 阶段指导\n\n${guidanceLines.join('\n\n')}`
      } catch {
        // Phase guidance is advisory; any error (plugin crash, store unavailable)
        // silently omits the section rather than breaking the prompt assembly.
        return null
      }
    },
    'Phase guidance must reflect the current campaign phase, which can change ' +
    'between turns as background jobs complete.',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// D0 — Task Contract  [memoized until contract changes]
//
// Injected ABOVE all other sections when a TaskContract exists for the session.
// This is the immutable goal anchor: compaction cannot remove or rewrite it.
// Displayed in a prominent "DRIFT GUARD" block so the model always knows the
// original intent, non-goals, constraints, and acceptance criteria status.
// ─────────────────────────────────────────────────────────────────────────────

export function buildTaskContractSection(
  contract: TaskContract,
): SystemPromptSection {
  // Uses a memoized section keyed on contract.updatedAt — only rebuilt when the
  // contract changes, so it's stable for prompt-cache across consecutive turns.
  return systemPromptSection(`task_contract_${contract.updatedAt}`, () => {
    const lines: string[] = []

    lines.push('## ⚓ Task Contract (Goal Anchor — Immutable)')
    lines.push('')
    lines.push(`**Primary Goal:** ${contract.primaryGoal}`)

    if (contract.nonGoals.length > 0) {
      lines.push('')
      lines.push('**Non-Goals (explicitly out of scope):**')
      for (const ng of contract.nonGoals) lines.push(`  - ${ng}`)
    }

    if (contract.constraints.length > 0) {
      lines.push('')
      lines.push('**Hard Constraints:**')
      for (const c of contract.constraints) lines.push(`  - ${c}`)
    }

    if (contract.acceptanceCriteria.length > 0) {
      lines.push('')
      lines.push('**Acceptance Criteria:**')
      for (const ac of contract.acceptanceCriteria) {
        const icon = ac.status === 'pass' ? '✅' : ac.status === 'fail' ? '❌' : '⬜'
        lines.push(`  ${icon} [${ac.id}] ${ac.description}`)
      }
    }

    if (contract.userApprovedDecisions.length > 0) {
      lines.push('')
      lines.push('**User-Approved Decisions:**')
      for (const d of contract.userApprovedDecisions) {
        const ts = d.at.slice(0, 10)
        const evStr = d.evidence ? ` (evidence: ${d.evidence})` : ''
        lines.push(`  - [${ts}] ${d.decision}${evStr}`)
      }
    }

    if (contract.currentPlan.length > 0) {
      lines.push('')
      lines.push('**Current Plan:**')
      contract.currentPlan.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`))
    }

    if (contract.openQuestions.length > 0) {
      lines.push('')
      lines.push('**Open Questions (must resolve before completion):**')
      for (const q of contract.openQuestions) lines.push(`  - ${q}`)
    }

    lines.push('')
    lines.push(
      '> ⚠ Do NOT propose actions that contradict the primary goal or violate any hard constraint above. ' +
      'If you believe a change to the contract is needed, stop and ask the user explicitly.',
    )

    return lines.join('\n')
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// D11 — Sub-Agent Notifications  [DANGEROUS_uncached]
//
// Drains pending completion/failure notifications from the SubAgentBridge and
// injects them into the prompt so the parent agent sees results the moment they
// are ready.  Returns null (no section added) when there are no pending
// notifications or when no bridge is provided.
// ─────────────────────────────────────────────────────────────────────────────

export function buildSubAgentNotificationsSection(
  bridge: SubAgentBridge,
): SystemPromptSection {
  return DANGEROUS_uncachedSystemPromptSection(
    'subagent_notifications',
    () => {
      const block = buildSubAgentNotificationSection(bridge)
      return block || null
    },
    'Sub-agent completions arrive asynchronously; stale state would hide ' +
    'completed results from the parent agent for an entire turn.',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Public builder — assemble base + optional campaign assembly
// ─────────────────────────────────────────────────────────────────────────────

export interface DynamicSectionOptions {
  sessionId: string
  sessionStartMs: number
  mode: AgentMode
  /** Engineering domain used to filter domain-scoped memories. */
  domain?: string
  rtx?: RuntimeContext
  language?: string
  /** 已连接的 MCP server 列表，每个 server 含名称和使用说明。 */
  mcpServers?: McpServerInstruction[]
  outputStyle?: OutputStyle
  /**
   * The current user prompt — used for per-query memory relevance selection.
   * Pass `prompt` from MetaAgentSession.submit() before the API call.
   */
  currentQuery?: string
  /**
   * Client for the flash model memory-relevance side-call.
   * When provided, topic file selection uses a flash model one-shot instead of keyword match.
   * Falls back to keyword match on any error.
   */
  client?: Anthropic
  /**
   * SubAgentBridge for the current session.
   * When provided, a volatile D11 section is added that drains pending
   * sub-agent completion/failure notifications into every prompt turn.
   * Without this, the parent agent cannot see sub-agent results automatically.
   */
  subAgentBridge?: SubAgentBridge
  /**
   * Active TaskContract for the current session.
   * When provided, a memoized D0 section is prepended above all other dynamic
   * sections so the model always has access to the original user intent,
   * non-goals, constraints, and acceptance criteria — even across compaction.
   */
  taskContract?: TaskContract
  /**
   * Root directory of the current project.  Used to discover AGENT.md for the
   * D1c agent_directives section.  Defaults to process.cwd() when omitted.
   *
   * Discovery order (first match wins):
   *   1. <projectDir>/.meta-agent/AGENT.md   — project-scoped directives
   *   2. <projectDir>/AGENT.md               — project root alternative
   *   3. ~/.meta-agent/AGENT.md              — global user directives
   */
  projectDir?: string
  /**
   * Mode-specific section extensions — injected after D4c (tool_invocation_protocol)
   * and before D5 (mcp_instructions).
   *
   * Allows mode-specific sessions (e.g. RoboticsSession with R1-R5) to route their
   * sections through the unified pipeline without coupling core/ to mode-specific
   * dependencies.  The sections are resolved by the caller's SectionRegistry in the
   * usual way — memoized sections are cached, volatile ones recompute each turn.
   *
   * @example
   *   buildDynamicSections({
   *     mode: 'robotics',
   *     modeExtensions: [buildR1Section(...), buildR2Section(...), ...],
   *     ...
   *   })
   */
  modeExtensions?: SystemPromptSection[]
}

/**
 * Returns the full list of dynamic sections for the given options.
 *
 * Ordering:
 *   D1c agent_directives [memoized]    — AGENT.md: workflow, project rules, caveats
 *   D0  task_contract    [memoized, keyed on updatedAt] — goal anchor (when present)
 *   D1b memory_content   [uncached]    — MEMORY.md index + recalled topic files
 *   D2  env_info         [memoized]
 *   D3  language         [memoized]
 *   D4  current_mode     [memoized]
 *   D4a engineering_standards [memoized] — agentic/campaign modes
 *   D4b campaign_knowledge    [memoized] — mode === 'campaign'
 *   D4c tool_invocation_protocol [memoized] — mode-trimmed: robotics=general only;
 *                                             agentic=+provenance; campaign=+provenance+V&V
 *   Rx  modeExtensions    [caller-managed] — optional mode-specific sections (e.g. R1-R5)
 *   D5  mcp_instructions [memoized]
 *   D6  output_style     [memoized]
 *   D7  summarize_tool_results [memoized]
 *   D11 subagent_notifications [uncached] — when subAgentBridge provided
 *   ── Campaign Assembly (campaign mode only) ──
 *   D8  campaign_context  [uncached]
 *   D9  session_provenance [memoized, invalidated on new records]
 *   D10 phase_guidance    [uncached]
 */
// ─────────────────────────────────────────────────────────────────────────────
// Volatile context sections — injected as a user message prefix, NOT into
// the system message.
//
// Background: DeepSeek uses automatic prefix-match KV caching.  The full token
// sequence is [system_msg][conv_history][current_user_msg].  If the system
// message changes on any turn, the cache prefix collapses to zero and ALL
// conversation history loses its cached KV state — not just the system tokens.
//
// Solution: keep the system message frozen (only stable memoized sections) and
// inject volatile per-turn context into the user message as XML-tagged blocks:
//
//   <context>
//   <memory>...</memory>
//   <subagent_status>...</subagent_status>
//   ...
//   </context>
//
//   ---
//
//   {actual user message}
//
// Sections returned (resolved via the caller's SectionRegistry):
//   D1b  memory_content        [uncached] — per-query recalled memories
//   Rx   volatileExtensions    [caller-managed] — mode-specific volatile sections
//                               (e.g. R2 experience_index, R3 subagent_tasks,
//                                R5 progress_notes, team section)
//   D11  subagent_notifications [uncached] — pending sub-agent completions
//   D8   campaign_context      [uncached] — campaign mode only
//   D9   session_provenance    [memoized/invalidated] — campaign mode only
//   D10  phase_guidance        [uncached] — campaign mode only
// ─────────────────────────────────────────────────────────────────────────────

export interface VolatileContextOptions {
  /** Current user query — passed to D1b for per-query memory relevance. */
  currentQuery?: string
  /** Client for flash model memory side-call; falls back to keyword match. */
  client?: Anthropic
  /** Agent mode — scopes D1b memory relevance and enables campaign sections. */
  mode?: AgentMode
  /** Engineering domain — filters domain-scoped memories in D1b. */
  domain?: string
  /** SubAgentBridge — when provided, D11 subagent_notifications is included. */
  subAgentBridge?: SubAgentBridge
  /**
   * Mode-specific volatile extensions resolved by the caller's SectionRegistry.
   * Examples for robotics mode:
   *   buildR2Section(store)               — experience_index
   *   buildR3Section(bridge, git, state)  — subagent_tasks
   *   buildR5Section(state, resumedAt)    — progress_notes
   *   buildTeamSection(store, watcher)    — team_status
   */
  volatileExtensions?: SystemPromptSection[]
  /** RuntimeContext — required for D9 session_provenance in campaign mode. */
  rtx?: RuntimeContext
  /** Session start timestamp — required for D9 in campaign mode. */
  sessionStartMs?: number
}

/**
 * Build the volatile context sections that must be injected as a user message
 * prefix rather than into the system message.
 *
 * Resolve via the caller's SectionRegistry, then format with formatVolatileContext().
 *
 * Usage:
 *   const volatileSections = buildVolatileContextSections({ currentQuery: prompt, ... })
 *   const resolved = await sectionRegistry.resolve(volatileSections)
 *   const prefix = formatVolatileContext(volatileSections, resolved)
 *   const effectivePrompt = prefix ? `${prefix}\n\n---\n\n${prompt}` : prompt
 */
export function buildVolatileContextSections(opts: VolatileContextOptions): SystemPromptSection[] {
  const sections: SystemPromptSection[] = [
    // D1b — per-query memory recall (always first so the model has memory context
    // before reading mode-specific state)
    buildMemoryContentSection(
      opts.currentQuery ?? '',
      opts.client,
      opts.mode,
      opts.domain,
    ),
  ]

  // Rx — caller-provided mode-specific volatile sections (R2, R3, R5, team, etc.)
  if (opts.volatileExtensions) {
    sections.push(...opts.volatileExtensions)
  }

  // D11 — sub-agent completion/failure notifications
  if (opts.subAgentBridge) {
    sections.push(buildSubAgentNotificationsSection(opts.subAgentBridge))
  }

  // Campaign assembly — D8/D9/D10 (campaign mode only)
  if (opts.mode === 'campaign') {
    sections.push(buildCampaignContextSection())
    if (opts.rtx && opts.sessionStartMs !== undefined) {
      sections.push(buildSessionProvenanceSection(opts.rtx, opts.sessionStartMs))
    }
    sections.push(buildPhaseGuidanceSection())
  }

  return sections
}

/** Maps internal section names to the XML tag used in the user message prefix. */
const VOLATILE_SECTION_TAGS: Record<string, string> = {
  memory_content:         'memory',
  experience_index:       'experience_index',
  robotics_subagents:     'subagent_status',
  robotics_progress:      'progress',
  robotics_team_mode:     'team_status',
  team_context_boundary:  'context_boundary',
  subagent_notifications: 'notifications',
  campaign_context:       'campaign_context',
  session_provenance:     'session_provenance',
  phase_guidance:         'phase_guidance',
}

/**
 * Format resolved volatile section content as an XML-tagged user message prefix.
 *
 * Returns null when no sections produced content (no prefix to prepend).
 *
 * Output format:
 *   <context>
 *   <memory>
 *   ...
 *   </memory>
 *
 *   <subagent_status>
 *   ...
 *   </subagent_status>
 *   </context>
 */
export function formatVolatileContext(
  sections: SystemPromptSection[],
  resolved: (string | null)[],
): string | null {
  const blocks: string[] = []
  for (let i = 0; i < sections.length; i++) {
    const content = resolved[i]
    if (!content) continue
    const tag = VOLATILE_SECTION_TAGS[sections[i].name] ?? sections[i].name
    blocks.push(`<${tag}>\n${content.trim()}\n</${tag}>`)
  }
  if (blocks.length === 0) return null
  return `<context>\n${blocks.join('\n\n')}\n</context>`
}

export function buildDynamicSections(opts: DynamicSectionOptions): SystemPromptSection[] {
  const effectiveProjectDir = opts.projectDir ?? process.cwd()

  const base: SystemPromptSection[] = [
    // D1c: Agent Directives — project-specific workflow procedures, rules, and
    // caveats loaded from AGENT.md.  Placed first so the project owner's standing
    // instructions form the outermost framing before any session-specific context
    // (task contract, memories, campaign state) is injected.
    buildAgentDirectivesSection(effectiveProjectDir),
    // D1d: Skill Manifest — compact list of user-defined skills available in this
    // mode.  Placed immediately after project directives so the model knows what
    // skills are available before any session-specific context is injected.
    // Skills are separate from tools: they are Markdown files the model loads
    // on demand via skill(action="load") — no skill content is injected here.
    buildSkillManifestSection(opts.mode, effectiveProjectDir),
    // D0: Task Contract — goal anchor immediately after project directives so the
    // model sees original intent before any volatile sections.
    ...(opts.taskContract ? [buildTaskContractSection(opts.taskContract)] : []),
    // NOTE: D1b (memory_content) has been moved to buildVolatileContextSections().
    // It must NOT be in the system message — DeepSeek KV cache requires the
    // system message to be byte-identical across turns to get prefix cache hits.
    buildEnvInfoSection(opts.sessionId, opts.sessionStartMs),
    buildLanguageSection(opts.language),
    buildCurrentModeSection(opts.mode),
    buildEngineeringStandardsSection(opts.mode),
    buildCampaignKnowledgeSection(opts.mode),
    buildToolInvocationSection(opts.mode),
    // Rx: mode-specific STABLE extensions — injected here so they appear after the
    // shared tool protocol but before infrastructure sections (MCP, output style).
    // Only pass memoized sections here; volatile mode sections go to modeExtensions
    // in buildVolatileContextSections() instead.
    ...(opts.modeExtensions ?? []),
    buildMcpInstructionsSection(opts.mcpServers),
    buildOutputStyleSection(opts.outputStyle),
    buildSummarizeToolResultsSection(opts.mode),
    // NOTE: D11 (subagent_notifications) has been moved to buildVolatileContextSections().
    // NOTE: D8/D9/D10 (campaign_context/session_provenance/phase_guidance) have been
    // moved to buildVolatileContextSections() — campaign state changes every few seconds.
  ]

  return base
}
