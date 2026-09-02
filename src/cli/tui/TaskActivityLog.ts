/**
 * Read model/tool activity from one managed worker's append-only NDJSON log.
 *
 * The worker stays detached from the TUI so it can survive `q`. Consequently
 * this reader tails the file instead of attaching a stdout pipe to the child.
 * Only the selected task is read, and only a bounded suffix, so a long-running
 * task cannot make the once-per-second repaint progressively more expensive.
 */
import { open } from 'node:fs/promises'
import { sanitizeTerminalPreview, sanitizeTerminalText } from '../terminalSanitizer.js'

export type TaskActivityKind =
  | 'agent'
  | 'thinking'
  | 'tool'
  | 'tool-result'
  | 'warning'
  | 'error'
  | 'status'
  | 'report'

export interface TaskActivityEntry {
  kind: TaskActivityKind
  text: string
}

/**
 * What the task CONCLUDED, lifted out of the stream.
 *
 * The closing report was already in this log and the reader threw it away:
 * `resultSummary()` renders the `result` event as turns/duration/cost and never
 * touched `resultText`, which is the agent's own final message (KernelLoop sets
 * `resultText = assistantText` on the ordinary completion path). What survived
 * on screen was only the `text` deltas that fed the same message — folded in
 * with every tool call that happened to follow, split wherever a tool
 * interrupted them, and tail-clipped at MAX_AGENT_CHARS. The most valuable
 * moment in a task's life read as "the last thing that scrolled by".
 *
 * Kept as structured data rather than another entry so the full-screen report
 * view can render it whole, while the inline activity panel still gets a
 * bounded one-entry preview.
 *
 * `diagnosis` matters for the other half of the problem: when a run ends
 * abnormally, `resultText` is a canned "Stopped: …" line and the real
 * explanation is the runtime's `termination_analysis`. A report view that shows
 * one without the other is misleading in exactly the cases that need it most.
 */
export interface TaskReport {
  /** The agent's own closing message. */
  text?: string
  /** LLM termination diagnosis, emitted only for an abnormal ending. */
  diagnosis?: string
  subtype?: string
  stopReason?: string
  numTurns?: number
  durationMs?: number
  totalCostUsd?: number
  isError?: boolean
  /** True when `text` was clipped at MAX_REPORT_CHARS. */
  clipped?: boolean
}

export interface TaskActivityFeed {
  entries: TaskActivityEntry[]
  /** True when the beginning of the log was intentionally omitted. */
  truncated: boolean
  error?: string
  /**
   * The most recent completion report in this log, when the turn produced one.
   * Latest-wins: a log may hold several turns and only the last one is current.
   */
  report?: TaskReport
}

/**
 * Bracketed prefixes this runtime writes to stdout/stderr as plain text rather
 * than as NDJSON events (`[sandbox] …`, `[meta-agent/sandbox:<id>] …`). Matching
 * on our OWN prefixes keeps the classification a fact rather than a heuristic
 * about arbitrary child output.
 */
const RUNTIME_NOTICE_PREFIX = /^\[(?:sandbox\]|meta-agent[/\]:])/

const DEFAULT_TAIL_BYTES = 128 * 1024
const MAX_ENTRIES = 120
const MAX_AGENT_CHARS = 4_000
/**
 * Cap on the retained report text. Generous because this is the ONE thing the
 * operator opened the view to read, and head-clipped rather than tail-clipped:
 * a report leads with its conclusion, so the front is the half worth keeping.
 */
const MAX_REPORT_CHARS = 20_000
/** The inline stream gets a preview; the report view gets the whole thing. */
const MAX_REPORT_PREVIEW_CHARS = 700

export async function readTaskActivityLog(
  logPath: string,
  tailBytes = DEFAULT_TAIL_BYTES,
): Promise<TaskActivityFeed> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(logPath, 'r')
    const size = (await file.stat()).size
    const bounded = Math.max(1_024, Math.floor(tailBytes))
    const start = Math.max(0, size - bounded)
    const buffer = Buffer.alloc(Math.max(0, size - start))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
    let raw = buffer.subarray(0, bytesRead).toString('utf8')
    // Starting in the middle of a UTF-8 character or JSON line is expected for
    // a bounded tail. Drop that one partial line; every subsequent line is an
    // independently parseable event.
    if (start > 0) {
      const newline = raw.indexOf('\n')
      raw = newline >= 0 ? raw.slice(newline + 1) : ''
    }
    raw = withoutPartialTrailingEvent(raw)
    return parseTaskActivityLog(raw, start > 0)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    // The path is published just before spawn. A first repaint can beat file
    // creation by a few milliseconds; render that as "waiting", not an error.
    if (code === 'ENOENT') return { entries: [], truncated: false }
    return {
      entries: [],
      truncated: false,
      error: sanitizeTerminalPreview(error instanceof Error ? error.message : String(error), 300),
    }
  } finally {
    await file?.close().catch(() => undefined)
  }
}

