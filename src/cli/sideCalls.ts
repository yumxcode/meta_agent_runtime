/**
 * cli/sideCalls — short flash-model calls the CLI makes on its own behalf:
 * distilling an experience summary, diagnosing an abnormal auto-run
 * termination, and naming a session for the resume picker.
 *
 * These are presentation concerns, not part of the agent loop, which is why
 * they live outside the session machinery. Each one is best-effort: a failure
 * degrades the UI, never the run.
 *
 * Extracted from cli/index.ts.
 */
import { SessionRouter } from '../routing/SessionRouter.js'
import { SessionStore, type SessionMeta } from '../core/SessionStore.js'
import type { ConversationMessage } from '../core/types.js'
import { sanitizeTerminalText } from './terminalSanitizer.js'
import { getModelProtocol } from '../providers/registry.js'
import { renderPromptContent, sessionPromptPreview } from './transcript.js'
import { dim, bold, cyan, gray, green, red, yellow, safeStdoutWrite, terminalText } from './term.js'
import { terminationLabel } from './termination.js'

// ── Experience summary side-call ──────────────────────────────────────────────
//
// Calls the LLM in a completely isolated session (no tools, no history) to
// summarise newly proposed experience entries and guide the user toward review.
//
// This mirrors the compact side-call pattern: a fresh Anthropic client,
// client.messages.stream() with the summary task as system prompt, nothing
// written into the main session's message history.

const EXPERIENCE_SUMMARY_SYSTEM = `你是一个精炼知识的助理。
用户的 AI agent 刚刚在本轮任务中提议了若干条新的"经验条目"，尚未提交到共享知识库，需要人工审核。
你的任务：
1. 简洁地概括这些经验的核心价值与适用场景（每条一两句）
2. 判断哪些条目结论足够明确、值得提交，哪些可能还不成熟
3. 提醒用户运行 /experience review 进行逐条审核，自行决定是否提交
不要重复原始数据，只做价值判断和行动引导。回复保持简短（100-200字）。`

/**
 * Fire a one-shot LLM call to explain newly proposed experience entries.
 * Uses the same provider/apiKey as the main session but a completely separate
 * Anthropic client instance — the response is streamed to stdout only and
 * NEVER appended to the main session's message history.
 *
 * Falls back silently if no client is available or the call fails.
 */
export async function streamExperienceSummary(
  router: SessionRouter,
  entries: Array<{ pendingId: string; input: Record<string, unknown> }>,
): Promise<void> {
  // Entire function is wrapped in a single try/catch so NO exception — including
  // those from getSideCallClient(), getProviderConfig(), dynamic import, or
  // entries.map() — can escape to the caller and become an unhandled rejection
  // that kills the process.
  try {
    // Build a concise JSON summary of the entries for the LLM
    const entrySummaries = entries.map((e, i) => {
      const inp = e.input
      return {
        index:   i + 1,
        title:   inp['title']   ?? '(untitled)',
        domain:  inp['domain']  ?? 'general',
        success: inp['success'] ?? true,
        problem: String(inp['problem'] ?? '').slice(0, 200),
        solution: String(inp['solution'] ?? '').slice(0, 200),
      }
    })

    const userMessage = `新提议的经验条目（共 ${entries.length} 条）：\n\n` +
      JSON.stringify(entrySummaries, null, 2)

    const { apiKey, baseURL, flashModel } = router.getProviderConfig()
    if (!apiKey) return

    if (getModelProtocol(flashModel, baseURL) === 'openai') {
      const OpenAI = (await import('openai')).default
      const client = new OpenAI({ apiKey, baseURL: baseURL ?? 'https://api.deepseek.com', maxRetries: 1, timeout: 30_000 })
      const stream = await client.chat.completions.create({
        model:      flashModel,
        max_tokens: 512,
        stream:     true,
        messages: [
          { role: 'system', content: EXPERIENCE_SUMMARY_SYSTEM },
          { role: 'user', content: userMessage },
        ],
      })

      let summaryText = ''
      for await (const chunk of stream) {
        summaryText += chunk.choices[0]?.delta?.content ?? ''
      }
      const safeSummaryText = terminalText(summaryText)
      if (safeSummaryText.trim()) {
        process.stdout.write(`\n${dim('─── 经验提议摘要 (side-call) ───────────────────────────────────')}\n`)
        process.stdout.write(safeSummaryText)
        process.stdout.write(`\n${dim('─────────────────────────────────────────────────────────────')}\n\n`)
      }
      return
    }

    // Prefer the existing side-call client (already has correct timeout/retries).
    // Fall back to building our own from the provider config.
    let client = router.getSideCallClient()
    if (!client) {
      client = new (await import('@anthropic-ai/sdk')).default({
        apiKey,
        baseURL,
        timeout:    30_000,
        maxRetries: 1,
      })
    }

    const stream = await client.messages.stream({
      model:      flashModel,
      max_tokens: 512,
      system:     EXPERIENCE_SUMMARY_SYSTEM,
      messages:   [{ role: 'user', content: userMessage }],
    })

    // Buffer output first — only print header/footer if there is actual content.
    let summaryText = ''
    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        summaryText += event.delta.text
      }
    }
    const safeSummaryText = terminalText(summaryText)
    if (safeSummaryText.trim()) {
      process.stdout.write(`\n${dim('─── 经验提议摘要 (side-call) ───────────────────────────────────')}\n`)
      process.stdout.write(safeSummaryText)
      process.stdout.write(`\n${dim('─────────────────────────────────────────────────────────────')}\n\n`)
    }
  } catch { /* best-effort — side-call failure must NEVER crash the REPL */ }
}

