/**
 * Meta-Agent Dynamic System Prompt — D1 through D10
 *
 * Two groups of sections (mirrors meta-agent-architecture.md §4.1 Dynamic Zone):
 *
 * PUBLIC BASE (all modes):
 *   D1c agent_directives [memoized] — AGENT.md: workflow procedures, project rules, caveats
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
import { WorkflowLoader } from '../workflow/WorkflowLoader.js';
import { systemPromptSection, DANGEROUS_uncachedSystemPromptSection, } from './systemPromptSections.js';
import { MetaAgentContextStore, USER_CHECKPOINT_PHASES, MACHINE_PHASES } from '../campaign/index.js';
import { campaignRegistry } from '../campaign/registry.js';
import { MEMORY_DIR, MEMORY_ENTRYPOINT_NAME } from './memory/paths.js';
import { ensureMemoryDirExists, loadMemoryIndex, } from './memory/memdir.js';
import { findRelevantMemories } from './memory/findRelevantMemories.js';
import { buildSubAgentNotificationSection } from '../subagent/SubAgentBridge.js';
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
const D8_D10_CACHE_TTL_MS = 500;
let _ctxCache = null;
/** Read MetaAgentContextStore with a 500 ms in-process TTL. */
async function _readCtxCached() {
    const now = Date.now();
    if (_ctxCache && (now - _ctxCache.ts) < D8_D10_CACHE_TTL_MS) {
        return _ctxCache.ctx;
    }
    const ctx = await MetaAgentContextStore.read();
    _ctxCache = { ctx, ts: now };
    return ctx;
}
// ─────────────────────────────────────────────────────────────────────────────
// D1b — Memory Content  [DANGEROUS_uncached]
//
// MEMORY.md index + recalled topic files.  Recomputed every turn because:
//   1. The model can write new topic files and update MEMORY.md during a turn.
//   2. Recalled topic files depend on the current user query (per-query relevance).
// ─────────────────────────────────────────────────────────────────────────────
export function buildMemoryContentSection(currentQuery, client, sessionMode, domainScope) {
    return DANGEROUS_uncachedSystemPromptSection('memory_content', async () => {
        await ensureMemoryDirExists();
        const [index, relevant] = await Promise.all([
            loadMemoryIndex(),
            findRelevantMemories({ query: currentQuery, memoryDir: MEMORY_DIR, client, sessionMode, domainScope }),
        ]);
        const parts = [];
        // MEMORY.md index
        parts.push(`## ${MEMORY_ENTRYPOINT_NAME}`, '');
        if (index) {
            parts.push(index);
        }
        else {
            parts.push(`Your ${MEMORY_ENTRYPOINT_NAME} is currently empty.`, 'When you save memories, they will appear here as an index.');
        }
        // Recalled topic files (injected inline after the index)
        if (relevant.length > 0) {
            parts.push('', '## Recalled memory files', '');
            for (const mem of relevant) {
                const { header, content } = mem;
                // Base meta: type · date
                const metaParts = [];
                if (header.type)
                    metaParts.push(header.type);
                if (header.date)
                    metaParts.push(header.date);
                // Revalidation flag — model must re-verify before use
                if (header.requiresRevalidation)
                    metaParts.push('🔄 requires_revalidation');
                // Source-verified badge for domain_knowledge
                if (header.type === 'domain_knowledge' && header.sourceVerified === false) {
                    metaParts.push('⚠ source_unverified');
                }
                const meta = metaParts.join(' · ');
                parts.push(`### ${header.name}  (\`${header.filename}\`)`, meta ? `_${meta}_` : '', '', content, '');
            }
        }
        return parts.filter(l => l !== undefined).join('\n');
    }, 'Memory content changes as the model writes new memories and as different topic files ' +
        'are selected per user query.');
}
// ─────────────────────────────────────────────────────────────────────────────
// D1c — Agent Directives  [memoized per session]
//
// Reads AGENT.md from the project directory and injects its full contents
// verbatim.  AGENT.md is the project owner's place to declare:
//   - Workflow procedures and phase gate criteria
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
 * Unified AGENT.md loader — delegates to WorkflowLoader.loadRaw() which is
 * the single source of truth for the 3-path discovery cascade:
 *   <projectDir>/.meta-agent/AGENT.md  →  <projectDir>/AGENT.md
 *   →  ~/.meta-agent/AGENT.md
 */
