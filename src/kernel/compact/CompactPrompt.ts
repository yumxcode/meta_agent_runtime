import type { KernelMessage, ContentBlock } from '../types/KernelMessage.js'
import { stripVolatileContextPrefix } from '../utils/VolatileContext.js'

/**
 * CompactPrompt — the 9-section summarisation prompt.
 * Mirrors CC's prompt.ts exactly, including the ## Compact Instructions injection.
 */

const NO_TOOLS_PREAMBLE =
  '关键：只能用纯文本回复。不要调用任何工具。任何工具调用都会导致错误。'

const BASE_COMPACT_PROMPT = `你的任务是为目前为止的对话生成一份详细的总结，重点关注用户的明确请求和你已执行的操作。
这份总结将成为后续工作的上下文。`

const DETAILED_ANALYSIS_INSTRUCTION = `
在写总结之前，先把你的推理放进 <analysis> 标签里。这是你的私有思考空间——它不会出现在最终上下文中。用它来：
- 复盘已完成的工作和尚未完成的部分
- 找出所有未决线索、错误和决策
- 标记所有必须保留的关键信息
- 规划每一节要写什么

然后把总结写进 <summary> 标签里。`

/**
 * Compact prompt profile — selects the per-mode section template. Each agent
 * mode threads its profile through config.compact.promptProfile so the
 * summariser is asked for domain-appropriate sections.
 */
export type CompactProfile = 'agentic' | 'robotics' | 'campaign'

export const DEFAULT_COMPACT_PROFILE: CompactProfile = 'agentic'

/**
 * Agentic (default) — the generic 9-section coding-agent template.
 */
const SECTION_INSTRUCTIONS_AGENTIC = `
总结必须包含以下各节（使用 markdown 标题）：

## 1. 主要请求与意图
描述用户的主要目标和所有子目标。具体、完整。

## 2. 关键技术概念
列出用到的所有重要技术概念、框架、工具、模式和术语。涉及版本号时一并记录。

## 3. 文件与代码
列出每一个被读取、写入或讨论过的文件。对每个文件：
- 完整路径
- 做了什么（读取/创建/修改/讨论）
- 关键内容或改动（要具体——含函数名、变量名、重要取值）

## 4. 错误与修复
记录遇到的每一个错误及其解决方式（或未解决）。包括：
- 准确的错误信息或描述
- 根因（若已定位）
- 已采取的修复（若有）
- 当前状态

## 5. 问题解决
描述解决问题所采取的思路。包括：
- 尝试了什么、为什么
- 什么有效、什么无效
- 做出的关键决策

## 6. 所有用户消息
逐字或近似逐字列出用户的每一条消息。不要转述用户意图。

## 7. 待办任务
列出所有被明确要求但尚未完成的事项。要详尽。

## 8. 当前工作
详细描述对话被压缩时正在进行的工作：
- 正在进行的具体任务
- 当前状态（部分实现、错误状态等）
- 正在编写的相关代码

## 9. 可选的下一步
若对话明显朝某个方向推进，描述最重要的单一下一步动作。`

/**
 * Robotics — the 9 sections adapted to RL / algorithm development, plus three
 * domain sections: Experiment Ledger (exact metrics + commit/branch), Dead Ends
 * (proven-failed directions), and Assumptions / run conditions.
 */
