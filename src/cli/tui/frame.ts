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
import { displayWidth, fit, wrapToWidth } from '../textWidth.js'
import { sanitizeTerminalText } from '../terminalSanitizer.js'
import { isUnhealthy, summarize, type TaskStatus, type TaskView } from '../../core/auto/TaskRegistry.js'
import type { ManagedTaskActivity, TaskManagerSnapshot } from './TaskManager.js'
import type { TaskActivityEntry, TaskActivityFeed } from './TaskActivityLog.js'

/** Transient input the TUI is collecting, if any. */
export type FrameMode =
  | { kind: 'browse' }
  | { kind: 'filter'; query: string }
  | { kind: 'steer'; text: string }
  | { kind: 'confirm'; prompt: string }
  /**
   * The completion report, full screen and scrollable.
   *
   * Its own mode rather than a taller panel because a report is the one thing
   * here that does not fit the board's shape: every other surface is a fixed
   * number of `slice(0, height)` rows, which is right for state you glance at
   * and wrong for prose you read. `scroll` is the first visible wrapped line.
   */
  | { kind: 'report'; scroll: number }

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
  manager?: TaskManagerSnapshot
  /** Live/recent output for the selected task, supplied only by managed mode. */
  activity?: SelectedTaskActivity
}

export interface SelectedTaskActivity {
  run: ManagedTaskActivity
  feed: TaskActivityFeed
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

  const selectedTask = input.tasks[input.selected]

  // The report takes the whole screen. It is a reading surface, not a status
  // surface, and sharing rows with the list would put it back in the situation
  // that made the report unreadable in the first place.
  if (input.mode.kind === 'report' && selectedTask) {
    return reportView(input, selectedTask, input.mode.scroll, width, rows)
  }

  // The inline panel stays a MANAGED-mode surface. `activity` is now populated
  // in both modes (bare `tasks` can resolve a finished turn's log too), but that
  // is for the report view; flipping the read-only board into the 55%-height
  // split layout for every finished row would be a UI change nobody asked for.
  const wantsActivity = Boolean(
    input.manager && (input.activity || selectedTask?.status === 'running'),
  )

  // Managed output gets the lower half of a normal terminal. The list always
  // keeps at least one row; tiny terminals fall back to the compact detail
  // layout below so the footer/confirmation contract remains intact.
  if (wantsActivity && selectedTask && body >= 5) {
    const panelBudget = Math.max(2, Math.ceil((body - 1) * 0.55))
    const listBudget = Math.max(1, body - panelBudget - 1)
    const panel = activityPanel(
      selectedTask,
      input.activity,
      width,
      body - listBudget - 1,
      input.now,
    )
    return [
      header(input, width),
      rule,
      ...list(input, width, listBudget).slice(0, listBudget),
      rule,
      ...panel,
      footer(input, width),
    ]
  }

  // The detail panel needs its own rule, so it costs `detailHeight + 1`. It is
  // only worth showing if at least one list row survives.
  const detailBudget = input.tasks.length > 0 && body >= 3
    ? Math.min(MAX_DETAIL_LINES, body - 2)
    : 0
  const detailLines = detailBudget > 0
    ? detail(input.tasks[input.selected], width, detailBudget, input.manager)
    : []
  const listBudget = Math.max(0, body - (detailLines.length > 0 ? detailLines.length + 1 : 0))

  const lines = [header(input, width), rule, ...list(input, width, listBudget).slice(0, listBudget)]
  if (detailLines.length > 0) lines.push(rule, ...detailLines)
  lines.push(footer(input, width))
  return lines
}

/**
 * Wrapped lines of the report body, independent of scroll position.
 *
 * Exported so the TUI can clamp scrolling against the real line count without
 * duplicating the wrap rules — an off-by-one there scrolls past the end and
 * shows a blank screen where the conclusion should be.
 */
