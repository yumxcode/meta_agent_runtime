/**
 * TaskTui — the full-screen task view.
 *
 * Terminal contract, in order of how badly each one bites when you get it wrong:
 *
 *  1. ALTERNATE SCREEN. Enter with `?1049h`, leave with `?1049l`, and make the
 *     exit path unconditional — including `process.on('exit')`, because a crash
 *     that skips the teardown leaves the operator in a terminal with no cursor
 *     and no echo.
 *     `process.on('exit')` alone is NOT unconditional: Node's DEFAULT action
 *     for SIGTERM/SIGHUP/SIGQUIT is to terminate without running exit handlers,
 *     so `kill <pid>`, a dropped SSH session, or a closed terminal emulator
 *     used to leave the surviving shell in the alternate screen with raw mode
 *     still on — no echo, no working Ctrl+C, recoverable only by `reset`. The
 *     signals are therefore handled explicitly (see installExitHooks below);
 *     cli/repl.ts has covered them for a while, this view had not caught up.
 *  2. RAW MODE SWALLOWS Ctrl+C. The tty stops turning `^C` into SIGINT and
 *     delivers byte 0x03 instead. It is handled as "quit" here, which is what
 *     the key means in a viewer.
 *  3. FULL REPAINT, NO DIFFING. Rows are in the tens; a whole frame per second
 *     costs nothing and removes an entire class of stale-cell bugs. Each line
 *     is followed by an erase-to-end-of-line, and the frame by erase-to-end-of-
 *     screen, so no `clear` flash is needed.
 *  4. POLLING, NOT fs.watch. Watch semantics differ across platforms and break
 *     on network mounts and container binds; the data here is a handful of
 *     small JSON files and `list()` takes no lock, so one second of polling is
 *     both cheap and correct.
 *
 * Everything the operator sees is built by the pure `buildFrame`; this file is
 * only I/O and state.
 */
import { collectTasks, sortTasks, type TaskView } from '../../core/auto/TaskRegistry.js'
import {
  actionAvailability,
  applyTaskAction,
  type TaskActionKind,
} from '../../core/auto/TaskActions.js'
import { buildFrame, reportBodyLines, type FrameMode, type SelectedTaskActivity } from './frame.js'
import { createKeyDecoder, type Key } from './keys.js'
import { resolveFinishedTaskActivity, type TaskManager } from './TaskManager.js'
import { readTaskActivityLog } from './TaskActivityLog.js'

