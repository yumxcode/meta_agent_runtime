import type { KernelMessage, ContentBlock } from '../types/KernelMessage.js'

/**
 * CompactPrompt — the 9-section summarisation prompt.
 * Mirrors CC's prompt.ts exactly, including the ## Compact Instructions injection.
 */

const NO_TOOLS_PREAMBLE =
  'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. ' +
  'Any tool call in your response will cause an error.'

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary will become the context for continuing the work.`

const DETAILED_ANALYSIS_INSTRUCTION = `
Before writing the summary, wrap your reasoning in <analysis> tags. This is your private thinking space — it will NOT appear in the final context. Use it to:
- Review what was accomplished and what remains
- Identify all open threads, errors, and decisions
- Note any critical information that must be preserved
- Plan what to include in each section

Then write the summary inside <summary> tags.`

const SECTION_INSTRUCTIONS = `
The summary MUST include these sections (use markdown headers):

## 1. Primary Request and Intent
Describe the user's main goal and any sub-goals. Be specific and complete.

## 2. Key Technical Concepts
List all important technical concepts, frameworks, tools, patterns, and terminology used. Include version numbers where relevant.

## 3. Files and Code Sections
List every file that was read, written, or discussed. For each:
- Full path
- What was done (read/created/modified/discussed)
- Key content or changes (be specific — include function names, variable names, important values)

## 4. Errors and Fixes
Document every error encountered and how it was (or wasn't) resolved. Include:
- The exact error message or description
- Root cause (if identified)
- Fix applied (if any)
- Current status

## 5. Problem Solving
Describe the approaches taken to solve problems. Include:
- What was tried and why
- What worked and what didn't
- Key decisions made

## 6. All User Messages
List EVERY message from the user verbatim or near-verbatim. Do not paraphrase user intent.

## 7. Pending Tasks
List everything that was explicitly requested but not yet completed. Be exhaustive.

## 8. Current Work
Describe in detail what was being worked on at the time the conversation was compacted:
- The specific task in progress
- Current state (partial implementation, error state, etc.)
- Any relevant code that was in the process of being written

## 9. Optional Next Step
If the conversation was clearly heading in a specific direction, describe the single most important next action.`

const VOLATILE_CONTEXT_INSTRUCTION = `
Volatile context blocks:
- User messages may begin with a <context>...</context> block followed by "---".
- Treat that block as ephemeral runtime state, not as a user request.
- Preserve only durable facts that are necessary to continue the task; do not copy full memory indexes, experience manifests, notifications, or progress dashboards into the summary.`

const NO_TOOLS_TRAILER =
  'REMINDER: Do NOT call any tools. Respond with TEXT ONLY. ' +
  'Your response must contain only the summary content.'

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
 */
export function buildCompactPrompt(customInstructions?: string): string {
  const parts = [
    NO_TOOLS_PREAMBLE,
    '',
    BASE_COMPACT_PROMPT,
    DETAILED_ANALYSIS_INSTRUCTION,
    SECTION_INSTRUCTIONS,
    VOLATILE_CONTEXT_INSTRUCTION,
  ]

  if (customInstructions) {
    parts.push('', '## Additional Instructions', customInstructions)
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

  // Collapse 3+ consecutive blank lines → 2
  text = text.replace(/\n{3,}/g, '\n\n')

  return text.trim()
}

/**
 * Build the compact summary user message text.
 * Mirrors CC's getCompactUserSummaryMessage.
 */
export function buildCompactSummaryMessage(formattedSummary: string): string {
  return [
    'This session is being continued from a previous conversation that ran out of context.',
    'The summary below covers the earlier portion of the conversation.',
    '',
    formattedSummary,
    '',
    'Continue the conversation from where it left off without asking the user any further questions.',
    'Resume directly — do not acknowledge the summary, do not recap what was happening,',
    'do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.',
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

export interface ContinuityEnrichOptions {
  /**
   * Caller-supplied deterministic anchor block (e.g. robotics live state:
   * active/completed sub-agent task IDs, phase, hardware safety limits,
   * experience working set). Always appended and protected from truncation so
   * it survives terse summaries and the empty-response fallback path — the
   * exact scenarios where the model-prompt instructions are unreliable.
   */
  extraAnchors?: string
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
  const generic = buildCompactContinuityAnchors(messages, { includeRecentDetail })
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
    .map(message => clip(renderMessageContent(message), FALLBACK_MAX_ANCHOR_CHARS))
    .filter(Boolean)

  const firstUser = messages.find(isRealUserMessage)
  const recentMessages = messages
    .filter(message => !message.isCompactBoundary && message.content.length > 0)
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

  const continuityAnchors = buildCompactContinuityAnchors(messages)
  const body = [
    'Summary:',
    '## 1. Primary Request and Intent',
    '- Local fallback summary generated because the compact model did not produce a usable high-fidelity summary.',
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
    ...renderRecentUserMessages(messages),
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
  options: { includeRecentDetail?: boolean } = {},
): string {
  const includeRecentDetail = options.includeRecentDetail ?? true
  const realUsers = messages.filter(isRealUserMessage)
  const firstUser = realUsers[0]
  const latestUser = realUsers[realUsers.length - 1]

  const existingSummaries = messages
    .filter(message => message.isCompactSummary)
    .slice(-CONTINUITY_EXISTING_SUMMARY_COUNT)
    .map(message => clip(renderMessageContent(message), CONTINUITY_MAX_ANCHOR_CHARS))
    .filter(Boolean)

  const recentUsers = realUsers
    .slice(-CONTINUITY_RECENT_USER_COUNT)
    .map(message => clip(renderMessageContent(message), CONTINUITY_MAX_ITEM_CHARS))
    .filter(Boolean)

  const recentAssistant = messages
    .filter(message => message.role === 'assistant' && !message.isMeta && message.content.length > 0)
    .slice(-CONTINUITY_RECENT_ASSISTANT_COUNT)
    .map(message => clip(renderMessageContent(message), CONTINUITY_MAX_ITEM_CHARS))
    .filter(Boolean)

  const recentToolResults = messages
    .filter(message => message.sourceToolAssistantUUID || message.content.some(block => block.type === 'tool_result'))
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
    firstUser
      ? `- First explicit user request: ${clip(renderMessageContent(firstUser), CONTINUITY_MAX_ANCHOR_CHARS)}`
      : '- First explicit user request: unavailable.',
    latestUser
      ? `- Latest explicit user request: ${clip(renderMessageContent(latestUser), CONTINUITY_MAX_ANCHOR_CHARS)}`
      : '- Latest explicit user request: unavailable.',
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

function renderRecentUserMessages(messages: readonly KernelMessage[]): string[] {
  const userMessages = messages
    .filter(isRealUserMessage)
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

function stripVolatileContextPrefix(text: string): string {
  if (!text.startsWith('<context>')) return text
  const end = text.indexOf('</context>')
  if (end < 0) return text
  const rest = text.slice(end + '</context>'.length)
  return rest.replace(/^\s*---\s*/, '').trimStart()
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 20) return text.slice(0, maxChars)
  return `${text.slice(0, maxChars - 20)}... [truncated]`
}
