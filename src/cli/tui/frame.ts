/**
 * frame — the task view, rendered as an array of lines.
 *
 * Pure: state in, lines out. All terminal I/O (alternate screen, raw mode,
 * polling) lives in TaskTui; everything about what the operator actually SEES
 * is here, where it can be asserted in a test without a tty.
 *
 * The layout has one job it must never fail at: an unhealthy task is visible
 * without scrolling. Hence unhealthy-first ordering upstream, a count in the
 * header, and colour reserved for status.
 */
import { basename } from 'node:path'
import { bold, cyan, dim, gray, green, red, yellow } from '../term.js'
import { sanitizeTerminalText } from '../terminalSanitizer.js'
import { isUnhealthy, summarize, type TaskStatus, type TaskView } from '../../core/auto/TaskRegistry.js'

/** Transient input the TUI is collecting, if any. */
export type FrameMode =
  | { kind: 'browse' }
  | { kind: 'filter'; query: string }
  | { kind: 'steer'; text: string }
  | { kind: 'confirm'; prompt: string }

export interface FrameInput {
  tasks: readonly TaskView[]
  /** Index into `tasks`; callers clamp before calling. */
  selected: number
  mode: FrameMode
  showFinished: boolean
  /** Result of the last action, shown until the next one. */
  status?: { text: string; ok: boolean }
  now: number
  rows: number
  columns: number
  /** Set while a refresh is in flight, so a slow scan is visible. */
  refreshing?: boolean
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: 'running',
  parked: 'parked',
  overdue: 'OVERDUE',
  'stale-claim': 'STALE-CLAIM',
  orphaned: 'ORPHANED',
  finished: 'finished',
}

function paint(status: TaskStatus, text: string): string {
  switch (status) {
    case 'running': return green(text)
    case 'parked': return yellow(text)
    case 'orphaned':
    case 'overdue':
    case 'stale-claim': return red(text)
    case 'finished': return gray(text)
  }
}

/** Lines this layout always spends: header, its rule, and the footer. */
const FIXED_CHROME_LINES = 3
const MAX_DETAIL_LINES = 6

/**
 * Assemble the frame so that it NEVER exceeds `rows` and the footer is always
 * the last line.
 *
 * The footer is not decoration: it carries the destructive-action confirmation
 * ("Delete … AND its conversation history? [y/n]"). An earlier version built a
 * fixed-height frame and let the caller truncate, so on a terminal shorter than
 * nine rows the prompt was cut off — the operator sat in confirm mode with no
 * sign of it, and the next `y` they typed for any reason deleted a session's
 * history. Space is therefore taken from the detail panel first, then the list,
 * and never from the footer.
 */
export function buildFrame(input: FrameInput): string[] {
  const width = Math.max(40, input.columns)
  const rows = Math.max(FIXED_CHROME_LINES, input.rows)
  const rule = dim('─'.repeat(width))
  const body = rows - FIXED_CHROME_LINES

  // The detail panel needs its own rule, so it costs `detailHeight + 1`. It is
  // only worth showing if at least one list row survives.
  const detailBudget = input.tasks.length > 0 && body >= 3
    ? Math.min(MAX_DETAIL_LINES, body - 2)
    : 0
  const detailLines = detailBudget > 0
    ? detail(input.tasks[input.selected], width, detailBudget)
    : []
  const listBudget = Math.max(0, body - (detailLines.length > 0 ? detailLines.length + 1 : 0))

  const lines = [header(input, width), rule, ...list(input, width, listBudget).slice(0, listBudget)]
  if (detailLines.length > 0) lines.push(rule, ...detailLines)
  lines.push(footer(input, width))
  return lines
}