const SECTION_INSTRUCTIONS_ROBOTICS = `
总结必须包含以下各节（使用 markdown 标题）。本会话是机器人算法开发，务必保住精确数字、实验出处与失败教训。

## 1. 主要请求与意图
描述用户的算法目标和所有子目标（如步态质量、指标阈值、sim2real 要求）。具体、完整。

## 2. 关键技术概念与算法
列出核心算法与设计：reward 项及其精确 scale、网络结构、关键超参（lr、entropy_coef、sigma、gamma 等）、训练框架与平台。涉及取值时记录精确值，不要写"约"。

## 3. 文件、配置与代码
列出每一个被读取、写入或讨论的文件（env、config、reward 实现等）。对每个：
- 完整路径
- 做了什么（读取/创建/修改/讨论）
- 关键内容（reward 公式、scale 取值、关键变量及单位）
- **产出该配置/结果的 commit 或 branch**（某版本配置常只在特定 commit 上；务必记下，避免后续在错误的 HEAD 上分析）

## 4. 错误与修复
记录每一个错误（代码 bug 与训练失败均算）：
- 准确的错误信息或失败现象（崩溃、NaN、reward 坍塌、reward hacking）
- 根因（若已定位）
- 修复（若有）
- 当前状态

## 5. 分析与问题解决
描述分析思路与结论。**必须给出数据里的真实数字**（reward 曲线、达成率、GRF、误差等），不得只写定性描述。包括尝试了什么、什么有效/无效、关键决策。

## 6. 所有用户消息
逐字或近似逐字列出用户的每一条消息。不要转述用户意图。

## 7. 待办任务
列出所有被明确要求但尚未完成的事项（含调参方向、消融、checkpoint 下载、仿真回放等）。要详尽。

## 8. 当前工作
详细描述对话被压缩时正在进行的工作：具体任务、当前状态、正在写的代码或正在跑/分析的实验。

## 9. 可选的下一步
若方向明确，描述最重要的单一下一步动作。

## 10. 实验台账（Experiment Ledger）
用表格列出本会话涉及的每一次训练实验，精确保留每一行：

| task_id | 版本/配置改动 | 关键指标(精确值) | commit/branch | 状态 |
|---------|--------------|-----------------|---------------|------|

指标用精确数值（如 mean_reward=100.05，不要写"约100"）。状态如 完成/失败/运行中/已停止@iter。

## 11. 失败方向（Dead Ends）
列出已被证实走不通的方向，**这些绝不能重复探索**：

| 方向 | 失败原因 | 证据(实验/指标) |
|------|---------|----------------|

## 12. 假设与运行条件
记录结果所依赖的关键假设与环境条件（num_envs、控制频率、dt、decimation、domain randomization 范围、地形/课程设置等）。若某假设对结果有实质影响，注明其影响——这些一旦丢失，上面的数字就失去意义。`

/**
 * Campaign — the 9 sections adapted to industrial-engineering projects, plus a
 * Provenance ledger (verbatim IDs + lineage) and a Phase Gate status section.
 */
const SECTION_INSTRUCTIONS_CAMPAIGN = `
总结必须包含以下各节（使用 markdown 标题）。本会话是工业工程项目，务必保住 provenance 标识与阶段门状态。

## 1. 主要请求与意图
描述用户的项目目标和所有子目标。具体、完整。

## 2. 关键概念与方法
列出用到的工程方法、标准、工具、模型与术语。涉及版本/规格时记录。

## 3. 文件、数据与产物
列出每一个被读取、写入或讨论的文件/数据集/产物。对每个：完整路径或标识、做了什么、关键内容或改动。

## 4. 错误与修复
记录每一个错误及其解决方式。含错误信息、根因、修复、当前状态。

## 5. 问题解决
描述解决思路：尝试了什么、什么有效/无效、关键决策。

## 6. 所有用户消息
逐字或近似逐字列出用户的每一条消息。不要转述。

## 7. 待办任务
列出所有被明确要求但尚未完成的事项。要详尽。

## 8. 当前工作
详细描述被压缩时正在进行的工作：具体任务、当前状态、相关产物。

## 9. 可选的下一步
若方向明确，描述最重要的单一下一步动作。

## 10. Provenance 台账
逐字保留本会话产生或引用的所有 provenance 标识（artifact ID、lineage ID、数据/产物版本号），以及它们之间的来源关系。这些 ID 绝不能转述或省略——后续步骤要靠它们追溯。

## 11. 阶段门状态（Phase Gate）
记录当前所处阶段、各阶段门的达成/阻塞情况、以及通过下一道门所需的交付物与条件。`

const SECTION_INSTRUCTIONS_BY_PROFILE: Record<CompactProfile, string> = {
  agentic: SECTION_INSTRUCTIONS_AGENTIC,
  robotics: SECTION_INSTRUCTIONS_ROBOTICS,
  campaign: SECTION_INSTRUCTIONS_CAMPAIGN,
}

const VOLATILE_CONTEXT_INSTRUCTION = `
易变上下文块：
- 用户消息可能以 <context>...</context> 块开头，后接 "---"。
- 把该块视为临时运行时状态，而非用户请求。
- 仅保留继续任务所必需的持久事实；不要把完整的记忆索引、经验清单、通知或进度面板抄进总结。`

const NO_TOOLS_TRAILER =
  '提醒：不要调用任何工具。只能用纯文本回复。你的回复必须只包含总结内容。'

