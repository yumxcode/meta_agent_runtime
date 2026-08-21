/**
 * cli/commands/tasks — what long-running Auto tasks exist, and are they alive.
 *
 *   meta-agent tasks                      One-shot list (TUI lands in P1)
 *   meta-agent tasks list [--json] [--active]
 *   meta-agent tasks show <sessionId> [--json]
 *
 * Finished tasks are listed BY DEFAULT. They used to be hidden behind `--all`,
 * on the theory that the view exists to surface what is broken. That was wrong
 * for the case this tool is actually used in: a scheduler drains its queue,
 * prints "no wakes left — exiting", and the multi-day run it was driving simply
 * vanishes from `meta-agent tasks`. The goal, the completed steps, the artifact
 * paths and the final cost are all still on disk; nothing would show them.
 * `--active` restores the old filter for anyone watching a live queue.
 *
 * Read-only and API-key-free on purpose: this must work in a workspace with no
 * credentials configured, and it must never be the thing that starts a turn.
 *
 * `--json` is the stable contract every future frontend consumes; the human
 * table is a rendering of the same `TaskView[]` and carries no extra logic.
 */
import { resolve } from 'node:path'
import { basename } from 'node:path'
import {
  collectTasks,
  isUnhealthy,
  summarize,
  type TaskStatus,
  type TaskView,
} from '../../core/auto/TaskRegistry.js'
import { listKnownWorkspaces } from '../../core/auto/SchedulerRegistry.js'
import {
  actionAvailability,
  applyTaskAction,
  resumeCommandFor,
  type TaskActionKind,
} from '../../core/auto/TaskActions.js'
import { formatLocalTimestamp } from '../../loop/localTime.js'
import { bold, cyan, dim, gray, green, isTTY, red, yellow, terminalText } from '../term.js'
import { TaskTui } from '../tui/TaskTui.js'
import type { CliOptions } from '../args.js'

function usage(): string {
  return [
    `${bold('meta-agent tasks')} — long-running Auto tasks and whether they are alive`,
    '',
    `  ${cyan('meta-agent tasks list')}                 List tasks in every known workspace`,
    `  ${cyan('meta-agent tasks list --active')}        Hide finished tasks (live queue only)`,
    `  ${cyan('meta-agent tasks show <sessionId>')}     Full detail, incl. artifact paths`,
    '',
    `  ${cyan('meta-agent tasks run-now <sessionId>')}  Bring a parked wake forward to now`,
    `  ${cyan('meta-agent tasks cancel  <sessionId>')}  Drop a pending wake (session stops waking)`,
    `  ${cyan('meta-agent tasks kill    <sessionId>')}  ${red('Interrupt the running turn')} (needs --yes)`,
    `  ${cyan('meta-agent tasks steer   <sessionId> "…"')} Queue a mid-run correction`,
    `  ${cyan('meta-agent tasks rm      <sessionId>')}  ${red('Delete the task AND its history')} (needs --yes)`,
    '',
    dim('  --json                  Machine-readable output (stable contract)'),
    dim('  --active                List only tasks that are still live'),
    dim('  --all                   Accepted for compatibility; finished tasks'),
    dim('                          are shown by default and --all overrides --active'),
    dim('  --workspace <dir>       Restrict to one workspace'),
    dim('  --yes                   Confirm a destructive action'),
    '',
    dim('  Actions only edit the durable queue — they never start a turn. The'),
    dim('  running scheduler executes; that is why no API key is required here.'),
    dim('  Workspaces are discovered from the scheduler registry, so a workspace'),
    dim('  that has never run `auto-scheduler` will not appear; pass --workspace'),
    dim('  to inspect it anyway.'),
  ].join('\n')
}

/**
 * Artifact paths shown by `tasks show` before it defers to `--json`. A long run
 * can record dozens; past ~20 the terminal scrollback becomes the report and
 * the fields above it scroll away.
 */
const ARTIFACT_LIST_LIMIT = 20

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: 'running',
  parked: 'parked',
  overdue: 'OVERDUE',
  'stale-claim': 'STALE-CLAIM',
  orphaned: 'ORPHANED',
  finished: 'finished',
}

function paintStatus(status: TaskStatus): string {
  const label = STATUS_LABEL[status]
  switch (status) {
    case 'running': return green(`● ${label}`)
    case 'parked': return yellow(`● ${label}`)
    case 'orphaned':
    case 'overdue':
    case 'stale-claim': return red(`● ${label}`)
    case 'finished': return gray(`● ${label}`)
  }
}