// ── Abnormal-termination diagnosis (flash side-call) ─────────────────────────
//
// When an unattended (auto-series) run ends in a NON-success terminal state
// (max_turns / budget / verify-exhausted / no-progress / runtime error), a bare
// reason code like "max turns" is useless to the operator — especially when the
// CLI is driven programmatically and nobody is watching the stream. We fire one
// isolated LLM call to turn the goal + termination reason + the agent's recent
// activity into a concrete "what happened / root cause / what's needed next"
// diagnosis. Same isolation as streamExperienceSummary: separate client, never
// touches the main session history, fully best-effort (returns null on any
// failure so the caller can fall back to the raw reason).

const TERMINATION_DIAGNOSIS_SYSTEM = `你是一个自主 Agent 运行的"终态诊断助手"。一次无人值守(auto)运行异常结束了。请基于【原始目标】【终止原因】【Agent 最近输出与工具轨迹】，给出简洁、可执行的诊断，而不是复述错误码。

用中文输出三段，每段 1-3 句：
1. 发生了什么：一句话说清实际卡点（不是错误码字面意思）。
2. 根因：为什么这样结束——方法在死循环、缺少外部输入(凭证/账号/权限/网络)、任务过大超步数、verify 未通过，还是真的失败。
3. 下一步：给用户最小可行动作（需要提供什么、或如何调整指令/参数重跑）。

具体、克制，不要空话，不要复述本提示或原始数据。总长控制在 200 字以内。`

/**
 * Human-readable label for a non-success result subtype.
 *
 * @deprecated Superseded by `terminationLabel` in ./termination.js, which also
 * takes `stopReason`. Subtype alone cannot distinguish the ten reasons
 * KernelSession folds into `error_during_execution`, so this could only ever
 * return the "可能是…或…" hedge below. Kept as a thin shim for external callers.
 */
export function terminationReasonLabel(subtype: string): string {
  return terminationLabel({ subtype })
}

/**
 * Run a one-shot LLM diagnosis of an abnormal termination. Returns the analysis
 * text, or null if no client is available / the call fails. Prints nothing — the
 * caller decides how to surface it (text block vs JSON event).
 */
export async function analyzeAbnormalTermination(
  router: SessionRouter,
  opts: {
    goal: string
    subtype: string
    /**
     * Precise `LoopTerminationReason`. The subtype alone folds ten reasons into
     * `error_during_execution`, so without this the prompt asked the model to
     * guess between "无进展死循环 / verify 未通过 / 被外部依赖阻塞 / 运行时错误"
     * — a distinction the runtime had already made and then discarded.
     */
    stopReason?: string | null
    recentText: string
    toolTrail: string[]
  },
): Promise<string | null> {
  try {
    const { apiKey, baseURL, flashModel } = router.getProviderConfig()
    if (!apiKey) return null

    const trail = opts.toolTrail.length ? opts.toolTrail.slice(-30).join('\n') : '（无）'
    const recent = opts.recentText.trim() ? opts.recentText.slice(-4000) : '（无可见输出）'
    const userMessage =
      `【原始目标】\n${opts.goal.slice(0, 2000)}\n\n` +
      `【终止原因】\n${terminationLabel({ subtype: opts.subtype, stopReason: opts.stopReason })}\n\n` +
      `【Agent 最近输出（截断）】\n${recent}\n\n` +
      `【最近工具调用轨迹（截断）】\n${trail}`

    let text = ''
    if (getModelProtocol(flashModel, baseURL) === 'openai') {
      const OpenAI = (await import('openai')).default
      const client = new OpenAI({ apiKey, baseURL: baseURL ?? 'https://api.deepseek.com', maxRetries: 1, timeout: 30_000 })
      const res = await client.chat.completions.create({
        model: flashModel,
        max_tokens: 600,
        messages: [
          { role: 'system', content: TERMINATION_DIAGNOSIS_SYSTEM },
          { role: 'user', content: userMessage },
        ],
      })
      text = res.choices[0]?.message?.content ?? ''
    } else {
      let client = router.getSideCallClient()
      if (!client) {
        client = new (await import('@anthropic-ai/sdk')).default({ apiKey, baseURL, timeout: 30_000, maxRetries: 1 })
      }
      const res = await client.messages.create({
        model: flashModel,
        max_tokens: 600,
        system: TERMINATION_DIAGNOSIS_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
      })
      text = res.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    }
    const safe = terminalText(text).trim()
    return safe || null
  } catch {
    return null // best-effort — diagnosis failure must NEVER crash the run
  }
}