const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[?25l'
const LEAVE_ALT_SCREEN = '\x1b[?25h\x1b[?1049l'
/**
 * How long a partial escape sequence is held before it is treated as a real
 * Escape keypress. A terminal emits a sequence in one write unless it is under
 * burst load — a trackpad scroll — in which case the rest arrives immediately.
 */
const PARTIAL_KEY_FLUSH_MS = 40

const HOME = '\x1b[H'
const ERASE_LINE_END = '\x1b[K'
const ERASE_SCREEN_END = '\x1b[J'

/**
 * The confirmation must name the CONSEQUENCE, not the verb. "Delete task?" gets
 * a reflexive y; "deletes the conversation history, cannot be resumed" does not.
 */
export function confirmPrompt(kind: TaskActionKind, sessionId: string): string {
  const id = sessionId.slice(0, 8)
  return kind === 'delete'
    ? `Delete ${id} AND its conversation history? It cannot be resumed afterwards.`
    : `Interrupt the running turn for ${id}? Workspace changes are NOT rolled back.`
}

export interface TaskTuiOptions {
  workspaces?: readonly string[]
  refreshMs?: number
  /** Defaults to true — see the header of cli/commands/tasks.ts. */
  showFinished?: boolean
  /** Present only for `tasks --manage`; owns execution and global admission. */
  manager?: TaskManager
}

export class TaskTui {
  private tasks: TaskView[] = []
  private filtered: TaskView[] = []
  private selected = 0
  private mode: FrameMode = { kind: 'browse' }
  private status: { text: string; ok: boolean } | undefined
  private showFinished: boolean
  private refreshing = false
  private running = false
  private pendingAction: TaskActionKind | undefined
  private activity: SelectedTaskActivity | undefined
  /** Invalidates a slow log read when the selection changes underneath it. */
  private activityReadVersion = 0
  /** The task an in-progress confirm/steer prompt refers to. See startAction. */
  private pendingTask: TaskView | undefined
  private readonly refreshMs: number
  private timer: NodeJS.Timeout | undefined
  /** Carries an escape sequence split across two stdin chunks. See ./keys.ts. */
  private readonly decoder = createKeyDecoder()
  private keyFlushTimer: NodeJS.Timeout | undefined
  private resolveExit: (() => void) | undefined
  private readonly onData = (chunk: Buffer): void => this.handleInput(chunk.toString('utf-8'))
  private readonly onResize = (): void => this.paint()
  private readonly onProcessExit = (): void => this.teardown()
  /**
   * Give the terminal back, then die with the conventional 128+signal code.
   *
   * Registering a handler at all is what makes this necessary: it REPLACES
   * Node's default action, so the process would otherwise keep running with a
   * half-torn-down view. Restore first, exit second — the ordering cli/repl.ts
   * settled on for the same reason.
   */
  private readonly onFatalSignal = (signal: NodeJS.Signals, code: number): void => {
    this.teardown()
    this.resolveExit?.()
    process.exit(code)
  }
  private readonly onSigTerm = (): void => this.onFatalSignal('SIGTERM', 143)
  private readonly onSigHup  = (): void => this.onFatalSignal('SIGHUP', 129)
  private readonly onSigInt  = (): void => this.onFatalSignal('SIGINT', 130)

  constructor(private readonly options: TaskTuiOptions = {}) {
    this.refreshMs = Math.max(200, options.refreshMs ?? 1_000)
    this.showFinished = options.showFinished ?? true
  }

  async run(): Promise<void> {
    this.running = true
    const exited = new Promise<void>(resolve => { this.resolveExit = resolve })
    process.stdout.write(ENTER_ALT_SCREEN)
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.on('data', this.onData)
    process.stdout.on('resize', this.onResize)
    process.on('exit', this.onProcessExit)
    // SIGINT is here as a belt-and-braces measure only: in raw mode the tty
    // delivers 0x03 as data (handled as "quit" by decodeKeys) and never raises
    // the signal. It still matters if raw mode could not be entered — a piped
    // or otherwise non-tty stdin — where Ctrl+C IS a signal.
    process.on('SIGTERM', this.onSigTerm)
    process.on('SIGHUP', this.onSigHup)
    process.on('SIGINT', this.onSigInt)

    await this.options.manager?.start()
    if (!this.running) return
    await this.refresh()
    if (!this.running) return
    this.timer = setInterval(() => void this.refresh(), this.refreshMs)
    this.timer.unref?.()

    await exited
    this.teardown()
  }

  private teardown(): void {
    if (!this.running) return
    this.running = false
    this.activityReadVersion++
    if (this.timer) clearInterval(this.timer)
    this.cancelKeyFlush()
    void this.options.manager?.stop()
    process.stdin.off('data', this.onData)
    process.stdout.off('resize', this.onResize)
    process.off('exit', this.onProcessExit)
    process.off('SIGTERM', this.onSigTerm)
    process.off('SIGHUP', this.onSigHup)
    process.off('SIGINT', this.onSigInt)
    process.stdin.setRawMode?.(false)
    process.stdin.pause()
    process.stdout.write(LEAVE_ALT_SCREEN)
  }

  private quit(): void {
    this.teardown()
    this.resolveExit?.()
  }

  private async refresh(): Promise<void> {
    if (!this.running || this.refreshing) return
    this.refreshing = true
    try {
      const collected = await collectTasks(
        this.options.workspaces ? { workspaces: this.options.workspaces } : {},
      )
      // Keep the cursor on the same TASK across refreshes. Re-sorting on every
      // poll otherwise slides the selection onto a different row under the
      // operator's fingers, which is how you cancel the wrong thing.
      const anchor = this.filtered[this.selected]?.sessionId
      this.tasks = collected
      this.applyFilter()
      if (anchor) {
        const moved = this.filtered.findIndex(t => t.sessionId === anchor)
        if (moved >= 0) this.selected = moved
      }
      this.clampSelection()
      await this.refreshSelectedActivity(false)
    } catch (error) {
      this.status = {
        ok: false,
        text: `refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      this.refreshing = false
      this.paint()
    }
  }

  private applyFilter(): void {
    const query = this.mode.kind === 'filter' ? this.mode.query.toLowerCase() : this.activeQuery
    const visible = this.showFinished
      ? this.tasks
      : this.tasks.filter(t => t.status !== 'finished')
    this.filtered = sortTasks(
      query
        ? visible.filter(t =>
            `${t.workspace} ${t.sessionId} ${t.goal ?? ''} ${t.status}`.toLowerCase().includes(query))
        : visible,
    )
  }

  private activeQuery = ''

  private clampSelection(): void {
    if (this.filtered.length === 0) this.selected = 0
    else this.selected = Math.max(0, Math.min(this.selected, this.filtered.length - 1))
  }

  private paint(): void {
    if (!this.running) return
    const rows = process.stdout.rows ?? 24
    const columns = process.stdout.columns ?? 80
    const lines = buildFrame({
      tasks: this.filtered,
      selected: this.selected,
      mode: this.mode,
      showFinished: this.showFinished,
      ...(this.status ? { status: this.status } : {}),
      now: Date.now(),
      rows,
      columns,
      refreshing: this.refreshing,
      ...(this.options.manager ? { manager: this.options.manager.snapshot() } : {}),
      ...(this.activity ? { activity: this.activity } : {}),
    }).slice(0, rows)

    process.stdout.write(
      HOME + lines.map(l => l + ERASE_LINE_END).join('\n') + ERASE_SCREEN_END,
    )
  }

  // ── input ───────────────────────────────────────────────────────────────────

  private handleInput(chunk: string): void {
    // A held partial sequence is resolved by the next chunk if one arrives, so
    // cancel the deadline before decoding.
    this.cancelKeyFlush()
    this.dispatchKeys(this.decoder.decode(chunk))
    if (!this.running) return

    // Nothing distinguishes a lone Escape keypress from the head of a sequence
    // that got split across chunks, so the decoder holds it and we decide by
    // deadline. Short enough to be imperceptible on a real Escape; long enough
    // that a burst's continuation always wins.
    if (this.decoder.hasPending()) {
      this.keyFlushTimer = setTimeout(() => {
        this.keyFlushTimer = undefined
        if (!this.running) return
        this.dispatchKeys(this.decoder.flush())
        if (!this.running) return
        this.afterKeys()
      }, PARTIAL_KEY_FLUSH_MS)
      this.keyFlushTimer.unref?.()
    }
    this.afterKeys()
  }

  private dispatchKeys(keys: readonly Key[]): void {
    for (const key of keys) {
      if (!this.running) return
      if (key.name === 'ctrl-c' || key.name === 'ctrl-d') return this.quit()
      switch (this.mode.kind) {
        case 'browse': this.handleBrowseKey(key); break
        case 'filter': this.handleTextKey(key, 'filter'); break
        case 'steer': this.handleTextKey(key, 'steer'); break
        case 'confirm': this.handleConfirmKey(key); break
        case 'report': this.handleReportKey(key); break
      }
    }
  }

  private afterKeys(): void {
    // Cursor movement should switch the lower panel immediately instead of
    // leaving the previous task's output visible until the next 1s poll.
    //
    // Not while reading the report: those keys scroll rather than select, and
    // re-reading a 128 KB log tail on every arrow press buys nothing — the
    // selection cannot change from in here, and the 1s poll keeps the content
    // fresh anyway.
    if (this.mode.kind !== 'report') void this.refreshSelectedActivity()
    this.paint()
  }

  private cancelKeyFlush(): void {
    if (!this.keyFlushTimer) return
    clearTimeout(this.keyFlushTimer)
    this.keyFlushTimer = undefined
  }

  /**
   * Scroll the report. Movement keys only — every action key is deliberately
   * inert here, because the report is a reading surface and the operator's
   * hands are on the arrow keys, one row away from `D`.
   */
  private handleReportKey(key: Key): void {
    if (key.name === 'escape' || key.ch === 'q') { this.mode = { kind: 'browse' }; return }
    if (key.name === 'enter') { this.mode = { kind: 'browse' }; return }
    const page = Math.max(1, (process.stdout.rows ?? 24) - 4)
    const delta =
      key.name === 'up' || key.ch === 'k' ? -1 :
      key.name === 'down' || key.ch === 'j' ? 1 :
      key.name === 'pageup' ? -page :
      key.name === 'pagedown' ? page :
      key.name === 'home' ? Number.NEGATIVE_INFINITY :
      key.name === 'end' ? Number.POSITIVE_INFINITY : 0
    if (delta === 0) return
    this.mode = { kind: 'report', scroll: this.clampScroll(this.mode.kind === 'report' ? this.mode.scroll + delta : 0) }
  }

  /**
   * Clamp against the REAL wrapped line count, using the same builder the frame
   * renders with. Guessing here scrolls past the end and leaves the operator
   * looking at a blank screen where the conclusion should be.
   */
  private clampScroll(next: number): number {
    const task = this.filtered[this.selected]
    if (!task) return 0
    const width = Math.max(40, process.stdout.columns ?? 80)
    const body = Math.max(1, (process.stdout.rows ?? 24) - 3)
    const total = reportBodyLines(task, this.activity, width).length
    return Math.max(0, Math.min(next, Math.max(0, total - body)))
  }

  private handleBrowseKey(key: Key): void {
    const move = (delta: number): void => {
      this.selected += delta
      this.clampSelection()
      this.status = undefined
    }
    // The report is read-only and reversible, so it gets the unshifted key that
    // "open this" means everywhere else. Nothing destructive is one keystroke
    // away in report mode.
    if (key.name === 'enter') { this.mode = { kind: 'report', scroll: 0 }; return }
    if (key.name === 'up' || key.ch === 'k') return move(-1)
    if (key.name === 'down' || key.ch === 'j') return move(1)
    if (key.name === 'pageup') return move(-10)
    if (key.name === 'pagedown') return move(10)
    if (key.name === 'home') { this.selected = 0; return }
    if (key.name === 'end') { this.selected = this.filtered.length - 1; this.clampSelection(); return }
    if (key.ch === 'q') return this.quit()
    if (key.ch === 'a') {
      this.showFinished = !this.showFinished
      this.applyFilter()
      this.clampSelection()
      return
    }
    if (key.ch === '/') { this.mode = { kind: 'filter', query: this.activeQuery }; return }
    if (key.name === 'escape') {
      this.activeQuery = ''
      this.applyFilter()
      this.clampSelection()
      this.status = undefined
      return
    }
    if (key.ch === 'r') {
      if (this.options.manager) return void this.runManagedNow()
      return this.startAction('run-now')
    }
    if (key.ch === 'c') return this.startAction('cancel')
    if (key.ch === 'K') return this.startAction('kill')
    if (key.ch === 's') return this.startAction('steer')
    // Both destructive keys are capitals: 'd' sits next to 's' and 'c', and a
    // fat-fingered lowercase key must not be able to delete a session's history.
    if (key.ch === 'D') return this.startAction('delete')
  }

  private handleTextKey(key: Key, kind: 'filter' | 'steer'): void {
    const current = this.mode.kind === 'filter'
      ? this.mode.query
      : this.mode.kind === 'steer' ? this.mode.text : ''

    if (key.name === 'escape') {
      if (kind === 'filter') { this.activeQuery = ''; this.applyFilter(); this.clampSelection() }
      else this.pendingTask = undefined
      this.mode = { kind: 'browse' }
      return
    }
    if (key.name === 'enter') {
      if (kind === 'filter') this.activeQuery = current
      else void this.commitAction('steer', current)
      this.mode = { kind: 'browse' }
      return
    }
    const next = key.name === 'backspace'
      ? current.slice(0, -1)
      : key.name === 'char' ? current + key.ch : current

    this.mode = kind === 'filter' ? { kind: 'filter', query: next } : { kind: 'steer', text: next }
    if (kind === 'filter') {
      this.activeQuery = next
      this.applyFilter()
      this.clampSelection()
    }
  }

  private handleConfirmKey(key: Key): void {
    const action = this.pendingAction
    this.mode = { kind: 'browse' }
    this.pendingAction = undefined
    if (key.ch === 'y' && action) {
      void this.commitAction(action)
    } else {
      this.pendingTask = undefined
      this.status = { ok: false, text: 'cancelled' }
    }
  }

  private startAction(kind: TaskActionKind): void {
    const task = this.filtered[this.selected]
    if (!task) return
    const gate = actionAvailability(task, kind)
    if (!gate.allowed) {
      this.status = { ok: false, text: `${kind}: ${gate.reason}` }
      return
    }
    // Bind the TARGET now, not when the key is finally confirmed. Typing a
    // correction or reading a confirmation takes seconds, and the 1s refresh
    // re-sorts the list underneath — an action that re-reads the cursor could
    // land on a different task than the one the prompt named.
    this.pendingTask = task
    if (kind === 'steer') { this.mode = { kind: 'steer', text: '' }; return }
    if (gate.destructive) {
      this.pendingAction = kind
      this.mode = { kind: 'confirm', prompt: confirmPrompt(kind, task.sessionId) }
      return
    }
    void this.commitAction(kind)
  }

  private async commitAction(kind: TaskActionKind, text?: string): Promise<void> {
    const task = this.pendingTask ?? this.filtered[this.selected]
    this.pendingTask = undefined
    if (!task) return
    try {
      const result = await applyTaskAction(task, kind, text)
      this.status = { ok: result.ok, text: result.message }
    } catch (error) {
      this.status = {
        ok: false,
        text: `${kind} failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    // Show the consequence immediately rather than up to a second later.
    await this.refresh()
  }

  private async runManagedNow(): Promise<void> {
    const task = this.filtered[this.selected]
    if (!task || !this.options.manager) return
    try {
      const result = await this.options.manager.runNow(task)
      this.status = { ok: result.ok, text: result.message }
    } catch (error) {
      this.status = {
        ok: false,
        text: `run failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    await this.refresh()
  }

  private async refreshSelectedActivity(paintWhenDone = true): Promise<void> {
    const version = ++this.activityReadVersion
    const task = this.filtered[this.selected]
    // Drop the current feed only when it belongs to a DIFFERENT task. Clearing
    // it unconditionally made every 1s poll blank the panel for the duration of
    // the log read, which is invisible in a two-line panel and very visible in
    // the full-screen report — the body collapsed and the scroll position
    // snapped to the top mid-read.
    const stale = this.activity && (
      !task ||
      this.activity.run.workspace !== task.workspace ||
      this.activity.run.sessionId !== task.sessionId
    )
    if (stale) this.activity = undefined
    if (!this.running || !task) {
      this.activity = undefined
      if (paintWhenDone) this.paint()
      return
    }

    // With a manager, its in-memory record wins — it knows about a turn that is
    // running right now. Without one (bare `meta-agent tasks`), durable wake
    // state still identifies the last finished turn's log, so the report is
    // readable in both modes.
    const run = this.options.manager?.activityFor(task) ?? resolveFinishedTaskActivity(task)
    if (!run) {
      this.activity = undefined
      if (paintWhenDone) this.paint()
      return
    }
    const feed = run.logPath
      ? await readTaskActivityLog(run.logPath)
      : { entries: [], truncated: false }

    const selected = this.filtered[this.selected]
    if (
      version !== this.activityReadVersion || !this.running || !selected ||
      selected.workspace !== task.workspace || selected.sessionId !== task.sessionId
    ) return
    this.activity = { run, feed }
    if (paintWhenDone) this.paint()
  }
}