export async function runTasksCommand(opts: CliOptions): Promise<void> {
  const args = [...(opts.loopCommand?.args ?? [])]
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(usage())
    return
  }

  const json = opts.json || takeFlag(args, '--json')
  // Finished tasks are the default. `--all` predates that and is still honoured
  // (scripts and muscle memory both exist); it wins over `--active` so the two
  // together mean the same thing `--all` always meant.
  const all = takeFlag(args, '--all')
  const activeOnly = takeFlag(args, '--active') && !all
  const showFinished = !activeOnly
  const yes = takeFlag(args, '--yes') || takeFlag(args, '-y')
  const workspace = takeOption(args, '--workspace') ?? takeOption(args, '-w') ?? opts.workspace

  const noTui = takeFlag(args, '--no-tui')
  const sub = args[0] && !args[0].startsWith('-') ? args.shift()! : ''
  const workspaces = workspace ? [resolve(workspace)] : undefined

  // Bare `meta-agent tasks` on a terminal opens the full-screen view; through a
  // pipe or in CI it degrades to a single list so `tasks | grep ORPHANED` and
  // `tasks --json` keep working unchanged.
  if (sub === '' && isTTY && process.stdin.isTTY && !json && !noTui) {
    await new TaskTui({
      ...(workspaces ? { workspaces } : {}),
      showFinished,
    }).run()
    return
  }

  if (sub === '' || sub === 'list') {
    await listTasks({ ...(workspaces ? { workspaces } : {}), json, showFinished })
    return
  }
  if (sub === 'show') {
    const sessionId = args.find(a => !a.startsWith('-'))
    if (!sessionId) {
      console.error(red('tasks show requires a sessionId.'))
      process.exitCode = 1
      return
    }
    await showTask({ ...(workspaces ? { workspaces } : {}), sessionId, json })
    return
  }

  const action = ACTION_SUBCOMMANDS[sub]
  if (action) {
    await runAction({
      ...(workspaces ? { workspaces } : {}),
      kind: action,
      args,
      json,
      confirmed: yes,
    })
    return
  }

  console.error(red(`Unknown tasks subcommand: ${terminalText(sub)}`))
  console.error(usage())
  process.exitCode = 1
}

const ACTION_SUBCOMMANDS: Record<string, TaskActionKind | undefined> = {
  'run-now': 'run-now',
  cancel: 'cancel',
  kill: 'kill',
  steer: 'steer',
  rm: 'delete',
  delete: 'delete',
}

/** Extra warning shown before an irreversible action. */
const DESTRUCTIVE_WARNING: Partial<Record<TaskActionKind, string>> = {
  kill: 'Work already written to the workspace is NOT rolled back.',
  delete:
    'This deletes the checkpoint AND the conversation history. ' +
    'The session cannot be resumed afterwards — hundreds of turns of context are gone.',
}

async function runAction(input: {
  workspaces?: string[]
  kind: TaskActionKind
  args: string[]
  json: boolean
  confirmed: boolean
}): Promise<void> {
  const positional = input.args.filter(a => !a.startsWith('-'))
  const sessionId = positional.shift()
  if (!sessionId) {
    console.error(red(`tasks ${input.kind} requires a sessionId.`))
    process.exitCode = 1
    return
  }

  const tasks = await collectTasks(input.workspaces ? { workspaces: input.workspaces } : {})
  const matches = tasks.filter(t => t.sessionId === sessionId || t.sessionId.startsWith(sessionId))
  if (matches.length === 0) {
    console.error(red(`No task found for session ${terminalText(sessionId)}.`))
    process.exitCode = 1
    return
  }
  if (matches.length > 1) {
    // Acting on the wrong long-running task is expensive; make the operator
    // disambiguate rather than guessing for them.
    console.error(red(`"${terminalText(sessionId)}" matches ${matches.length} sessions:`))
    for (const t of matches) console.error(dim(`  ${t.sessionId}  ${t.workspace}`))
    process.exitCode = 1
    return
  }
  const task = matches[0]!

  // `kill` interrupts a model turn that is running right now. Requiring an
  // explicit --yes keeps it out of reach of a mistyped shell history entry.
  const gate = actionAvailability(task, input.kind)
  if (gate.destructive && !input.confirmed) {
    console.error(
      `${red('!')} ${input.kind} on ${cyan(task.sessionId.slice(0, 8))} ` +
      `(${dim(clip(task.goal ?? task.workspace, 50))})\n` +
      `  ${red(DESTRUCTIVE_WARNING[input.kind] ?? 'This cannot be undone.')}\n` +
      `  ${dim('Re-run with --yes to confirm.')}`,
    )
    process.exitCode = 1
    return
  }

  const result = await applyTaskAction(task, input.kind, positional.join(' '))
  if (input.json) {
    console.log(JSON.stringify({ action: input.kind, sessionId: task.sessionId, ...result }))
  } else {
    console.log(result.ok ? `${green('✓')} ${result.message}` : `${red('✗')} ${result.message}`)
  }
  if (!result.ok) process.exitCode = 1
}

