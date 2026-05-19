/**
 * Meta-Agent Dynamic System Prompt — D1 through D10
 *
 * Two groups of sections (mirrors meta-agent-architecture.md §4.1 Dynamic Zone):
 *
 * PUBLIC BASE (all modes):
 *   D1c agent_directives [memoized] — AGENT.md: workflow procedures, project rules, caveats
 *   D0  task_contract    [memoized, keyed on updatedAt] — goal anchor (when present)
 *   D1a memory_guidance [memoized]  — taxonomy, write protocol, hard boundaries (static)
 *   D1b memory_content  [uncached]  — MEMORY.md index + per-query recalled topic files
 *   D2  env_info              — session_id, available tools, timestamp
 *   D3  language              — user language preference
 *   D4  current_mode          — single-line mode announcement
 *   D4a engineering_standards — units/sig-figs/notation (mode !== 'direct')
 *   D4b campaign_knowledge    — DOE phases/fidelity/Pareto (mode === 'campaign')
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
import type Anthropic from '@anthropic-ai/sdk';
import { type SystemPromptSection } from './systemPromptSections.js';
import type { RuntimeContext } from '../runtime/RuntimeContext.js';
import type { MetaAgentTool } from './types.js';
import type { SubAgentBridge } from '../subagent/SubAgentBridge.js';
import type { TaskContract } from './contract/types.js';
export type AgentMode = 'direct' | 'agentic' | 'campaign';
export declare function buildMemoryGuidanceSection(): SystemPromptSection;
export declare function buildMemoryContentSection(currentQuery: string, client?: Anthropic, sessionMode?: string): SystemPromptSection;
export declare function buildAgentDirectivesSection(projectDir: string): SystemPromptSection;
export declare function buildEnvInfoSection(sessionId: string, sessionStartMs: number, tools: MetaAgentTool[]): SystemPromptSection;
export declare function buildLanguageSection(language?: string): SystemPromptSection;
export declare function buildCurrentModeSection(mode: AgentMode): SystemPromptSection;
/** 单个 MCP server 的名称 + 指令，对应 CC 的 ConnectedMCPServer。 */
export interface McpServerInstruction {
    /** MCP server 名称，用作二级标题。空字符串表示匿名 server（无标题）。 */
    name: string;
    /** 该 server 提供的工具使用指南。 */
    instructions: string;
}
export declare function buildMcpInstructionsSection(mcpServers?: McpServerInstruction[]): SystemPromptSection;
/** 内置输出风格标识符（三种默认选项）。 */
export type BuiltinOutputStyle = 'summary' | 'detailed' | 'raw_numbers';
/**
 * 插件自定义输出风格，对应 CC 的 OutputStyleConfig。
 * 调用方可传入任意名称和完整 prompt 文本，不受内置选项限制。
 */
export interface CustomOutputStyle {
    /** 风格名称，用作输出风格标题。 */
    name: string;
    /** 完整的风格指令文本，注入模型系统提示。 */
    prompt: string;
}
/** 输出风格配置：内置标识符或插件自定义风格对象。 */
export type OutputStyle = BuiltinOutputStyle | CustomOutputStyle;
export declare function buildOutputStyleSection(style?: OutputStyle): SystemPromptSection;
export declare function buildEngineeringStandardsSection(mode: AgentMode): SystemPromptSection;
export declare function buildCampaignKnowledgeSection(mode: AgentMode): SystemPromptSection;
export declare function buildSummarizeToolResultsSection(): SystemPromptSection;
export declare function buildCampaignContextSection(): SystemPromptSection;
export declare function buildSessionProvenanceSection(rtx: RuntimeContext, sessionStartMs: number): SystemPromptSection;
export declare function buildPhaseGuidanceSection(): SystemPromptSection;
export declare function buildTaskContractSection(contract: TaskContract): SystemPromptSection;
export declare function buildSubAgentNotificationsSection(bridge: SubAgentBridge): SystemPromptSection;
export interface DynamicSectionOptions {
    sessionId: string;
    sessionStartMs: number;
    tools: MetaAgentTool[];
    mode: AgentMode;
    rtx?: RuntimeContext;
    language?: string;
    /** 已连接的 MCP server 列表，每个 server 含名称和使用说明。 */
    mcpServers?: McpServerInstruction[];
    outputStyle?: OutputStyle;
    /**
     * The current user prompt — used for per-query memory relevance selection.
     * Pass `prompt` from MetaAgentSession.submit() before the API call.
     */
    currentQuery?: string;
    /**
     * Anthropic client for the Haiku memory-relevance side-call.
     * When provided, topic file selection uses a Haiku one-shot instead of keyword match.
     * Falls back to keyword match on any error.
     */
    client?: Anthropic;
    /**
     * SubAgentBridge for the current session.
     * When provided, a volatile D11 section is added that drains pending
     * sub-agent completion/failure notifications into every prompt turn.
     * Without this, the parent agent cannot see sub-agent results automatically.
     */
    subAgentBridge?: SubAgentBridge;
    /**
     * Active TaskContract for the current session.
     * When provided, a memoized D0 section is prepended above all other dynamic
     * sections so the model always has access to the original user intent,
     * non-goals, constraints, and acceptance criteria — even across compaction.
     */
    taskContract?: TaskContract;
    /**
     * Root directory of the current project.  Used to discover AGENT.md for the
     * D1c agent_directives section.  Defaults to process.cwd() when omitted.
     *
     * Discovery order (first match wins):
     *   1. <projectDir>/.meta-agent/AGENT.md   — project-scoped directives
     *   2. <projectDir>/AGENT.md               — project root alternative
     *   3. ~/.meta-agent/AGENT.md              — global user directives
     */
    projectDir?: string;
}
/**
 * Returns the full list of dynamic sections for the given options.
 *
 * Ordering:
 *   D1c agent_directives [memoized]    — AGENT.md: workflow, project rules, caveats
 *   D0  task_contract    [memoized, keyed on updatedAt] — goal anchor (when present)
 *   D1a memory_guidance  [memoized]    — taxonomy + write protocol (static)
 *   D1b memory_content   [uncached]    — MEMORY.md index + recalled topic files
 *   D2  env_info         [memoized]
 *   D3  language         [memoized]
 *   D4  current_mode     [memoized]
 *   D4a engineering_standards [memoized] — mode !== 'direct'
 *   D4b campaign_knowledge    [memoized] — mode === 'campaign'
 *   D5  mcp_instructions [memoized]
 *   D6  output_style     [memoized]
 *   D7  summarize_tool_results [memoized]
 *   D11 subagent_notifications [uncached] — when subAgentBridge provided
 *   ── Campaign Assembly (campaign mode only) ──
 *   D8  campaign_context  [uncached]
 *   D9  session_provenance [memoized, invalidated on new records]
 *   D10 phase_guidance    [uncached]
 */
export declare function buildDynamicSections(opts: DynamicSectionOptions): SystemPromptSection[];
//# sourceMappingURL=dynamicPrompt.d.ts.map