function header(input: FrameInput, width: number): string {
  const counts = summarize(input.tasks)
  const parts: string[] = []
  if (counts.running) parts.push(green(`${counts.running} running`))
  if (counts.parked) parts.push(yellow(`${counts.parked} parked`))
  if (counts.overdue) parts.push(red(`${counts.overdue} OVERDUE`))
  if (counts['stale-claim']) parts.push(red(`${counts['stale-claim']} STALE-CLAIM`))
  if (counts.orphaned) parts.push(red(`${counts.orphaned} ORPHANED`))
  if (counts.finished && input.showFinished) parts.push(gray(`${counts.finished} finished`))

  const left = `${bold('meta-agent tasks')}${input.refreshing ? dim(' ·') : ''}`
  const right = parts.join(dim(' · ')) || dim('no tasks')
  return pad(left, right, width)
}

function list(input: FrameInput, width: number, height: number): string[] {
  if (input.tasks.length === 0) {
    return [
      '',
      `  ${dim('No Auto tasks found.')}`,
      `  ${dim('Workspaces are discovered from schedulers that have run at least once.')}`,
    ].slice(0, height)
  }

  // Keep the selection inside a scrolled window without ever hiding row 0's
  // context: unhealthy tasks sort first, so the top of the list is the part
  // that matters most.
  const start = Math.max(0, Math.min(input.selected - Math.floor(height / 2), input.tasks.length - height))
  const window = input.tasks.slice(Math.max(0, start), Math.max(0, start) + height)

  return window.map(task => {
    const index = input.tasks.indexOf(task)
    const marker = index === input.selected ? cyan('▸') : ' '
    const status = paint(task.status, `● ${STATUS_LABEL[task.status]}`)
    const ws = cyan(fit(basename(task.workspace), 14))
    const id = dim(task.sessionId.slice(0, 8))
    const when = describeWhen(task, input.now)
    const cost = task.progress.estimatedCostUsd !== undefined
      ? `$${task.progress.estimatedCostUsd.toFixed(2)}`
      : ''
    const warn = !task.scheduler.alive && (task.status === 'parked' || task.status === 'overdue')
      ? red(' no-sched')
      : ''
    const left = ` ${marker} ${padVisible(status, 13)} ${ws} ${id}  ${fit(when, 20)}`
    return pad(left, `${cost}${warn}`, width)
  })
}

function detail(task: TaskView | undefined, width: number, height: number): string[] {
  if (!task) return []
  const rows: string[] = []
  const field = (label: string, value: string): void => {
    rows.push(` ${dim(label.padEnd(10))} ${fit(value, Math.max(10, width - 13))}`)
  }

  if (task.goal) field('goal', clean(task.goal))
  if (task.wake) field('waiting on', clean(task.wake.reason))
  else if (task.note) field('note', clean(task.note))

  const todos = task.progress.pendingTodos
  if (todos.length > 0) {
    field(`todo ${todos.length}`, clean(todos[0]!))
    if (todos.length > 1 && rows.length < height) field('', clean(todos[1]!))
  }

  field('progress', [
    task.progress.turnCount !== undefined ? `${task.progress.turnCount} turns` : null,
    `${task.progress.completedSteps.length} done`,
    `compactions ${task.health.compactions ?? 0}`,
    `drift ${task.health.driftCorrections ?? 0}`,
    task.pendingSteerCount ? `steer queue ${task.pendingSteerCount}` : null,
  ].filter(Boolean).join(' · '))

  field('scheduler', task.scheduler.alive
    ? `alive · pid ${task.scheduler.pid}${task.scheduler.configFile ? ` · ${basename(task.scheduler.configFile)}` : ''}`
    : 'down — this workspace has no scheduler running')

  if (isUnhealthy(task.status)) {
    rows.push(` ${red(fit(hint(task), Math.max(10, width - 2)))}`)
  }
  return rows.slice(0, height)
}

/**
 * What is wrong with this task, in one line that FITS.
 *
 * Deliberately does not inline the recovery command: an absolute workspace path
 * plus a full session UUID cannot fit any sane terminal, and a truncated
 * command is worse than none — it looks copy-pasteable and is not. The command
 * lives in `tasks show`, which has room for it.
 */