// ── Session title generation (flash side-call) ───────────────────────────────
//
// The session picker previously showed the raw first user prompt (often a long
// rambling sentence). A flash side-call distills the session into a ≤16-char
// title after the first turn, refreshed every 40 messages as the task evolves.
// Same isolation pattern as streamExperienceSummary: separate client, nothing
// enters the main session history; failures are silently ignored.

const SESSION_TITLE_SYSTEM = `你是会话标题生成器。根据给出的工程会话内容，输出一个简短中文标题，概括这个会话的**任务目标**——用户最终想达成什么，而不是聊天话题或第一句话的复述。
要求：不超过 16 个字；优先"对象+目标"结构（如"双足步态对称性优化"、"机械臂抓取成功率提升"）；
只输出标题本身——不要引号、书名号、句号、解释或任何前后缀。`

function sanitizeSessionTitle(raw: string): string | null {
  const firstLine = raw.split('\n').map(l => l.trim()).find(Boolean) ?? ''
  const stripped = firstLine
    .replace(/^["'《【「『\s]+|["'》】」』。．.\s]+$/g, '')
    .replace(/\s+/g, ' ')
  if (!stripped) return null
  return sanitizeTerminalText(stripped.slice(0, 32))
}

/**
 * Deterministic fallback when the flash side-call fails: take the first real
 * user message and cut it at the first sentence boundary (then clause
 * boundary), clamped to 20 chars. Guarantees every session gets SOME concise
 * title even with no flash model available.
 */
export function fallbackSessionTitle(messages: readonly ConversationMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== 'user') continue
    const text = renderPromptContent(m.content)
    if (!text || text.startsWith('[Local resume summary]') || text.startsWith('[tool_')) continue
    let candidate = text.split(/[。！？!?\n]/)[0] ?? ''
    if (candidate.length > 20) candidate = candidate.split(/[，,；;：:]/)[0] ?? candidate
    candidate = candidate.replace(/\s+/g, ' ').trim().slice(0, 20)
    return candidate ? sanitizeTerminalText(candidate) : null
  }
  return null
}

export async function generateSessionTitle(router: SessionRouter): Promise<string | null> {
  try {
    const messages = router.getMessages()
    const userTexts: string[] = []
    let lastAssistant = ''
    for (const m of messages) {
      const text = renderPromptContent(m.content)
      if (!text || text.startsWith('[Local resume summary]') || text.startsWith('[tool_')) continue
      if (m.role === 'user') userTexts.push(text)
      else if (m.role === 'assistant') lastAssistant = text
    }
    if (userTexts.length === 0) return null

    const input = [
      `首条用户消息：${userTexts[0]!.slice(0, 300)}`,
      ...(userTexts.length > 1
        ? [`最近用户消息：${userTexts.slice(-3).map(t => t.slice(0, 150)).join(' / ')}`]
        : []),
      ...(lastAssistant ? [`最近助手回复（摘）：${lastAssistant.slice(0, 200)}`] : []),
    ].join('\n')

    const { apiKey, baseURL, flashModel } = router.getProviderConfig()
    if (!apiKey) return null

    if (getModelProtocol(flashModel, baseURL) === 'openai') {
      const OpenAI = (await import('openai')).default
      const client = new OpenAI({ apiKey, baseURL: baseURL ?? 'https://api.deepseek.com', maxRetries: 1, timeout: 30_000 })
      const response = await client.chat.completions.create({
        model: flashModel,
        max_tokens: 48,
        messages: [
          { role: 'system', content: SESSION_TITLE_SYSTEM },
          { role: 'user', content: input },
        ],
      })
      return sanitizeSessionTitle(response.choices[0]?.message?.content ?? '')
    }

    let client = router.getSideCallClient()
    if (!client) {
      client = new (await import('@anthropic-ai/sdk')).default({ apiKey, baseURL, timeout: 30_000, maxRetries: 1 })
    }
    const response = await client.messages.create({
      model: flashModel,
      max_tokens: 48,
      system: SESSION_TITLE_SYSTEM,
      messages: [{ role: 'user', content: input }],
    })
    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text).join('')
    return sanitizeSessionTitle(text)
  } catch {
    return null   // best-effort — title generation must never disturb the REPL
  }
}
