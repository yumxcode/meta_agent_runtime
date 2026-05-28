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