function withoutPartialTrailingEvent(raw: string): string {
  if (!raw || raw.endsWith('\n')) return raw
  const lastBreak = raw.lastIndexOf('\n')
  const finalLine = raw.slice(lastBreak + 1)
  try {
    JSON.parse(finalLine)
    return raw
  } catch {
    return lastBreak >= 0 ? raw.slice(0, lastBreak + 1) : ''
  }
}

/** Pure parser exported for event-format and terminal-safety tests. */
export function parseTaskActivityLog(raw: string, truncated = false): TaskActivityFeed {
  const entries: TaskActivityEntry[] = []
  let agentText = ''
  let report: TaskReport | undefined

  const flushAgent = (): void => {
    if (!agentText) return
    const cleaned = clean(agentText)
    agentText = ''
    if (cleaned) entries.push({ kind: 'agent', text: tailClip(cleaned, MAX_AGENT_CHARS) })
  }
  const push = (kind: TaskActivityKind, value: unknown, max = 500): void => {
    flushAgent()
    const text = sanitizeTerminalPreview(value, max)
    if (text) entries.push({ kind, text })
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an event')
      event = parsed as Record<string, unknown>
    } catch {
      // Not an NDJSON event. The worker is spawned with
      // `stdio: ['ignore', logFd, logFd]`, so this file is a MIXED stream: the
      // kernel's event log plus whatever the child wrote to stdout/stderr
      // directly. A raw line therefore carries no evidence of severity, and
      // classifying every one as `error` painted the TUI red for two entirely
      // normal notices — `[meta-agent/sandbox:…] sandbox active — …` on every
      // sub-agent start, and `[sandbox] credential-deny-lifted: …` on every
      // session start. Red that appears when nothing is wrong stops meaning
      // anything.
      //
      // Runtime notices are recognised by their own bracketed prefix (we own
      // those strings, so this is not a guess about foreign output) and shown
      // as status. Everything else stays visible as a warning rather than
      // silently blending in — an unparsed line could still be a stack trace.
      push(RUNTIME_NOTICE_PREFIX.test(line) ? 'status' : 'warning', line, 500)
      continue
    }

    switch (event['type']) {
      case 'text':
        agentText += typeof event['text'] === 'string' ? event['text'] : ''
        break
      case 'thinking_delta':
        flushAgent()
        // Thousands of reasoning deltas should occupy one quiet status row.
        if (entries.at(-1)?.kind !== 'thinking') {
          entries.push({ kind: 'thinking', text: '思考中…' })
        }
        break
      case 'tool_use': {
        const name = typeof event['toolName'] === 'string' ? event['toolName'] : 'tool'
        push('tool', `${name} ${jsonPreview(event['toolInput'])}`, 500)
        break
      }
      case 'tool_result':
        push(event['isError'] === true ? 'error' : 'tool-result', event['content'], 600)
        break
      case 'api_retry':
        push(
          'warning',
          `API 重试 ${numberText(event['attempt'])}/${numberText(event['maxRetries'])}` +
            `，${numberText(event['retryDelayMs'])}ms 后继续`,
        )
        break
      case 'system_message':
        push(event['subtype'] === 'warning' ? 'warning' : 'status', event['text'])
        break
      case 'compact_start':
        push('status', '会话压缩中…')
        break
      case 'compact_boundary':
        push(
          'status',
          `压缩完成 ${tokenText(event['previousTokens'])} → ${tokenText(event['summaryTokens'])}`,
        )
        break
      case 'compact_failed':
        push('warning', `会话压缩失败：${String(event['error'] ?? 'unknown error')}`)
        break
      case 'result': {
        // The stats line stays — it answers "how much did this cost me" at a
        // glance, which the prose does not.
        push(event['isError'] === true ? 'error' : 'status', resultSummary(event), 700)
        const closing = headClip(cleanMultiline(event['resultText']), MAX_REPORT_CHARS)
        report = {
          ...report,
          ...reportFacts(event),
          ...(closing.text ? { text: closing.text, clipped: closing.clipped } : {}),
        }
        if (closing.text) push('report', closing.text, MAX_REPORT_PREVIEW_CHARS)
        break
      }
      case 'termination_analysis': {
        const diagnosis = headClip(cleanMultiline(event['analysis']), MAX_REPORT_CHARS).text
        if (diagnosis) {
          report = { ...report, diagnosis }
          push('report', `终态诊断：${diagnosis}`, MAX_REPORT_PREVIEW_CHARS)
        }
        break
      }
      case 'auto_scheduler':
        push('status', event['message'])
        break
      case 'auto_scheduler_expired':
        push('warning', '检测到已过期、未执行的 Auto 唤醒')
        break
      // stream_event is provider-level noise; the useful model delta is already
      // represented by `text` / `thinking_delta` above.
      case 'stream_event':
        break
      default:
        // Forward-compatible: a new structured event should be visible until a
        // tailored formatter is added, rather than disappearing silently.
        push('status', jsonPreview(event), 500)
        break
    }
  }
  flushAgent()

  return {
    entries: entries.slice(-MAX_ENTRIES),
    truncated,
    ...(report ? { report } : {}),
  }
}