export function reportBodyLines(
  task: TaskView,
  activity: SelectedTaskActivity | undefined,
  width: number,
): string[] {
  const content = Math.max(20, width - 2)
  const lines: string[] = []
  const para = (text: string, paint?: (s: string) => string): void => {
    for (const raw of text.split('\n')) {
      if (!raw.trim()) { lines.push(''); continue }
      for (const chunk of wrapToWidth(sanitizeTerminalText(raw), content)) {
        lines.push(` ${paint ? paint(chunk) : chunk}`)
      }
    }
  }
  const section = (title: string): void => {
    if (lines.length > 0) lines.push('')
    lines.push(` ${bold(title)}`)
  }

  const report = activity?.feed.report

  if (task.goal) {
    section('目标')
    para(clean(task.goal), dim)
  }

  if (report?.text) {
    section('完成报告')
    para(report.text)
  }
  if (report?.diagnosis) {
    // For an abnormal ending this is the real explanation; `resultText` is a
    // canned "Stopped: …" line. Showing one without the other is misleading in
    // exactly the case that needs it most.
    section('终态诊断 (LLM)')
    para(report.diagnosis, yellow)
  }

  if (!report?.text && !report?.diagnosis) {
    section('完成报告')
    para(
      activity
        ? '这一轮的日志里没有完成报告——可能仍在运行，或该轮被中断/停放。下方为最近活动。'
        : '找不到这个任务最近一轮的运行日志。它可能从未由 tasks manager 运行过，或日志已被清理。',
      dim,
    )
  }

  const steps = task.progress.completedSteps
  if (steps.length > 0) {
    section(`已完成 ${steps.length}`)
    for (const step of steps.slice(-12)) para(`• ${clean(step)}`)
  }

  const todos = task.progress.pendingTodos
  if (todos.length > 0) {
    section(`待办 ${todos.length}`)
    for (const todo of todos.slice(0, 12)) para(`• ${clean(todo)}`, yellow)
  }

  // Verbatim and unwrapped-by-word: an artifact path's whole value is that it
  // can be copied. Wrapping is by column only, never by inserting anything.
  const artifacts = task.progress.artifacts
  if (artifacts.length > 0) {
    section(`产物 ${artifacts.length}`)
    for (const artifact of artifacts) para(artifact, cyan)
  }

  if (activity?.feed.entries.length) {
    section('最近活动')
    for (const entry of activity.feed.entries.slice(-40)) {
      if (entry.kind === 'report') continue   // already shown above, in full
      lines.push(...activityEntryLines(entry, width))
    }
  }

  return lines
}

function reportView(
  input: FrameInput,
  task: TaskView,
  scroll: number,
  width: number,
  rows: number,
): string[] {
  const body = Math.max(1, rows - FIXED_CHROME_LINES)
  const all = reportBodyLines(task, input.activity, width)
  const maxScroll = Math.max(0, all.length - body)
  const top = Math.max(0, Math.min(scroll, maxScroll))
  const visible = all.slice(top, top + body)
  while (visible.length < body) visible.push('')

  const report = input.activity?.feed.report
  const facts = [
    report?.subtype ?? (input.activity ? undefined : 'no log'),
    report?.stopReason,
    report?.numTurns !== undefined ? `${report.numTurns} turns` : undefined,
    report?.durationMs !== undefined ? duration(report.durationMs) : undefined,
    report?.totalCostUsd !== undefined ? `$${report.totalCostUsd.toFixed(4)}` : undefined,
    report?.clipped ? 'clipped' : undefined,
    input.activity?.run.reattached ? 'from log' : undefined,
  ].filter(Boolean).join(' · ')
  const left = ` ${bold('report')}  ${dim(`${basename(task.workspace)} · ${task.sessionId.slice(0, 8)}`)}`
  const right = facts ? (report?.isError ? red(facts) : green(facts)) : ''

  const position = maxScroll > 0
    ? `${Math.round((top / maxScroll) * 100)}%`
    : 'all'
  // `q` closes the pane rather than the board — the `less`/`man`/`git log`
  // convention, and the reason the browse-mode footer's "q quit" must not be
  // repeated verbatim here. Ctrl+C still exits from anywhere.
  const footer = ` ${dim(fit(
    `↑↓/PgUp/PgDn scroll · ${position} · esc/q back · ^C quit`,
    width - 2,
  ))}`

  return [pad(left, right, width), dim('─'.repeat(width)), ...visible, footer]
}

function activityPanel(
  task: TaskView,
  activity: SelectedTaskActivity | undefined,
  width: number,
  height: number,
  now: number,
): string[] {
  if (height <= 0) return []
  if (!activity) {
    const left = ` ${bold('live activity')}`
    const context = fit(
      `${basename(task.workspace)} · ${task.sessionId.slice(0, 8)}`,
      Math.max(1, width - visibleLength(left) - 2),
    )
    return [
      `${left}  ${dim(context)}`,
      ` ${yellow(fit('Live output unavailable — this turn was not launched by this tasks manager.', width - 2))}`,
    ].slice(0, height)
  }

  const run = activity.run
  const state = run.state === 'running' ? 'running' : run.state === 'succeeded' ? 'completed' : 'failed'
  const title = run.state === 'running' ? 'live activity' : 'recent activity'
  // A reattached record has no measured start: `startedAt` is the wake's
  // terminal timestamp, so the "elapsed" would read 0s and claim the turn took
  // no time. Report when it ended instead — the only thing we actually know.
  const timing = run.reattached
    ? (run.endedAt ? `ended ${duration(now - run.endedAt)} ago` : '')
    : duration((run.endedAt ?? now) - run.startedAt)
  const facts = [
    state,
    run.pid ? `pid ${run.pid}` : '',
    timing,
    activity.feed.report ? 'report ready' : '',
    activity.feed.truncated ? 'tail' : '',
  ].filter(Boolean).join(' · ')
  const left = ` ${bold(title)}`
  const fittedFacts = fit(facts, Math.max(1, width - visibleLength(left) - 2))
  const headerLine = `${left}  ${run.state === 'failed' ? red(fittedFacts) : green(fittedFacts)}`

  if (height === 1) return [headerLine]
  if (activity.feed.error) {
    return [headerLine, ` ${red(fit(clean(activity.feed.error), width - 2))}`].slice(0, height)
  }
  if (activity.feed.entries.length === 0) {
    return [headerLine, ` ${dim('Waiting for worker output…')}`].slice(0, height)
  }

  const rendered = activity.feed.entries.flatMap(entry => activityEntryLines(entry, width))
  return [headerLine, ...rendered.slice(-(height - 1))]
}