/**
 * Final instruction appended as a USER message at the very END of the
 * conversation being summarized. The system prompt's no-tools instruction
 * sits 100k+ tokens away from the generation point, while the conversation
 * itself is saturated with tool-call examples; agentic-tuned models (GLM)
 * role-continue the agent's trajectory and emit tool-call TEMPLATE TEXT
 * (no tools are armed, so nothing intercepts it). Placing the instruction
 * adjacent to the generation point is the strongest counter-signal.
 */
export const COMPACT_FINAL_INSTRUCTION =
  '=== 待总结对话结束 ===\n' +
  '停止扮演上文中的 agent。你现在是总结者。\n' +
  '严格按照系统提示中的要求写出结构化总结。\n' +
  '关键：只能用纯文本。不要调用工具。不要输出 <tool_call>、<arg_key>、' +
  '函数调用语法，或任何对 agent 工作的延续。' +
  '先写你的 <analysis>，再写 <summary>。'

/**
 * Strip leaked tool-call TEMPLATE text (GLM-style) from a model "summary".
 * When the compact side-call is made without tools armed, an agentic model
 * that decides to "keep working" emits its tool-call chat-template tokens as
 * plain text: `<tool_call>name`, `<arg_key>…</arg_key>`, `<arg_value>…</arg_value>`.
 * These lines carry zero summary information and poison later compactions
 * (format contagion), so they are removed line-wise.
 */
const TOOL_CALL_TEMPLATE_LINE_RE =
  /^\s*<\/?(?:tool_call|tool_code|function_call|arg_key|arg_value)\b.*$/
