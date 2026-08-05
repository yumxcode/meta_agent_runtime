/**
 * cli/commands/steer — inject a mid-turn correction into an UNATTENDED run.
 *
 * The interactive REPL steers with Ctrl+G because it owns stdin. A detached
 * `auto-scheduler` cannot: it never touches readline, stdin is not in raw mode,
 * and it is usually run under nohup / systemd / tmux where no key can be
 * pressed. This command is the out-of-band equivalent — it drops a message in
 * the session's queue, which the running loop polls and injects at its next
 * iteration boundary (same delivery semantics as Ctrl+G: the in-flight model
 * stream is never aborted).
 *
 *   meta-agent steer --list
 *   meta-agent steer <sessionId> "prefer the coarse mesh; we're out of budget"
 *   meta-agent steer --clear <sessionId>
 */
import { resolve } from 'node:path'
import { SessionStore } from '../../core/SessionStore.js'
import { AutoContinuationStore } from '../../core/auto/AutoContinuationStore.js'
import {
  enqueueSteer, pendingSteerCount, clearSteer, pruneSteer, MAX_STEER_TEXT_CHARS,
} from '../../core/auto/SteerChannel.js'
import { formatLocalTimestamp } from '../../loop/localTime.js'
import { bold, cyan, dim, green, red, yellow, terminalText } from '../term.js'
import type { CliOptions } from '../args.js'

function usage(): string {
  return [
    `${bold('meta-agent steer')} — inject a correction into a running unattended session`,
    '',
    `  ${cyan('meta-agent steer --list')}                     List sessions you can steer`,
    `  ${cyan('meta-agent steer <sessionId> "<text>"')}       Queue a correction`,
    `  ${cyan('meta-agent steer --clear <sessionId>')}        Drop a session's queued corrections`,
    '',
    dim('  -w, --workspace <dir>   Project directory (default: cwd)'),
    '',
    dim('  The correction is appended as a user message at the loop\'s next step'),
    dim('  boundary. It does NOT abort generation — same as Ctrl+G in the REPL.'),
    dim('  In an interactive REPL, use Ctrl+G instead; this command is for'),
    dim('  `auto-scheduler` / `--attached` runs that have no keyboard.'),
  ].join('\n')
}

export async function runSteerCommand(opts: CliOptions): Promise<void> {
  const args = [...(opts.loopCommand?.args ?? [])]
  const projectDir = resolve(opts.workspace ?? process.cwd())

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(usage())
    return
  }

  // Housekeeping on every invocation: a correction typed for a session that is
  // never resumed must not linger and then surface days later.
  await pruneSteer(projectDir).catch(() => 0)

  if (args[0] === '--list') {
    await listSteerable(projectDir, opts.json)
    return
  }

  if (args[0] === '--clear') {
    const sessionId = args[1]
    if (!sessionId) {
      console.error(red('steer --clear requires a sessionId.'))
      process.exitCode = 1
      return
    }
    const pending = await pendingSteerCount(projectDir, sessionId)
    await clearSteer(projectDir, sessionId)
    if (opts.json) console.log(JSON.stringify({ cleared: pending, sessionId }))
    else console.log(`${green('✓')} cleared ${pending} queued correction(s) for ${cyan(sessionId)}`)
    return
  }

  const sessionId = args[0]!
  const text = args.slice(1).join(' ').trim()
  if (!text) {
    console.error(red('steer requires correction text.'))
    console.error(dim('  meta-agent steer <sessionId> "your correction"'))
    process.exitCode = 1
    return
  }

  // Warn — but do not refuse — when the session is unknown to this workspace.
  // The scheduler may not have created it yet, and refusing would make the
  // command racy; a typo'd id is far more likely, so say something.
  const meta = await SessionStore.getSession(sessionId).catch(() => null)
  if (!meta) {
    process.stderr.write(
      `${yellow('Warning:')} no session ${sessionId} found in this workspace. ` +
      `Queuing anyway — it will be delivered if that session runs.\n`,
    )
  }

  const message = await enqueueSteer(projectDir, sessionId, text, 'cli')

  if (opts.json) {
    console.log(JSON.stringify({ queued: true, id: message.id, sessionId, text: message.text }))
    return
  }
  console.log(`${green('✓')} queued for ${cyan(sessionId)}`)
  console.log(`  ${dim(terminalText(message.text.slice(0, 200)))}`)
  if (message.text.length >= MAX_STEER_TEXT_CHARS) {
    console.log(`  ${yellow(`(truncated to ${MAX_STEER_TEXT_CHARS} chars)`)}`)
  }
  console.log(dim('  Delivered at the running loop\'s next step boundary.'))
  console.log(dim('  If nothing is running, it waits (24h) — `steer --clear` to drop it.'))
}

/**
 * Show what can be steered: sessions with a pending/claimed auto-continuation
 * wake, which is exactly the set `auto-scheduler` is running or about to run.
 */
async function listSteerable(projectDir: string, json: boolean): Promise<void> {
  const store = new AutoContinuationStore(projectDir)
  const records = await store.list().catch(() => [])
  const live = records.filter(r => r.status === 'pending' || r.status === 'claimed')

  const rows = await Promise.all(live.map(async record => ({
    sessionId: record.sessionId,
    status: record.status,
    fireAt: record.fireAt,
    reason: record.reason,
    queued: await pendingSteerCount(projectDir, record.sessionId),
  })))

  if (json) {
    console.log(JSON.stringify({ workspace: projectDir, sessions: rows }, null, 2))
    return
  }

  if (rows.length === 0) {
    console.log(dim(`No scheduled auto sessions in ${projectDir}.`))
    console.log(dim('You can still steer a known sessionId — the message waits until it runs.'))
    return
  }

  console.log(bold(`Steerable sessions in ${projectDir}`))
  console.log()
  for (const row of rows) {
    const when = formatLocalTimestamp(row.fireAt)
    const q = row.queued > 0 ? `  ${yellow(`${row.queued} queued`)}` : ''
    console.log(`  ${cyan(row.sessionId)}  ${dim(row.status)}  ${dim(when)}${q}`)
    if (row.reason) console.log(`    ${dim(terminalText(row.reason.slice(0, 100)))}`)
  }
  console.log()
  console.log(dim('  meta-agent steer <sessionId> "your correction"'))
}