/** The measurable half of a result event, for the report header. */
function reportFacts(event: Record<string, unknown>): Partial<TaskReport> {
  const num = (key: string): number | undefined =>
    typeof event[key] === 'number' ? event[key] as number : undefined
  const str = (key: string): string | undefined =>
    typeof event[key] === 'string' && event[key] ? event[key] as string : undefined
  return {
    ...(str('subtype') ? { subtype: str('subtype')! } : {}),
    ...(str('stopReason') ? { stopReason: str('stopReason')! } : {}),
    ...(num('numTurns') !== undefined ? { numTurns: num('numTurns')! } : {}),
    ...(num('durationMs') !== undefined ? { durationMs: num('durationMs')! } : {}),
    ...(num('totalCostUsd') !== undefined ? { totalCostUsd: num('totalCostUsd')! } : {}),
    ...(event['isError'] === true ? { isError: true } : {}),
  }
}

/**
 * Sanitize while KEEPING line structure.
 *
 * `sanitizeTerminalPreview` collapses all whitespace, which is right for a
 * one-line stream entry and wrong for a report: paragraphs, lists and indented
 * blocks are how a report is readable at all. Control sequences are still
 * stripped — this text came from a model.
 */
function cleanMultiline(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  return sanitizeTerminalText(value)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Keep the FRONT — a report states its conclusion first. */
function headClip(text: string, max: number): { text: string; clipped?: boolean } {
  if (text.length <= max) return { text }
  return { text: `${text.slice(0, max)}\n\n[报告过长，已截断]`, clipped: true }
}

function resultSummary(event: Record<string, unknown>): string {
  const subtype = typeof event['subtype'] === 'string' ? event['subtype'] : 'unknown'
  const label = subtype === 'success'
    ? '本轮完成'
    : subtype === 'parked'
      ? '任务已停放'
      : `本轮结束：${subtype}`
  const facts = [
    typeof event['numTurns'] === 'number' ? `${event['numTurns']} turns` : '',
    typeof event['durationMs'] === 'number' ? duration(event['durationMs']) : '',
    typeof event['totalCostUsd'] === 'number' ? `$${event['totalCostUsd'].toFixed(4)}` : '',
    typeof event['stopReason'] === 'string' && event['stopReason'] ? event['stopReason'] : '',
  ].filter(Boolean)
  const reason = subtype === 'parked' && isRecord(event['parkRequest']) &&
    typeof event['parkRequest']['reason'] === 'string'
    ? ` · ${event['parkRequest']['reason']}`
    : ''
  return `${label}${facts.length ? ` · ${facts.join(' · ')}` : ''}${reason}`
}

function jsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value ?? '')
  } catch {
    return String(value ?? '')
  }
}

function clean(value: unknown): string {
  return sanitizeTerminalText(value).replace(/\s+/g, ' ').trim()
}

function tailClip(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-(max - 1))}`
}

function numberText(value: unknown): string {
  return typeof value === 'number' ? String(value) : '?'
}

function tokenText(value: unknown): string {
  return typeof value === 'number' ? `${(value / 1_000).toFixed(1)}k` : '?'
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