export function stripLeakedToolCallText(text: string): string {
  if (!/<(?:tool_call|arg_key|arg_value)\b/.test(text)) return text
  return text
    .split('\n')
    .filter(line => !TOOL_CALL_TEMPLATE_LINE_RE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Minimum chars for a model summary to be considered usable at all. */
const SUMMARY_MIN_USABLE_CHARS = 200
/** Stricter minimum when the raw response contained leaked tool-call syntax. */
const SUMMARY_MIN_USABLE_CHARS_AFTER_LEAK = 600

/**
 * Quality gate for the compact model's output. A non-empty response is NOT
 * necessarily a summary: the observed failure mode is a "summary" that is
 * 100% leaked tool-call template text — it passes the empty check, carries
 * zero information, and then propagates through every nested compaction.
 * Returns false when the formatted summary should be DISCARDED in favour of
 * the deterministic local fallback.
 */
export function isUsableCompactSummary(formatted: string, rawResponse: string): boolean {
  const text = formatted.trim()
  const hadLeak = /<(?:tool_call|arg_key|arg_value)\b/.test(rawResponse)
  const minChars = hadLeak ? SUMMARY_MIN_USABLE_CHARS_AFTER_LEAK : SUMMARY_MIN_USABLE_CHARS
  return text.length >= minChars
}

/**
 * Extract the content of a ## Compact Instructions section from a system prompt.
 * Returns undefined if the section is not found.
 */
export function extractCompactInstructions(systemPrompt: string): string | undefined {
  // No 'm' flag: without it, '$' matches end-of-string only (not end-of-line),
  // so the lazy [\s\S]*? captures the entire section body, not just the first line.
  // '(?:^|\n)' replaces '^' to find the header anywhere in the string.
  const match = systemPrompt.match(
    /(?:^|\n)##\s*Compact Instructions[ \t]*\n([\s\S]*?)(?=\n##[ \t]|\n---[ \t]*\n|$)/i,
  )
  return match?.[1]?.trim()
}

/**
 * Build the full compact prompt sent to the summarisation agent.
 *
 * @param customInstructions  - From config.compact.customInstructions or
 *                              extracted from ## Compact Instructions in system prompt
 * @param profile             - Per-mode section template selector
 *                              (default 'agentic'). robotics/campaign add their
 *                              domain sections on top of an adapted 9-section base.
 */
export function buildCompactPrompt(
  customInstructions?: string,
  profile: CompactProfile = DEFAULT_COMPACT_PROFILE,
): string {
  const sectionInstructions =
    SECTION_INSTRUCTIONS_BY_PROFILE[profile] ?? SECTION_INSTRUCTIONS_BY_PROFILE[DEFAULT_COMPACT_PROFILE]

  const parts = [
    NO_TOOLS_PREAMBLE,
    '',
    BASE_COMPACT_PROMPT,
    DETAILED_ANALYSIS_INSTRUCTION,
    sectionInstructions,
    VOLATILE_CONTEXT_INSTRUCTION,
  ]

  if (customInstructions) {
    parts.push('', '## 额外指令', customInstructions)
  }

  parts.push('', NO_TOOLS_TRAILER)

  return parts.join('\n')
}

/**
 * Format the raw compact summary from the model:
 * 1. Strip <analysis>...</analysis> (private reasoning scratchpad)
 * 2. Replace <summary>...</summary> wrapper with "Summary:\n[content]"
 * 3. Collapse excessive blank lines
 */
export function formatCompactSummary(raw: string): string {
  let text = raw

  // Strip analysis block(s)
  text = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim()

  // Unwrap <summary> tags
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (summaryMatch?.[1]) {
    text = 'Summary:\n' + summaryMatch[1].trim()
  }

  // Strip leaked tool-call template text (GLM no-tools side-call failure mode)
  text = stripLeakedToolCallText(text)

  // Collapse 3+ consecutive blank lines → 2
  text = text.replace(/\n{3,}/g, '\n\n')

  return text.trim()
}

/**
 * Postamble for a turn that was INTERRUPTED mid-task (auto/reactive compaction
 * fired before the assistant finished). The model should resume the in-flight
 * task using the verbatim keep-set that follows.
 */
const RESUME_INTERRUPTED_POSTAMBLE = [
  '从中断处继续对话。',
  '直接继续——不要复述或确认这份总结，不要说"我接着来"之类的开场白，也不要重新询问总结里已有的信息。',
  '把上一个任务当作从未中断过一样接着做。',
  '（任务本身需要的问题——例如待批准事项、只能由用户做出的决定——仍然允许提出，不得因为本说明而跳过。）',
].join('\n')

/**
 * Postamble for a turn that was already COMPLETE when compaction ran (manual
 * `/compact` at idle, or any compaction at a clean turn boundary). There is no
 * task to resume: the keep-set that follows is finished work kept only as
 * reference, so the model must NOT redo it and should wait for the next user
 * instruction — while still being able to act on a continuation ("do it",
 * "option 1") using the preserved context.
 */
const COMPLETED_BOUNDARY_POSTAMBLE = [
  '上一个任务已经完成。上面总结的交流——以及本总结之后保留的任何消息——都是已完成的工作，仅作参考上下文保留。',
  '不要重做、不要重新运行其工具、不要重新回答上一个请求，也不要复述或确认这份总结。',
  '等待用户的下一条指令。如果该指令是对上一线程的延续（例如"就这么做"、"方案一"、"继续"），',
  '用保留的上下文去执行；否则按全新任务处理。',
].join('\n')

/**
 * Decide whether the conversation is at a genuine TURN BOUNDARY (previous task
 * finished) versus INTERRUPTED mid-task, from message state rather than the
 * trigger path so the rule is uniform across every compaction call site.
 *
 * Conservative: report "complete" ONLY when the last meaningful message is a
 * clean assistant answer with no pending tool_use. Any other tail (unanswered
 * user text, a tool_result awaiting the assistant, a meta/recovery notice, or
 * an assistant message that still owes a tool_result) is treated as interrupted
 * — mislabelling an in-flight turn as complete would wrongly tell the model to
 * stop and drop a continuation, whereas the reverse is just the legacy "resume"
 * framing we already shipped.
 */
export function isTurnComplete(messages: readonly KernelMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    // Skip structural-only tail entries; they don't change turn ownership.
    if (m.isCompactBoundary || m.content.length === 0) continue
    if (m.role === 'assistant' && !m.isMeta) {
      return !m.content.some(block => block.type === 'tool_use')
    }
    return false
  }
  return false
}

/**
 * Build the compact summary user message text.
 * Mirrors CC's getCompactUserSummaryMessage.
 *
 * @param turnComplete - true when compaction ran at a finished turn boundary
 *   (no task to resume); selects the "await next instruction" postamble instead
 *   of the "resume the last task" one.
 */
export function buildCompactSummaryMessage(
  formattedSummary: string,
  turnComplete = false,
): string {
  return [
    '本会话是从一个因上下文超限而中断的对话继续而来。',
    '下面的总结覆盖了对话的较早部分。',
    '',
    formattedSummary,
    '',
    turnComplete ? COMPLETED_BOUNDARY_POSTAMBLE : RESUME_INTERRUPTED_POSTAMBLE,
  ].join('\n')
}

const FALLBACK_RECENT_MESSAGE_COUNT = 24
const FALLBACK_EXISTING_SUMMARY_COUNT = 2
const FALLBACK_MAX_TOTAL_CHARS = 28_000
const FALLBACK_MAX_MESSAGE_CHARS = 1_800
const FALLBACK_MAX_ANCHOR_CHARS = 3_600
const CONTINUITY_MAX_TOTAL_CHARS = 32_000
const CONTINUITY_MAX_ITEM_CHARS = 1_600
const CONTINUITY_MAX_ANCHOR_CHARS = 4_000
const CONTINUITY_RECENT_USER_COUNT = 10
const CONTINUITY_RECENT_ASSISTANT_COUNT = 8
const CONTINUITY_RECENT_TOOL_RESULT_COUNT = 10
const CONTINUITY_EXISTING_SUMMARY_COUNT = 3
/**
 * When the model summary is already this long (chars), it is treated as
 * "rich" and the bulky verbatim recent-detail anchor sections (recent user /
 * assistant / tool messages) are omitted to avoid duplicating content the
 * summary already covers. The lightweight durable objective anchors and the
 * tool-activity summary are always kept regardless of summary length.
 */
const SUMMARY_RICH_CHAR_THRESHOLD = 2_000
/** Hard budget for caller-supplied (e.g. robotics) deterministic anchors. */
const EXTRA_ANCHOR_MAX_CHARS = 4_000

/**
 * Strip regenerated anchor sections from a PREVIOUS summary before carrying
 * it forward. Anchors (continuity, robotics/agentic state, hardware profile)
 * are regenerated fresh on EVERY compaction from live state — keeping the old
 * copies embedded in carried-forward summaries snowballs duplicates (observed:
 * hardware profile ×3, task-ID lists ×2 in a single post-compact message).
 * Only the narrative part of the old summary is worth carrying.
 */
const REGENERATED_ANCHOR_HEADERS = [
  '## Deterministic Continuity Anchors',
  '## Robotics State Anchors',
  '## Agentic State Anchors',
  '### Persisted Research Reports',
]
export function stripRegeneratedAnchorSections(summaryText: string): string {
  let cut = summaryText.length
  for (const header of REGENERATED_ANCHOR_HEADERS) {
    const idx = summaryText.indexOf(header)
    if (idx >= 0 && idx < cut) cut = idx
  }
  return summaryText.slice(0, cut).trim()
}

export interface ContinuityEnrichOptions {
  /**
   * Caller-supplied deterministic anchor block (e.g. robotics live state:
   * active/completed sub-agent task IDs, phase, hardware safety limits,
   * experience working set). Always appended and protected from truncation so
   * it survives terse summaries and the empty-response fallback path — the
   * exact scenarios where the model-prompt instructions are unreliable.
   */
  extraAnchors?: string
  /**
   * The session's ORIGINAL goal — the first few real user requests (up to
   * ORIGINAL_GOAL_MESSAGE_COUNT, pre-formatted into one string), captured by
   * KernelSession before any compaction ran. The in-window "first explicit
   * user request" anchor degrades after the first compaction (the window then
   * starts at the keep-set's cloned last-user-message); this field restores
   * the true session goal deterministically in every summary path.
   */
  originalUserGoal?: string
  /**
   * Uuids (and clone sourceUuids) of the messages the keep-set preserves
   * VERBATIM outside the summary. The bulky recent-detail anchor sections and
   * the fallback recent-message lists exclude these so the post-compact
   * context never carries the same recent content twice — once clipped inside
   * the summary and once at full fidelity in the keep-set (review F-2). The
   * freed recent-detail quota then covers the middle region the keep-set
   * cannot reach. Cheap one-line objective anchors (first/latest user
   * request) are NOT excluded — they are orientation labels, not content
   * preservation.
   */
  excludeMessageUuids?: ReadonlySet<string>
}

/**
 * Append deterministic continuity anchors to a model-generated compact summary.
 * This protects long engineering sessions from over-compression when a compact
 * model returns an overly terse summary.
 *
 * Anchors are layered so a healthy, comprehensive summary is not bloated:
 *  - Durable objective anchors + tool-activity summary: always appended (cheap).
 *  - Recent verbatim user/assistant/tool detail: appended ONLY when the model
 *    summary is terse (< SUMMARY_RICH_CHAR_THRESHOLD), since a rich summary
 *    already covers that ground.
 *  - extraAnchors (caller deterministic state): always appended, never clipped
 *    away — the model summary is clipped first if the combined text is too long.
 */
export function enrichCompactSummaryWithContinuity(
  modelSummary: string,
  messages: readonly KernelMessage[],
  options: ContinuityEnrichOptions = {},
): string {
  const summary = modelSummary.trim()
  const includeRecentDetail = summary.length < SUMMARY_RICH_CHAR_THRESHOLD
  const generic = buildCompactContinuityAnchors(messages, {
    includeRecentDetail,
    originalUserGoal: options.originalUserGoal,
    excludeMessageUuids: options.excludeMessageUuids,
  })
  const extra = options.extraAnchors
    ? clip(options.extraAnchors.trim(), EXTRA_ANCHOR_MAX_CHARS)
    : ''

  const appended = [extra, generic].filter(Boolean).join('\n\n')
  if (!appended) return summary

  // Protect the appended anchors: if the combined text overflows the ceiling,
  // clip the (regenerable) model summary rather than the deterministic anchors.
  const room = Math.max(0, CONTINUITY_MAX_TOTAL_CHARS - appended.length - 2)
  const summaryClipped = clip(summary, room)
  return summaryClipped ? `${summaryClipped}\n\n${appended}` : appended
}

/**
 * Build a deterministic local summary when the compact side-call returns no
 * text. This is intentionally lossy, but it preserves the durable anchors that
 * keep the session usable and actually shrinks context instead of retrying a
 * broken compact model until the main request hits the blocking limit.
 */
export function buildFallbackCompactSummary(
  messages: readonly KernelMessage[],
  options: ContinuityEnrichOptions = {},
): string {
  const extraAnchors = options.extraAnchors
    ? clip(options.extraAnchors.trim(), EXTRA_ANCHOR_MAX_CHARS)
    : ''
  const existingSummaries = messages
    .filter(message => message.isCompactSummary)
    .slice(-FALLBACK_EXISTING_SUMMARY_COUNT)
    .map(message => clip(
      stripRegeneratedAnchorSections(renderMessageContent(message)),
      FALLBACK_MAX_ANCHOR_CHARS,
    ))
    .filter(Boolean)

  const firstUser = messages.find(isRealUserMessage)
  // Exclude keep-set-covered messages: they survive verbatim after the
  // summary, so repeating them here would duplicate content (F-2).
  const keptElsewhere = (message: KernelMessage): boolean =>
    options.excludeMessageUuids?.has(message.uuid) ?? false
  const recentMessages = messages
    .filter(message => !message.isCompactBoundary && message.content.length > 0)
    .filter(message => !keptElsewhere(message))
    .slice(-FALLBACK_RECENT_MESSAGE_COUNT)

  const used = new Set<string>()
  const recentLines: string[] = []
  for (const message of recentMessages) {
    if (used.has(message.uuid)) continue
    used.add(message.uuid)
    const rendered = renderMessageContent(message)
    if (!rendered) continue
    recentLines.push(`- ${messageLabel(message)}: ${clip(rendered, FALLBACK_MAX_MESSAGE_CHARS)}`)
  }

  const firstUserText = firstUser
    ? clip(renderMessageContent(firstUser), FALLBACK_MAX_ANCHOR_CHARS)
    : 'No explicit user request was available in the retained messages.'

  const continuityAnchors = buildCompactContinuityAnchors(messages, {
    originalUserGoal: options.originalUserGoal,
    excludeMessageUuids: options.excludeMessageUuids,
  })
  const body = [
    'Summary:',
    '## 1. Primary Request and Intent',
    '- Local fallback summary generated because the compact model did not produce a usable high-fidelity summary.',
    ...(options.originalUserGoal
      ? [`- Original session goal (verbatim earliest user messages, captured at session start — may reflect the user's original objective; later explicit user redirections prevail): ${clip(options.originalUserGoal, FALLBACK_MAX_ANCHOR_CHARS)}`]
      : []),
    `- First explicit user request: ${firstUserText}`,
    ...(extraAnchors
      ? ['', '## Deterministic State Anchors (caller-provided)', extraAnchors]
      : []),
    '',
    '## 2. Key Technical Concepts',
    '- Exact technical concepts were not model-summarised. Use the preserved recent messages below and re-read files before relying on code details.',
    '',
    '## 3. Files and Code Sections',
    '- File contents from before compaction are not carried forward by this fallback. Re-read any file before editing or citing exact code.',
    '',
    '## 4. Errors and Fixes',
    '- Compact side-call produced an empty text response. The runtime replaced it with this deterministic fallback so the session can continue.',
    '',
    '## 5. Problem Solving',
    '- Continue from the latest user request and recent tool outputs. Treat older details as incomplete unless repeated in existing compact summaries or recent messages.',
    '',
    '## 6. All User Messages',
    ...renderRecentUserMessages(messages, options.excludeMessageUuids),
    '',
    '## 7. Pending Tasks',
    '- Infer pending work from the most recent user message and recent assistant/tool context below.',
    '',
    '## 8. Current Work',
    ...(
      recentLines.length > 0
        ? recentLines
        : ['- No recent message content was available.']
    ),
    '',
    '## 9. Optional Next Step',
    '- Resume directly from the newest user request. If exact historical data is needed, query the source again rather than relying on this fallback.',
    ...(existingSummaries.length > 0
      ? [
          '',
          '## Existing Compact Summaries',
          ...existingSummaries.map((summary, index) => `### Summary ${index + 1}\n${summary}`),
        ]
      : []),
    ...(continuityAnchors
      ? [
          '',
          continuityAnchors,
        ]
      : []),
  ].join('\n')

  return clip(body, FALLBACK_MAX_TOTAL_CHARS)
}

function buildCompactContinuityAnchors(
  messages: readonly KernelMessage[],
  options: {
    includeRecentDetail?: boolean
    originalUserGoal?: string
    excludeMessageUuids?: ReadonlySet<string>
  } = {},
): string {
  const includeRecentDetail = options.includeRecentDetail ?? true
  const realUsers = messages.filter(isRealUserMessage)
  const firstUser = realUsers[0]
  const latestUser = realUsers[realUsers.length - 1]

  // Messages the keep-set preserves verbatim outside the summary; the bulky
  // recent-detail sections below must not duplicate them (F-2). The recent-*
  // windows then naturally slide back onto the middle region that WILL be
  // folded into the summary — exactly where a terse summary needs backup.
  const keptElsewhere = (message: KernelMessage): boolean =>
    options.excludeMessageUuids?.has(message.uuid) ?? false

  const existingSummaries = messages
    .filter(message => message.isCompactSummary)
    .slice(-CONTINUITY_EXISTING_SUMMARY_COUNT)
    .map(message => clip(
      stripRegeneratedAnchorSections(renderMessageContent(message)),
      CONTINUITY_MAX_ANCHOR_CHARS,
    ))
    .filter(Boolean)

  const recentUsers = realUsers
    .filter(message => !keptElsewhere(message))
    .slice(-CONTINUITY_RECENT_USER_COUNT)
    .map(message => clip(renderMessageContent(message), CONTINUITY_MAX_ITEM_CHARS))
    .filter(Boolean)

  const recentAssistant = messages
    .filter(message => message.role === 'assistant' && !message.isMeta && message.content.length > 0)
    .filter(message => !keptElsewhere(message))
    .slice(-CONTINUITY_RECENT_ASSISTANT_COUNT)
    .map(message => clip(renderMessageContent(message), CONTINUITY_MAX_ITEM_CHARS))
    .filter(Boolean)

  const recentToolResults = messages
    .filter(message => message.sourceToolAssistantUUID || message.content.some(block => block.type === 'tool_result'))
    .filter(message => !keptElsewhere(message))
    .slice(-CONTINUITY_RECENT_TOOL_RESULT_COUNT)
    .map(message => clip(renderMessageContent(message), CONTINUITY_MAX_ITEM_CHARS))
    .filter(Boolean)

  const toolUseCounts = new Map<string, number>()
  let toolResultCount = 0
  let toolResultErrorCount = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        toolUseCounts.set(block.name, (toolUseCounts.get(block.name) ?? 0) + 1)
      } else if (block.type === 'tool_result') {
        toolResultCount++
        if (block.is_error) toolResultErrorCount++
      }
    }
  }

  const toolActivity = [...toolUseCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([name, count]) => `- ${name}: ${count}`)

  const lines = [
    '## Deterministic Continuity Anchors',
    '- These anchors were generated locally to reduce information loss and goal drift after compaction.',
    '- Treat exact file contents and exact command output as stale unless re-read or re-run.',
    '',
    '### Durable Objective Anchors',
    // The original goal is captured pre-compaction by KernelSession. It guards
    // against SUMMARY paraphrase drift (after compaction #1 the in-window
    // "first" user message is merely the cloned keep-set anchor, not the
    // session's actual goal) — but the label deliberately defers to later
    // EXPLICIT user redirections: the anchor must never override a legitimate
    // mid-session goal change by the user.
    ...(options.originalUserGoal
      ? [`- Original session goal (verbatim earliest user messages, captured at session start — they LIKELY reflect the user's original objective. Trust them over any paraphrase in summaries; but if the user later EXPLICITLY changed the goal, the user's later instruction prevails): ${clip(options.originalUserGoal, CONTINUITY_MAX_ANCHOR_CHARS)}`]
      : []),
    // P4: when the window contains a single real user message, first==latest —
    // emit ONE line instead of duplicating the same text twice.
    ...(firstUser && latestUser && firstUser.uuid === latestUser.uuid
      ? [`- Only explicit user request in current window: ${clip(renderMessageContent(firstUser), CONTINUITY_MAX_ANCHOR_CHARS)}`]
      : [
          firstUser
            ? `- First explicit user request in current window: ${clip(renderMessageContent(firstUser), CONTINUITY_MAX_ANCHOR_CHARS)}`
            : '- First explicit user request in current window: unavailable.',
          latestUser
            ? `- Latest explicit user request: ${clip(renderMessageContent(latestUser), CONTINUITY_MAX_ANCHOR_CHARS)}`
            : '- Latest explicit user request: unavailable.',
        ]),
    // Bulky verbatim recent-detail sections are only emitted when the model
    // summary was terse; a rich summary already covers this ground (see
    // SUMMARY_RICH_CHAR_THRESHOLD in enrichCompactSummaryWithContinuity).
    ...(includeRecentDetail
      ? [
          '',
          '### Recent User Requests',
          ...(recentUsers.length > 0 ? recentUsers.map(text => `- ${text}`) : ['- None.']),
          '',
          '### Recent Assistant Progress',
          ...(recentAssistant.length > 0 ? recentAssistant.map(text => `- ${text}`) : ['- None.']),
          '',
          '### Recent Tool Results',
          ...(recentToolResults.length > 0 ? recentToolResults.map(text => `- ${text}`) : ['- None.']),
        ]
      : []),
    '',
    '### Tool Activity Summary',
    ...(toolActivity.length > 0 ? toolActivity : ['- No tool_use blocks retained.']),
    `- tool_result blocks retained in compact input: ${toolResultCount} (${toolResultErrorCount} errors)`,
    ...(existingSummaries.length > 0
      ? [
          '',
          '### Existing Summaries Carried Forward',
          ...existingSummaries.map((summary, index) => `- Summary ${index + 1}: ${summary}`),
        ]
      : []),
  ]

  return clip(lines.join('\n'), CONTINUITY_MAX_TOTAL_CHARS)
}