function _loadAgentMd(projectDir) {
    return WorkflowLoader.loadRaw(projectDir);
}
export function buildAgentDirectivesSection(projectDir) {
    // Memoized by section name — read once per SectionRegistry (= once per session).
    // AGENT.md is a static config file; mid-session writes to it are not picked up
    // until the next session (intentional — avoids surprising prompt changes mid-turn).
    return systemPromptSection('agent_directives', () => {
        const content = _loadAgentMd(projectDir);
        if (!content)
            return null;
        return (`## Agent Directives\n\n` +
            `_Loaded from AGENT.md — project-specific workflow procedures, rules, and caveats._\n\n` +
            content);
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// D2 — Environment Info
//
// 对齐 CC computeSimpleEnvInfo 风格：只注入模型实际需要的环境信息。
// 删除 session_id（内部调度信息，模型无需引用）和工具列表（tools[] 已通过 API 传递）。
// 保留当前日期（时序判断）和知识截止日期（防止模型对截止日后的事件过度自信）。
// ─────────────────────────────────────────────────────────────────────────────
export function buildEnvInfoSection(sessionId, sessionStartMs) {
    return systemPromptSection('env_info', () => {
        // 从 sessionStartMs 推导当前日期（YYYY-MM-DD），供模型时序判断使用
        const currentDate = new Date(sessionStartMs).toISOString().slice(0, 10);
        const envItems = [
            `当前日期：${currentDate}`,
            `知识截止日期：2025 年 5 月（此日期之后的事件请通过工具获取最新信息）`,
        ];
        return [
            '## 运行环境',
            '',
            '当前运行环境信息：',
            ...envItems.map(item => ` - ${item}`),
        ].join('\n');
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// D3 — Language
//
// 对齐 CC getLanguageSection：
//   - 明确所有解释和沟通都使用目标语言
//   - 技术术语和代码标识符保持英文原形（CC 原文：Technical terms and code
//     identifiers should remain in their original form.）
// ─────────────────────────────────────────────────────────────────────────────
export function buildLanguageSection(language) {
    return systemPromptSection('language', () => {
        if (!language)
            return null;
        return (`## 语言偏好\n\n` +
            `始终使用 ${language} 回复。所有解释、注释和与用户的沟通均使用 ${language}。` +
            `技术术语和代码标识符保持英文原形。`);
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// D4 — Current Mode
//
// 英文模式标识符（DIRECT/AGENTIC/CAMPAIGN）保留，便于日志和规则引用；
// 描述文本汉化。
// ─────────────────────────────────────────────────────────────────────────────
export function buildCurrentModeSection(mode) {
    const modeDescriptions = {
        agentic: 'AGENTIC — 允许多轮工具调用；不得启动或推进 campaign。',
        campaign: 'CAMPAIGN — 完整多步骤 campaign 工作流已激活；按指示使用 campaign 和仿真工具。',
        robotics: 'ROBOTICS — 机器人开发专项模式；ExperienceStore、硬件配置、Git 工作区及子 Agent 编排已激活。优先查阅经验库和硬件配置，所有代码须符合绑定平台的安全限制。',
    };
    return systemPromptSection('current_mode', () => {
        return `## 当前模式\n\n${modeDescriptions[mode]}`;
    });
}
export function buildMcpInstructionsSection(mcpServers) {
    return systemPromptSection('mcp_instructions', () => {
        if (!mcpServers || mcpServers.length === 0)
            return null;
        const serversWithInstructions = mcpServers.filter(s => s.instructions.trim());
        if (serversWithInstructions.length === 0)
            return null;
        const blocks = serversWithInstructions
            .map(s => s.name
            ? `## ${s.name}\n${s.instructions}`
            : s.instructions)
            .join('\n\n');
        return (`# MCP 服务器指令\n\n` +
            `以下 MCP 服务器提供了工具使用说明：\n\n` +
            blocks);
    });
}
/** 内置风格的名称和 prompt 定义。 */
const BUILTIN_STYLE_CONFIGS = {
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
};
export function buildOutputStyleSection(style) {
    return systemPromptSection('output_style', () => {
        if (!style)
            return null;
        // 区分内置风格（字符串）和插件自定义风格（对象）
        const { name, prompt } = typeof style === 'string'
            ? BUILTIN_STYLE_CONFIGS[style]
            : style;
        return `## 输出风格：${name}\n\n${prompt}`;
    });
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
export function buildEngineeringStandardsSection(mode) {
    return systemPromptSection('engineering_standards', () => {
        if (mode !== 'agentic' && mode !== 'campaign')
            return null;
        return `\
## Engineering Calculation Standards

- **Units**: Include units with every numerical value without exception. Never report a bare number.
- **Significant figures**: Match precision to fidelity level (L0: 2–3 sig figs, L1: 3–4, L2: 4–5).
- **Scientific notation**: Use for values > 1e6 or < 1e-3 (e.g. \`1.23e-4 m\` or \`1.23E-4 m\`).
- **Dimensional consistency**: Verify that input units match tool expectations before calling. \
Mismatched units are a common source of PRE-CALL ABORT.
- **Uncertainty**: When a result has known uncertainty, state it explicitly (e.g. \`± 5 %\`).
- **Assumptions**: List all simplifying assumptions before any analysis. \
Quantify the impact of key assumptions where possible.`;
    });
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
2. 重试后仍失败 → 向用户报告，附上失败的具体信息。`;
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

**\`get_computation_lineage\`** — 追踪哪些计算影响了某个结果。`;
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
- 向用户呈现该结果时，始终注明"⚠ 低置信度结果——详见 [prov-xxx] 的验证说明。"`;
export function buildToolInvocationSection(mode) {
    return systemPromptSection('tool_invocation_protocol', () => {
        const parts = ['## 工具调用协议', '', '### 通用规则', '', TOOL_GENERAL_RULES];
        if (mode === 'agentic') {
            parts.push('', TOOL_PROVENANCE_RULES);
        }
        else if (mode === 'campaign') {
            parts.push('', TOOL_PROVENANCE_RULES, '', TOOL_VV_RULES);
        }
        // robotics: general rules only — no provenance tools, no V&V
        return parts.join('\n');
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// D4b — Campaign Domain Knowledge  [memoized per mode]
//
// Injected only in campaign mode.  Contains general DOE/campaign conceptual
// knowledge (phase graph, fidelity levels, Pareto, escalation thresholds).
// Per-session campaign state is in D8 (campaign_context); per-phase guidance
// is in D10 (phase_guidance).
// ─────────────────────────────────────────────────────────────────────────────
export function buildCampaignKnowledgeSection(mode) {
    return systemPromptSection('campaign_knowledge', () => {
        if (mode !== 'campaign')
            return null;
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
across iterations signals that the design space is not yet fully explored.`;
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// D7 — Summarise Tool Results
//
// 汉化，强制性语言（MUST / 此要求强制执行）保留，确保模型不会跳过记录步骤。
// ─────────────────────────────────────────────────────────────────────────────
export function buildSummarizeToolResultsSection() {
    return systemPromptSection('summarize_tool_results', () => {
        return (`## 中间结果追踪\n\n` +
            `每次工具调用后，**必须**在继续操作前将结果记入推理过程。` +
            `以下情况的结果视为"关键结果"：` +
            `（a）用于后续计算，（b）将出现在最终报告中，（c）V&V 状态为 ⚠ 或 ✗。` +
            `始终包含数值、单位和溯源 ID。` +
            `此要求强制执行——不得推迟到后续轮次再记录。`);
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// D8 — Campaign Context  [DANGEROUS_uncached]
// ─────────────────────────────────────────────────────────────────────────────
export function buildCampaignContextSection() {
    return DANGEROUS_uncachedSystemPromptSection('campaign_context', async () => {
        // P2: Use micro-cached read so D8 and D10 share one disk round-trip per turn.
        const ctx = await _readCtxCached();
        if (!ctx || ctx.activeCampaigns.length === 0)
            return null;
        const blocks = ctx.activeCampaigns.map(c => c.contextBlock);
        return ['## 活跃工程 Campaign', ...blocks].join('\n\n');
    }, 'Campaign state updates every few seconds during active runs; stale context ' +
        'would cause the agent to miss phase transitions and act on outdated Pareto fronts.');
}
// ─────────────────────────────────────────────────────────────────────────────
// D9 — Session Provenance  [memoized, invalidated on new records]
// ─────────────────────────────────────────────────────────────────────────────
export function buildSessionProvenanceSection(rtx, sessionStartMs) {
    return systemPromptSection('session_provenance', async () => {
        try {
            const records = await rtx.provenanceTracker.list({ since: sessionStartMs });
            if (records.length === 0)
                return null;
            const hasFailure = (r) => r.validationResults.some(v => !v.passed);
            const hasWarning = (r) => r.validationResults.some(v => v.passed && v.severity === 'warning');
            const isProblematic = (r) => hasFailure(r) || hasWarning(r);
            const problems = records.filter(isProblematic).reverse();
            const successes = records.filter(r => !isProblematic(r)).reverse();
            const recent = [...problems, ...successes].slice(0, 10);
            const lines = recent.map(r => {
                const vv = hasFailure(r) ? '✗' : hasWarning(r) ? '⚠' : '✓';
                // Compact timestamp: HH:MM UTC (date omitted — all records are this session)
                const ts = new Date(r.timestamp).toISOString().slice(11, 16) + 'Z';
                // Short input summary ≤ 50 chars  (key=val pairs, first 3 keys)
                const inputStr = Object.entries(r.input ?? {})
                    .slice(0, 3)
                    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                    .join(', ');
                const inputSummary = inputStr.length > 50 ? inputStr.slice(0, 47) + '...' : inputStr;
                return `  [${r.id}] ${r.toolName}(${inputSummary}) → ${vv}  fidelity=L${r.fidelityLevel}  ${ts}`;
            });
            return (`## 本会话计算记录\n\n` +
                lines.join('\n') +
                `\n\n` +
                `工具：\`get_provenance(<id>)\` 查看完整记录 · ` +
                `\`get_computation_lineage\` 追踪派生链 · ` +
                `\`find_duplicate_computation\` 重复检查`);
        }
        catch {
            return null;
        }
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// D10 — Phase Guidance  [DANGEROUS_uncached]
//
// Delegates to each campaign's plugin for phase-specific guidance strings.
// No hardcoded DOE phase map here — each plugin owns its own guidance.
// ─────────────────────────────────────────────────────────────────────────────
export function buildPhaseGuidanceSection() {
    return DANGEROUS_uncachedSystemPromptSection('phase_guidance', async () => {
        try {
            // P2: Re-use the same micro-cached read as D8 — zero extra disk I/O per turn.
            const ctx = await _readCtxCached();
            if (!ctx || ctx.activeCampaigns.length === 0)
                return null;
            const guidanceLines = [];
            for (const campaign of ctx.activeCampaigns) {
                const phase = campaign.phase;
                const pluginType = campaign.pluginType;
                // Look up the plugin — fall back gracefully if not registered
                let guidance = '';
                if (pluginType && campaignRegistry.has(pluginType)) {
                    const plugin = campaignRegistry.get(pluginType);
                    // Phase guidance doesn't need the full state — pass empty object
                    // for plugins that don't inspect state in buildPhaseGuidance()
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        guidance = plugin.buildPhaseGuidance(phase, {});
                    }
                    catch {
                        // Plugin threw — skip guidance for this campaign
                    }
                }
                if (guidance) {
                    guidanceLines.push(`**${campaign.projectName ?? campaign.campaignId}** (${phase}):\n${guidance}`);
                }
                // Phase-type reminders: check plugin's phase definitions if available
                if (pluginType && campaignRegistry.has(pluginType)) {
                    const plugin = campaignRegistry.get(pluginType);
                    const isHuman = plugin.phases.humanCheckpoints.includes(phase);
                    const isMachine = plugin.phases.machinePhases.includes(phase);
                    if (isHuman) {
                        guidanceLines.push(`  ⏸ 等待你的决策，campaign 将在确认后继续。`);
                    }
                    else if (isMachine) {
                        guidanceLines.push(`  ⚙ 机器执行阶段——无需调用工具，后台任务正在运行。`);
                    }
                }
                else {
                    // Fallback for legacy DOE campaigns without pluginType in context
                    if (USER_CHECKPOINT_PHASES.has(phase)) {
                        guidanceLines.push(`  ⏸ 等待你的决策，campaign 将在确认后继续。`);
                    }
                    if (MACHINE_PHASES.has(phase)) {
                        guidanceLines.push(`  ⚙ 机器执行阶段——无需调用工具，后台任务正在运行。`);
                    }
                }
            }
            if (guidanceLines.length === 0) {
                // Campaigns are active but no plugin produced guidance (unregistered plugin type
                // or all plugins threw). Give the agent a minimal orientation hint.
                const names = ctx.activeCampaigns
                    .map(c => `${c.projectName ?? c.campaignId} (${c.phase})`)
                    .join(', ');
                return `## Campaign 阶段指导\n\n活跃 campaign：${names}。\n` +
                    `当前插件类型暂无阶段专属指导。` +
                    `可调用 \`get_campaign_status\` 查看详情，或调用 \`list_campaigns\` 检查状态。`;
            }
            return `## Campaign 阶段指导\n\n${guidanceLines.join('\n\n')}`;
        }
        catch {
            return null;
        }
    }, 'Phase guidance must reflect the current campaign phase, which can change ' +
        'between turns as background jobs complete.');
}
// ─────────────────────────────────────────────────────────────────────────────
// D0 — Task Contract  [memoized until contract changes]
//
// Injected ABOVE all other sections when a TaskContract exists for the session.
// This is the immutable goal anchor: compaction cannot remove or rewrite it.
// Displayed in a prominent "DRIFT GUARD" block so the model always knows the
// original intent, non-goals, constraints, and acceptance criteria status.
// ─────────────────────────────────────────────────────────────────────────────
export function buildTaskContractSection(contract) {
    // Uses a memoized section keyed on contract.updatedAt — only rebuilt when the
    // contract changes, so it's stable for prompt-cache across consecutive turns.
    return systemPromptSection(`task_contract_${contract.updatedAt}`, () => {
        const lines = [];
        lines.push('## ⚓ Task Contract (Goal Anchor — Immutable)');
        lines.push('');
        lines.push(`**Primary Goal:** ${contract.primaryGoal}`);
        if (contract.nonGoals.length > 0) {
            lines.push('');
            lines.push('**Non-Goals (explicitly out of scope):**');
            for (const ng of contract.nonGoals)
                lines.push(`  - ${ng}`);
        }
        if (contract.constraints.length > 0) {
            lines.push('');
            lines.push('**Hard Constraints:**');
            for (const c of contract.constraints)
                lines.push(`  - ${c}`);
        }
        if (contract.acceptanceCriteria.length > 0) {
            lines.push('');
            lines.push('**Acceptance Criteria:**');
            for (const ac of contract.acceptanceCriteria) {
                const icon = ac.status === 'pass' ? '✅' : ac.status === 'fail' ? '❌' : '⬜';
                lines.push(`  ${icon} [${ac.id}] ${ac.description}`);
            }
        }
        if (contract.userApprovedDecisions.length > 0) {
            lines.push('');
            lines.push('**User-Approved Decisions:**');
            for (const d of contract.userApprovedDecisions) {
                const ts = d.at.slice(0, 10);
                const evStr = d.evidence ? ` (evidence: ${d.evidence})` : '';
                lines.push(`  - [${ts}] ${d.decision}${evStr}`);
            }
        }
        if (contract.currentPlan.length > 0) {
            lines.push('');
            lines.push('**Current Plan:**');
            contract.currentPlan.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
        }
        if (contract.openQuestions.length > 0) {
            lines.push('');
            lines.push('**Open Questions (must resolve before completion):**');
            for (const q of contract.openQuestions)
                lines.push(`  - ${q}`);
        }
        lines.push('');
        lines.push('> ⚠ Do NOT propose actions that contradict the primary goal or violate any hard constraint above. ' +
            'If you believe a change to the contract is needed, stop and ask the user explicitly.');
        return lines.join('\n');
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// D11 — Sub-Agent Notifications  [DANGEROUS_uncached]
//
// Drains pending completion/failure notifications from the SubAgentBridge and
// injects them into the prompt so the parent agent sees results the moment they
// are ready.  Returns null (no section added) when there are no pending
// notifications or when no bridge is provided.
// ─────────────────────────────────────────────────────────────────────────────
export function buildSubAgentNotificationsSection(bridge) {
    return DANGEROUS_uncachedSystemPromptSection('subagent_notifications', () => {
        const block = buildSubAgentNotificationSection(bridge);
        return block || null;
    }, 'Sub-agent completions arrive asynchronously; stale state would hide ' +
        'completed results from the parent agent for an entire turn.');
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
export function buildDynamicSections(opts) {
    const effectiveProjectDir = opts.projectDir ?? process.cwd();
    const base = [
        // D1c: Agent Directives — project-specific workflow procedures, rules, and
        // caveats loaded from AGENT.md.  Placed first so the project owner's standing
        // instructions form the outermost framing before any session-specific context
        // (task contract, memories, campaign state) is injected.
        buildAgentDirectivesSection(effectiveProjectDir),
        // D0: Task Contract — goal anchor immediately after project directives so the
        // model sees original intent before any volatile sections.
        ...(opts.taskContract ? [buildTaskContractSection(opts.taskContract)] : []),
        buildMemoryContentSection(opts.currentQuery ?? '', opts.client, opts.mode, opts.domain),
        buildEnvInfoSection(opts.sessionId, opts.sessionStartMs),
        buildLanguageSection(opts.language),
        buildCurrentModeSection(opts.mode),
        buildEngineeringStandardsSection(opts.mode),
        buildCampaignKnowledgeSection(opts.mode),
        buildToolInvocationSection(opts.mode),
        // Rx: mode-specific extensions — injected here so they appear after the
        // shared tool protocol but before infrastructure sections (MCP, output style).
        // Resolved by the caller's SectionRegistry alongside all other sections.
        ...(opts.modeExtensions ?? []),
        buildMcpInstructionsSection(opts.mcpServers),
        buildOutputStyleSection(opts.outputStyle),
        buildSummarizeToolResultsSection(),
        // D11: sub-agent notifications — always injected when a bridge is present so
        // the parent agent sees completed sub-tasks on the very next turn after they
        // finish, regardless of session mode.
        ...(opts.subAgentBridge
            ? [buildSubAgentNotificationsSection(opts.subAgentBridge)]
            : []),
    ];
    // Campaign assembly is only needed in campaign mode.
    // robotics / agentic / direct modes skip D8-D10.
    if (opts.mode !== 'campaign')
        return base;
    // Campaign Assembly — only in campaign mode
    const campaignAssembly = [
        buildCampaignContextSection(),
        ...(opts.rtx
            ? [buildSessionProvenanceSection(opts.rtx, opts.sessionStartMs)]
            : []),
        buildPhaseGuidanceSection(),
    ];
    return [...base, ...campaignAssembly];
}
//# sourceMappingURL=dynamicPrompt.js.map