export function hint(task: TaskView): string {
  const short = task.sessionId.slice(0, 8)
  switch (task.status) {
    case 'orphaned':
      return `parked with no wake — it will never resume on its own. ` +
        `Recovery: meta-agent tasks show ${short}`
    case 'overdue':
      return 'due but unclaimed — no scheduler is running for this workspace'
    case 'stale-claim':
      return 'the executing process died; a running scheduler reclaims this once the lease expires'
    default:
      return ''
  }
}

function footer(input: FrameInput, width: number): string {
  if (input.mode.kind === 'filter') {
    return ` ${cyan('/')}${input.mode.query}${dim('▌')}   ${dim('enter accept · esc clear')}`
  }
  if (input.mode.kind === 'steer') {
    return ` ${cyan('steer ›')} ${input.mode.text}${dim('▌')}   ${dim('enter send · esc cancel')}`
  }
  if (input.mode.kind === 'confirm') {
    return ` ${red(input.mode.prompt)} ${dim('[y/n]')}`
  }
  if (input.status) {
    const mark = input.status.ok ? green('✓') : red('✗')
    return ` ${mark} ${fit(clean(input.status.text), width - 4)}`
  }
  // Built plain, then fitted, then coloured once: `fit` measures glyphs, so
  // colouring the pieces first would let escape codes count toward the width
  // and truncate a line that actually fits.
  const keys = [
    '↑↓ select', 'r run-now', 'c cancel', 'K kill', 'D delete',
    's steer', input.showFinished ? 'a hide done' : 'a show done', '/ filter', 'q quit',
  ].join(' · ')
  return ` ${dim(fit(keys, width - 2))}`
}

// ── small helpers ─────────────────────────────────────────────────────────────

function describeWhen(task: TaskView, now: number): string {
  switch (task.status) {
    case 'running':
      return task.wake?.claim ? `turn running ${duration(now - task.wake.claim.claimedAt)}` : 'turn running'
    case 'parked':
      return task.wake ? `→${clock(task.wake.fireAt)} (${duration(task.wake.fireAt - now)})` : ''
    case 'overdue':
      return task.wake ? `due ${duration(now - task.wake.fireAt)} ago` : 'due'
    case 'stale-claim':
      return task.wake?.claim ? `lease lost ${duration(now - task.wake.claim.expiresAt)} ago` : 'lease lost'
    case 'orphaned':
      return 'no wake'
    case 'finished':
      return task.lastOutcomeAt ? `${task.lastOutcome} ${duration(now - task.lastOutcomeAt)} ago` : ''
  }
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(Math.abs(ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`
  return `${Math.floor(h / 24)}d${h % 24 === 0 ? '' : `${h % 24}h`}`
}

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function clean(text: string): string {
  return sanitizeTerminalText(text.replace(/\s+/g, ' ').trim())
}

/**
 * Truncate to a display width. CJK goal text is the common case here, and every
 * one of those characters occupies two columns — measuring in code units would
 * overflow the line and wrap, which in a full-screen renderer corrupts the
 * frame rather than just looking untidy.
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += isWide(ch) ? 2 : 1
  return width
}

function isWide(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

export function fit(text: string, limit: number): string {
  if (limit <= 0) return ''
  if (displayWidth(text) <= limit) return text
  let out = ''
  let width = 0
  for (const ch of text) {
    const w = isWide(ch) ? 2 : 1
    if (width + w > limit - 1) break
    out += ch
    width += w
  }
  return `${out}…`
}

/** Strip SGR escapes so padding math counts glyphs, not colour codes. */
export function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return displayWidth(text.replace(/\x1b\[[0-9;]*m/g, ''))
}

function padVisible(text: string, width: number): string {
  const gap = Math.max(0, width - visibleLength(text))
  return text + ' '.repeat(gap)
}

/** Left text, right text, flush to the given width. */
function pad(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right))
  return left + ' '.repeat(gap) + right
}