async function listTasks(input: {
  workspaces?: string[]
  json: boolean
  showFinished: boolean
}): Promise<void> {
  const tasks = await collectTasks(input.workspaces ? { workspaces: input.workspaces } : {})
  const shown = input.showFinished ? tasks : tasks.filter(t => t.status !== 'finished')

  if (input.json) {
    console.log(JSON.stringify({ tasks: shown, summary: summarize(tasks) }, null, 2))
    return
  }

  if (tasks.length === 0) {
    const known = input.workspaces ?? await listKnownWorkspaces()
    console.log(known.length === 0
      ? dim('No workspace has registered a scheduler yet. Start one with `meta-agent -w <dir> auto-scheduler`.')
      : dim(`No Auto tasks found in ${known.length} known workspace(s).`))
    return
  }

  console.log(summaryLine(tasks))
  console.log(dim('─'.repeat(78)))
  for (const task of shown) console.log(renderRow(task))
  if (!input.showFinished && shown.length < tasks.length) {
    console.log(dim(`  … ${tasks.length - shown.length} finished task(s) hidden by --active`))
  }

  const broken = tasks.filter(t => isUnhealthy(t.status))
  if (broken.length > 0) {
    console.log('')
    for (const task of broken) console.log(advice(task))
  }
}

function summaryLine(tasks: readonly TaskView[]): string {
  const counts = summarize(tasks)
  const parts: string[] = []
  if (counts.running) parts.push(green(`${counts.running} running`))
  if (counts.parked) parts.push(yellow(`${counts.parked} parked`))
  if (counts.overdue) parts.push(red(`${counts.overdue} OVERDUE`))
  if (counts['stale-claim']) parts.push(red(`${counts['stale-claim']} STALE-CLAIM`))
  if (counts.orphaned) parts.push(red(`${counts.orphaned} ORPHANED`))
  if (counts.finished) parts.push(gray(`${counts.finished} finished`))
  return `${bold('tasks')}  ${parts.join(dim(' · ')) || dim('none')}`
}

/**
 * The one time-fact that matters for this row's status. Each status has a
 * different one, and showing the wrong one is actively misleading — a `running`
 * task labelled with its PREVIOUS wake's outcome reads as if nothing is
 * happening right now.
 */
function describeWhen(task: TaskView, now = Date.now()): string {
  switch (task.status) {
    case 'running':
      return task.wake?.claim
        ? `turn running ${formatDuration(now - task.wake.claim.claimedAt)}`
        : 'turn running'
    case 'parked':
      return task.wake
        ? `→${formatClock(task.wake.fireAt)} (${formatDuration(task.wake.fireAt - now)})`
        : ''
    case 'overdue':
      return task.wake ? `due ${formatDuration(now - task.wake.fireAt)} ago` : 'due'
    case 'stale-claim':
      return task.wake?.claim
        ? `lease lost ${formatDuration(now - task.wake.claim.expiresAt)} ago`
        : 'lease lost'
    case 'orphaned':
      return 'no wake'
    case 'finished':
      return task.lastOutcomeAt
        ? `${task.lastOutcome} ${formatDuration(now - task.lastOutcomeAt)} ago`
        : ''
  }
}

function renderRow(task: TaskView): string {
  const when = describeWhen(task)
  const cost = task.progress.estimatedCostUsd !== undefined
    ? `$${task.progress.estimatedCostUsd.toFixed(2)}`
    : ''
  const schedulerFlag = !task.scheduler.alive && (task.status === 'parked' || task.status === 'overdue')
    ? red(' ⚠ no scheduler')
    : ''

  const head =
    `  ${paintStatus(task.status).padEnd(22)} ` +
    `${cyan(basename(task.workspace).padEnd(16))} ` +
    `${dim(task.sessionId.slice(0, 8))}  ` +
    `${when.padEnd(22)} ${cost}${schedulerFlag}`
  const goal = task.goal ? `\n      ${dim(terminalText(clip(task.goal, 66)))}` : ''
  return head + goal
}

/**
 * A broken row is useless without the next action. Name the recovery command,
 * and name it with the binary that actually owns this task: a workspace served
 * by a GLM-profile scheduler must not be told to resume with plain
 * `meta-agent`, which would silently run the session on a different provider.
 */