function isRealUserMessage(message: KernelMessage): boolean {
  return message.role === 'user' &&
    !message.isMeta &&
    !message.isCompactSummary &&
    !message.isCompactBoundary &&
    !message.sourceToolAssistantUUID
}

function renderRecentUserMessages(
  messages: readonly KernelMessage[],
  excludeMessageUuids?: ReadonlySet<string>,
): string[] {
  const userMessages = messages
    .filter(isRealUserMessage)
    .filter(message => !(excludeMessageUuids?.has(message.uuid) ?? false))
    .slice(-8)
    .map(message => `- ${clip(renderMessageContent(message), FALLBACK_MAX_MESSAGE_CHARS)}`)
    .filter(line => line !== '- ')

  return userMessages.length > 0
    ? userMessages
    : ['- No explicit user messages were available in the retained messages.']
}

function messageLabel(message: KernelMessage): string {
  if (message.isCompactSummary) return 'compact_summary'
  if (message.isMeta) return `${message.role}_meta`
  if (message.sourceToolAssistantUUID) return 'tool_result'
  return message.role
}

function renderMessageContent(message: KernelMessage): string {
  return message.content
    .map(renderContentBlock)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function renderContentBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return stripVolatileContextPrefix(block.text)
    case 'tool_use':
      return `[tool_use ${block.name}] ${stringifyCompact(block.input)}`
    case 'tool_result':
      return `[tool_result ${block.tool_use_id}${block.is_error ? ' error' : ''}] ${renderToolResultContent(block.content)}`
    case 'image':
      return '[image omitted]'
    case 'thinking':
    case 'redacted_thinking':
      return ''
    default:
      return `[${String((block as { type?: unknown }).type ?? 'unknown')} omitted]`
  }
}

function renderToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (!item || typeof item !== 'object') return ''
        const maybeBlock = item as Partial<ContentBlock>
        return maybeBlock.type ? renderContentBlock(maybeBlock as ContentBlock) : ''
      })
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return String(value)
  }
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 20) return text.slice(0, maxChars)
  return `${text.slice(0, maxChars - 20)}... [truncated]`
}