function activityEntryLines(entry: TaskActivityEntry, width: number): string[] {
  const label = activityLabel(entry)
  const labelWidth = displayWidth(label.text)
  const contentWidth = Math.max(4, width - labelWidth - 3)
  const chunks = wrap(clean(entry.text), contentWidth)
  const continuation = ' '.repeat(labelWidth)
  return (chunks.length ? chunks : ['']).map((chunk, index) => {
    const marker = index === 0 ? label.coloured : continuation
    const content = activityText(entry, chunk)
    return ` ${marker} ${content}`
  })
}

function activityLabel(entry: TaskActivityEntry): { text: string; coloured: string } {
  switch (entry.kind) {
    case 'agent': return { text: 'agent ›', coloured: bold(green('agent ›')) }
    case 'thinking': return { text: '·', coloured: dim('·') }
    case 'tool': return { text: '⚙', coloured: cyan('⚙') }
    case 'tool-result': return { text: '→', coloured: dim('→') }
    case 'warning': return { text: '⚠', coloured: yellow('⚠') }
    case 'error': return { text: '✗', coloured: red('✗') }
    case 'status': return { text: '●', coloured: cyan('●') }
    case 'report': return { text: '报告 ›', coloured: bold(cyan('报告 ›')) }
  }
}

function activityText(entry: TaskActivityEntry, text: string): string {
  switch (entry.kind) {
    case 'thinking':
    case 'tool-result': return dim(text)
    case 'warning': return yellow(text)
    case 'error': return red(text)
    default: return text
  }
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
  if (input.manager) {
    parts.unshift(cyan(
      `manage ${input.manager.running}/${input.manager.maxRunning}` +
      (input.manager.queued ? ` · ${input.manager.queued} queued` : ''),
    ))
    if (input.manager.lastError) parts.unshift(red('manager error'))
  }
  const right = parts.join(dim(' · ')) || dim('no tasks')
  return pad(left, right, width)
}

function list(input: FrameInput, width: number, height: number): string[] {
  if (input.tasks.length === 0) {
    return [
      '',
      `  ${dim('No Auto tasks found.')}`,
      `  ${dim('Workspaces are discovered when an Auto wake is armed.')}`,
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
    const id = dim(task.sessionId.slice(0, 8))
    const when = describeWhen(task, input.now)
    const cost = task.progress.estimatedCostUsd !== undefined
      ? `$${task.progress.estimatedCostUsd.toFixed(2)}`
      : ''
    const warn = !input.manager && !task.scheduler.alive && (task.status === 'parked' || task.status === 'overdue')
      ? red(' no-sched')
      : ''
    let right = `${cost}${warn}`
    // Keep the warning rather than the cost when a narrow terminal cannot fit
    // both. Status + task identity are the irreducible left side (30 cols).
    if (visibleLength(right) > width - 31) right = warn || fit(cost, width - 31)
    const leftLimit = width - visibleLength(right) - (right ? 1 : 0)
    const wsWidth = Math.min(14, Math.max(4, Math.floor((leftLimit - 26) / 2)))
    const wsCell = padVisible(cyan(fit(basename(task.workspace), wsWidth)), wsWidth)
    const fixed = ` ${marker} ${padVisible(status, 13)} ${wsCell} ${id}`
    const remaining = Math.max(0, leftLimit - visibleLength(fixed))
    const left = remaining >= 4 ? `${fixed}  ${fit(when, remaining - 2)}` : fixed
    return pad(left, right, width)
  })
}

function detail(
  task: TaskView | undefined,
  width: number,
  height: number,
  manager?: TaskManagerSnapshot,
): string[] {
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
    : manager
      ? `tasks manager · global ${manager.running}/${manager.maxRunning}`
      : 'down — this workspace has no scheduler running')

  if (manager?.lastError) field('manager', clean(manager.lastError))

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
    '↑↓ select', 'enter report', input.manager ? 'r run' : 'r run-now', 'c cancel', 'K kill',
    'D delete', 's steer', input.showFinished ? 'a hide done' : 'a show done', '/ filter', 'q quit',
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

// Width measurement lives in ../textWidth.ts so every CLI surface that
// truncates to the terminal width shares ONE definition (the thinking meter
// used to have its own, measured in code units, and wrapped on Chinese text).
// Re-exported here because the frame is where callers and tests look for it.
export { displayWidth, fit } from '../textWidth.js'

/** Wrap sanitized activity text without splitting a wide CJK glyph. */
const wrap = wrapToWidth

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
  if (!right) return left + ' '.repeat(Math.max(0, width - visibleLength(left)))
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right))
  return left + ' '.repeat(gap) + right
}