function advice(task: TaskView): string {
  const bin = (task.profile ?? task.scheduler.configFile)?.includes('glm')
    ? 'meta-agent-glm'
    : 'meta-agent'
  switch (task.status) {
    case 'orphaned':
      return `${red('!')} ${task.sessionId.slice(0, 8)} is ORPHANED — parked with no wake; it will never resume.\n` +
        `  ${dim(resumeCommandFor(task))}`
    case 'overdue':
      return `${red('!')} ${task.sessionId.slice(0, 8)} is OVERDUE — nothing claimed a due wake.\n` +
        `  ${dim(`${bin} -w ${task.workspace} auto-scheduler`)}`
    case 'stale-claim':
      return `${red('!')} ${task.sessionId.slice(0, 8)} holds a STALE CLAIM — the executing process died.\n` +
        `  ${dim('A running scheduler reclaims it automatically once the lease expires.')}`
    default:
      return ''
  }
}

async function showTask(input: {
  workspaces?: string[]
  sessionId: string
  json: boolean
}): Promise<void> {
  const tasks = await collectTasks(input.workspaces ? { workspaces: input.workspaces } : {})
  const task = tasks.find(t =>
    t.sessionId === input.sessionId || t.sessionId.startsWith(input.sessionId))
  if (!task) {
    if (input.json) console.log(JSON.stringify({ task: null }))
    else console.error(red(`No task found for session ${terminalText(input.sessionId)}.`))
    process.exitCode = 1
    return
  }

  if (input.json) {
    console.log(JSON.stringify({ task }, null, 2))
    return
  }

  const line = (label: string, value: string): void =>
    console.log(`  ${dim(label.padEnd(12))} ${value}`)

  console.log(`${paintStatus(task.status)}  ${bold(task.sessionId)}`)
  line('workspace', task.workspace)
  if (task.goal) line('goal', terminalText(clip(task.goal, 62)))
  if (task.note) line('note', terminalText(clip(task.note, 62)))
  if (task.wake) {
    line('wake', `${task.wake.wakeId}  ${formatLocalTimestamp(task.wake.fireAt)}  attempt ${task.wake.attempts}`)
    line('waiting on', terminalText(clip(task.wake.reason, 62)))
    if (task.wake.checkpoint) {
      line('checkpoint', terminalText(clip(JSON.stringify(task.wake.checkpoint), 62)))
    }
  }
  if (task.lastOutcome) {
    line('last wake', `${task.lastOutcome}${task.lastOutcomeAt ? ` at ${formatLocalTimestamp(task.lastOutcomeAt)}` : ''}`)
  }
  line('progress', [
    task.progress.turnCount !== undefined ? `${task.progress.turnCount} turns` : null,
    task.progress.estimatedCostUsd !== undefined ? `$${task.progress.estimatedCostUsd.toFixed(2)}` : null,
    `${task.progress.completedSteps.length} done`,
    `${task.progress.pendingTodos.length} todo`,
    `${task.progress.artifacts.length} artifacts`,
  ].filter(Boolean).join(' · '))
  line('health', [
    `compactions ${task.health.compactions ?? 0}`,
    `drift ${task.health.driftCorrections ?? 0}`,
    `verify-reject ${task.health.verifyRejections ?? 0}`,
  ].join(' · '))
  line('scheduler', task.scheduler.alive
    ? green(`alive  pid ${task.scheduler.pid} on ${task.scheduler.host}`)
    : red(`down${task.scheduler.lastSeen ? `  last seen ${formatLocalTimestamp(task.scheduler.lastSeen)}` : ''}`))
  if (task.pendingSteerCount > 0) line('steer queue', `${task.pendingSteerCount} pending`)

  if (task.progress.pendingTodos.length > 0) {
    console.log(`\n  ${dim('待办')}`)
    for (const todo of task.progress.pendingTodos.slice(0, 10)) {
      console.log(`    · ${terminalText(clip(todo, 70))}`)
    }
  }
  // Artifacts print in FULL — `clip` would make a path that no longer opens
  // anything, which is the one thing a reader will try to do with this list.
  // Only control characters are stripped.
  if (task.progress.artifacts.length > 0) {
    console.log(`\n  ${dim('产出')}`)
    for (const path of task.progress.artifacts.slice(0, ARTIFACT_LIST_LIMIT)) {
      console.log(`    · ${terminalText(path)}`)
    }
    const rest = task.progress.artifacts.length - ARTIFACT_LIST_LIMIT
    if (rest > 0) console.log(dim(`    … +${rest} more (--json for the full list)`))
  }
  const tip = advice(task)
  if (tip) console.log(`\n${tip}`)
}

// ── formatting helpers ────────────────────────────────────────────────────────

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

function formatClock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Coarse, human-scale: "24m", "3h12m", "2d". Sign is the caller's business. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(Math.abs(ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`
  return `${Math.floor(h / 24)}d${h % 24 === 0 ? '' : `${h % 24}h`}`
}

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}

function takeOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i === -1 || i + 1 >= args.length) return undefined
  const [value] = args.splice(i, 2).slice(1)
  return value
}
