/**
 * cli/singleTurn — non-interactive entry paths.
 *
 * One-shot prompts, resuming an armed auto-continuation, the detached auto
 * scheduler, and the attached auto runner that keeps a one-shot session alive
 * across self_timer wakes.
 *
 * Extracted from cli/index.ts.
 */
import * as readline from 'node:readline'
import { resolve } from 'node:path'
import { SessionRouter } from '../routing/SessionRouter.js'
import { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import { isAutonomousMode } from '../core/modes.js'
import type { SessionMode } from '../core/modes.js'
import { SessionStore } from '../core/SessionStore.js'
import type { ConversationMessage, MetaAgentResultEvent } from '../core/types.js'
import {
  AutoContinuationStore,
  AutoWakeConsumedError,
  autoContinuationClaimOwner,
  type AutoContinuationRecord,
} from '../core/auto/AutoContinuationStore.js'
import { readAutoCheckpoint } from '../core/auto/AutoCheckpointStore.js'
import { drainSteer, pruneSteer } from '../core/auto/SteerChannel.js'
import { AutoScheduler } from '../core/auto/AutoScheduler.js'
import { AttachedAutoScheduler } from '../core/auto/AttachedAutoScheduler.js'
import { formatLocalClock, formatLocalTimestamp } from '../loop/localTime.js'
import { bold, cyan, dim, gray, green, red, yellow, isTTY, terminalText, safeStdoutWrite } from './term.js'
import { makeRouter } from './router.js'
import { streamPrompt, type SteerHooks } from './stream.js'
import { createAttachedSteerHooks } from './attachedSteer.js'
import { persistSessionSnapshot, armAutoContinuation } from './sessionFlow.js'
import { generateSessionTitle } from './sideCalls.js'
import { ensureMcpServerInstructions } from './mcpInstructions.js'
import { assertApiKeyConfigured } from './keys.js'
import { buildWorkspaceSystemPrompt } from './prompts.js'
import { DEFAULT_CLI_MAX_TURNS, AUTO_CLI_MAX_TURNS } from './limits.js'
import type { CliOptions } from './args.js'
import { parseArgs } from 'node:util'
import { createStandardTools } from '../tools/index.js'
import { updateAutoCheckpointWithStatus } from '../core/auto/AutoCheckpointStore.js'
import type { StreamPromptResult } from './stream.js'

// ── Single-turn mode ──────────────────────────────────────────────────────────

interface SingleTurnRunOptions {
  claimOwner?: string
  signal?: AbortSignal
  /**
   * Keyboard steering hooks. Supplied only by the ATTACHED path, which owns a
   * TTY and can read a correction line; the detached scheduler leaves this
   * undefined and relies on the filesystem channel instead.
   */
  steerHooks?: SteerHooks
}

/** How often an unattended run checks the filesystem steer queue. */
const STEER_POLL_MS = 700

/**
 * Default idle window before `auto-scheduler` exits on an empty queue.
 *
 * A finished project should not keep a terminal tab (and a Node process) alive
 * indefinitely. 60s is long enough to ride out the gap between one wake being
 * released and the session arming its successor.
 */
const DEFAULT_IDLE_EXIT_MS = 60_000

/** Default staleness window for an unexecuted wake — see AutoContinuationStore. */
const DEFAULT_STALE_WAKE_MS = 7 * 24 * 60 * 60_000

interface SingleTurnRunResult {
  result?: MetaAgentResultEvent
  armedWake?: AutoContinuationRecord
  sessionId?: string
}

export async function runSingleTurn(
  opts: CliOptions,
  scheduledWake?: AutoContinuationRecord,
  runOptions: SingleTurnRunOptions = {},
): Promise<SingleTurnRunResult> {
  const storeOptions = opts.sessionDir ? { rootDir: opts.sessionDir } : undefined
  let resumedMessages: ConversationMessage[] = []
  let resumedSessionId: string | undefined
  let savedMessageCount = 0

  if (opts.resume) {
    let targetId = opts.resume
    if (targetId === 'last') {
      const sessions = await SessionStore.listSessions(1, {
        ...(opts.workspace ? { workspace: opts.workspace } : {}),
        ...storeOptions,
      })
      targetId = sessions[0]?.sessionId ?? ''
    }
    if (targetId) {
      const meta = await SessionStore.getSession(targetId, storeOptions)
      if (meta && opts.workspace && meta.workspace && meta.workspace !== opts.workspace) {
        throw new Error(
          `Session ${targetId} belongs to another workspace. ` +
          `current=${opts.workspace}; session=${meta.workspace}`,
        )
      }
      resumedMessages = await SessionStore.loadHistory(targetId, storeOptions)
      if (resumedMessages.length > 0) {
        resumedSessionId = targetId
        savedMessageCount = resumedMessages.length
        // Restore the saved mode when (a) the caller did not explicitly pass
        // --mode, or (b) the caller asked for an autonomous mode (auto / simple_auto)
        // but the saved history is non-autonomous — running a jailed,
        // auto-approving loop over agentic/campaign/robotics history is exactly
        // what this guard prevents. isAutonomousMode covers every flavour.
        if (
          meta?.mode &&
          !isAutonomousMode(meta.mode) &&
          (!opts.modeExplicit || isAutonomousMode(opts.mode))
        ) {
          opts.mode = meta.mode as CliOptions['mode']
          opts.modeExplicit = true
        }
      } else if (!opts.json) {
        process.stderr.write(`${yellow(`Warning: session ${targetId} was not found; starting a new one-shot session.`)}\n`)
      }
    }
  }

  const router = makeRouter(
    opts,
    undefined,
    undefined,
    resumedMessages.length > 0 ? resumedMessages : undefined,
    undefined,
    undefined,
    resumedSessionId,
  )
  if (scheduledWake) {
    router.setScheduledAutoWake({
      wakeId: scheduledWake.wakeId,
      reason: scheduledWake.reason,
      checkpoint: scheduledWake.checkpoint,
    })
  }

  // Register standard tools (robotics registers its own)
  if (opts.mode !== 'robotics') {
    const tools = await createStandardTools({
      // planModeRef MUST be the router's shared ref so enter_plan_mode /
      // exit_plan_mode flip the same object the backend's kernel permission
      // policy reads — otherwise plan mode never gates writes.
      system: { cwd: opts.workspace, mode: (opts.mode === 'campaign' ? 'campaign' : 'agentic'), planModeRef: router.planModeRef },
      // Main-session web_fetch is result-budgeted: full-text reading belongs in
      // isolated research sub-agents (research_dispatch), not the long-lived
      // main context. Sub-agents get an unbudgeted override via the bridge.
      network: { webFetch: { maxResultSizeChars: 8_000 } },
      // Apply the same auto capability boundary in non-interactive/single-turn
      // runs as in the REPL.
      mode: opts.mode,
    })
    for (const tool of tools) {
      router.registerTool(tool)
    }
  }

  let streamed: StreamPromptResult | undefined
  let parkedHistoryCount: number | null = null
  let parkedSessionId: string | null = null
  let runSessionId: string | undefined
  let parkPersistenceError: Error | null = null

  // ── Out-of-band steering ───────────────────────────────────────────────────
  // Unattended runs have no keyboard: `auto-scheduler` never touches readline,
  // stdin is not in raw mode, and it is routinely run detached. Corrections
  // therefore arrive through the filesystem (`meta-agent steer <sessionId> …`)
  // and are polled here while the turn is in flight. Delivery semantics match
  // Ctrl+G exactly — router.steer() queues the text and KernelLoop appends it as
  // a user message at the next iteration boundary, without aborting the stream.
  const steerSessionId = resumedSessionId ?? router.getSessionId()
  const steerProjectDir = opts.workspace ?? process.cwd()
  const steerPoller = steerSessionId
    ? setInterval(() => {
        void drainSteer(steerProjectDir, steerSessionId)
          .then(messages => {
            for (const message of messages) {
              const accepted = router.steer(message.text)
              if (!opts.json) {
                process.stderr.write(
                  accepted
                    ? `${cyan('[steer]')} ${dim('injected:')} ${terminalText(message.text.slice(0, 120))}\n`
                    // No turn in flight — say so rather than dropping it silently.
                    : `${yellow('[steer]')} ${dim('no turn in flight; correction ignored:')} ${terminalText(message.text.slice(0, 120))}\n`,
                )
              }
            }
          })
          .catch(() => undefined)   // a transient FS error must not kill the run
      }, STEER_POLL_MS)
    : undefined
  steerPoller?.unref?.()

  try {
    streamed = await streamPrompt(
      router,
      opts.prompt!,
      opts.json,
      opts.showThinking,
      runOptions.steerHooks,
      runOptions.signal,
      runOptions.claimOwner !== undefined,
    )
  } catch (err) {
    if (!runOptions.signal?.aborted) {
      const msg = terminalText(err instanceof Error ? err.message : String(err))
      console.error(red(`Error: ${msg}`))
      process.exitCode = 1
    }
  } finally {
    if (steerPoller) clearInterval(steerPoller)
    // Final drain: a correction that arrived during the last poll interval would
    // otherwise sit in the queue and be injected into a LATER run of the same
    // session, long after it stopped being relevant.
    if (steerSessionId) {
      const late = await drainSteer(steerProjectDir, steerSessionId).catch(() => [])
      if (late.length && !opts.json) {
        process.stderr.write(
          `${yellow('[steer]')} ${dim(`${late.length} correction(s) arrived after the turn ended and were discarded.`)}\n`,
        )
      }
    }
    const parked = streamed?.result?.subtype === 'parked'
    if (opts.sessionDir || resumedSessionId || parked) {
      const expectedMessageCount = router.getMessages().length
      savedMessageCount = await persistSessionSnapshot({
        router,
        opts,
        currentInput: opts.prompt!,
        savedMessageCount,
        sessionRoot: opts.sessionDir,
      })
      if (parked) {
        if (savedMessageCount !== expectedMessageCount) {
          parkPersistenceError = new Error(
            `Auto session requested a durable park, but only ${savedMessageCount}/` +
            `${expectedMessageCount} messages were confirmed persisted. Wake was not armed.`,
          )
        } else {
          parkedHistoryCount = savedMessageCount
          parkedSessionId = router.getSessionId()
        }
      }
    }
    runSessionId = router.getSessionId()
    await router.dispose().catch(() => undefined)
  }
  if (parkPersistenceError) throw parkPersistenceError
  let armedWake: AutoContinuationRecord | undefined
  if (streamed?.result?.subtype === 'parked') {
    armedWake = await armAutoContinuation({
      sessionId: parkedSessionId ?? '',
      opts,
      result: streamed.result,
      historyMessageCount: parkedHistoryCount ?? 0,
      claimOwner: runOptions.claimOwner,
    })
    if (!opts.json && runOptions.claimOwner === undefined) {
      process.stderr.write(
        `${yellow('⏲')} Auto wake ${runOptions.claimOwner ? 'attached' : 'armed'}: ` +
        `${armedWake.wakeId} at ${new Date(armedWake.fireAt).toLocaleString()}\n`,
      )
    }
  }
  return {
    ...(streamed?.result ? { result: streamed.result } : {}),
    ...(armedWake ? { armedWake } : {}),
    ...(runSessionId ? { sessionId: runSessionId } : {}),
  }
}

async function resumeAutoContinuation(
  opts: CliOptions,
  projectDir: string,
  record: AutoContinuationRecord,
  signal: AbortSignal,
  claimOwner?: string,
  steerHooks?: SteerHooks,
): Promise<{ outcome: 'done' | 'cancelled'; next?: AutoContinuationRecord }> {
  const storeOptions = record.runtime?.sessionDir
    ? { rootDir: record.runtime.sessionDir }
    : undefined
  const meta = await SessionStore.getSession(record.sessionId, storeOptions)
  if (
    !meta ||
    meta.mode !== 'auto' ||
    (meta.workspace && resolve(meta.workspace) !== projectDir)
  ) {
    return { outcome: 'cancelled' }
  }
  const history = await SessionStore.loadHistory(record.sessionId, storeOptions)
  // Exact history count is the session-generation fence. Any manual resume
  // after this wake was armed makes the old timer stale, even if the goal
  // string happens to be unchanged.
  if (history.length !== record.historyMessageCount) return { outcome: 'cancelled' }

  const cp = readAutoCheckpoint(projectDir, record.sessionId)
  if (!cp || (record.goal !== undefined && cp.goal !== record.goal)) {
    return { outcome: 'cancelled' }
  }

  const resumedOpts: CliOptions = {
    ...opts,
    mode: 'auto',
    modeExplicit: true,
    workspace: projectDir,
    model: record.runtime?.model ?? opts.model,
    fallbackModel: record.runtime?.fallbackModel ?? opts.fallbackModel,
    baseUrl: record.runtime?.baseUrl ?? opts.baseUrl,
    maxTurns: record.runtime?.maxTurns ?? opts.maxTurns,
    maxBudgetUsd: record.runtime?.maxBudgetUsd ?? opts.maxBudgetUsd,
    prompt: '继续',
    resume: record.sessionId,
    sessionDir: record.runtime?.sessionDir,
    attached: claimOwner !== undefined,
    loopCommand: null,
  }
  // Scheduler startup/idle polling is pure local I/O. Connect optional MCP
  // servers only after a due wake has passed all stale-history fences.
  await ensureMcpServerInstructions()

  // Everything from here on runs AFTER the wake has been consumed: the turn
  // executes and persists new history, which invalidates this record's
  // `historyMessageCount` fence. A failure past this point must therefore never
  // be retried against the same record — the retry would fail that fence and
  // cancel the session for good. Wrapping in AutoWakeConsumedError tells the
  // scheduler to stop rather than "helpfully" trying again.
  let turn: SingleTurnRunResult
  try {
    turn = await runSingleTurn(resumedOpts, record, {
      claimOwner, signal, ...(steerHooks ? { steerHooks } : {}),
    })
  } catch (error) {
    throw new AutoWakeConsumedError(record.sessionId, error)
  }
  const result = turn.result
  if (!result) throw new Error('resumed Auto session produced no terminal result')
  if (result.subtype === 'error_during_execution') {
    throw new Error(result.errors?.join('; ') || result.result || result.stopReason || 'Auto resume failed')
  }
  if (result.subtype !== 'parked') {
    await updateAutoCheckpointWithStatus(projectDir, record.sessionId, {
      pendingWake: null,
    })
  }
  return {
    outcome: 'done',
    ...(turn.armedWake ? { next: turn.armedWake } : {}),
  }
}

export async function runAutoSchedulerCommand(opts: CliOptions): Promise<void> {
  const args = opts.loopCommand?.args ?? []
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args,
      options: {
        once: { type: 'boolean', default: false },
        'poll-ms': { type: 'string' },
        'max-concurrent': { type: 'string' },
        'idle-exit-ms': { type: 'string' },
        'stale-wake-ms': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    })
  } catch (error) {
    throw new Error(
      `auto-scheduler: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const pollIntervalMs = parsePositiveIntOption(
    parsed.values['poll-ms'] as string | undefined,
    '--poll-ms',
    1_000,
  )
  const maxConcurrent = parsePositiveIntOption(
    parsed.values['max-concurrent'] as string | undefined,
    '--max-concurrent',
    1,
  )
  // Exit once the workspace has no wakes left, instead of holding a terminal
  // open forever on a project that is finished. `--idle-exit-ms 0` restores the
  // old always-on behaviour for a machine that acts as a persistent runner.
  const idleExitMs = parseNonNegativeIntOption(
    parsed.values['idle-exit-ms'] as string | undefined,
    '--idle-exit-ms',
    DEFAULT_IDLE_EXIT_MS,
  )
  const staleWakeMs = parseNonNegativeIntOption(
    parsed.values['stale-wake-ms'] as string | undefined,
    '--stale-wake-ms',
    DEFAULT_STALE_WAKE_MS,
  )
  const projectDir = resolve(opts.workspace ?? process.cwd())
  const store = new AutoContinuationStore(projectDir, { staleWakeMs })
  const abort = new AbortController()
  const stop = () => abort.abort('signal')
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  const scheduler = new AutoScheduler(
    store,
    async (record, signal) =>
      (await resumeAutoContinuation(opts, projectDir, record, signal)).outcome,
    {
      pollIntervalMs,
      maxConcurrent,
      idleExitMs,
      onEvent: message => {
        if (opts.json) console.log(JSON.stringify({ type: 'auto_scheduler', message }))
        else process.stderr.write(`${message}\n`)
      },
    },
  )

  try {
    // Sweep stale corrections on startup: one typed for a session that never
    // resumed must not be injected days later, wildly out of context.
    await pruneSteer(projectDir).catch(() => 0)
    const healed = await store.reconcileOrphans()

    // Retire wakes whose moment passed long ago, then delete the terminal
    // records that have aged out. Neither ran before, so a queue accumulated
    // every wake a workspace had ever scheduled — 28 records for one project,
    // 27 of them long finished, all re-read under the store lock on every poll.
    const expired = await store.expireStale().catch(() => [])
    const pruned = await store.prune().catch(() => 0)

    if (!opts.json) {
      process.stderr.write(
        `[auto-scheduler] workspace=${projectDir} poll=${pollIntervalMs}ms ` +
        `concurrency=${maxConcurrent}` +
        (idleExitMs > 0 ? ` idle-exit=${Math.round(idleExitMs / 1000)}s` : ' idle-exit=off') +
        (healed.length ? ` recovered=${healed.length}` : '') +
        (pruned ? ` pruned=${pruned}` : '') +
        `\n`,
      )
      // Name what was dropped: silently shrinking someone's queue is worse than
      // the stale wake itself.
      for (const record of expired) {
        process.stderr.write(
          `${yellow('[auto-scheduler]')} expired ${record.sessionId} (${record.wakeId}) — ` +
          `due ${formatLocalTimestamp(record.fireAt)}, never ran. ` +
          `${dim(terminalText(record.reason.slice(0, 80)))}\n`,
        )
      }
    } else if (expired.length) {
      console.log(JSON.stringify({
        type: 'auto_scheduler_expired',
        wakes: expired.map(r => ({ sessionId: r.sessionId, wakeId: r.wakeId, fireAt: r.fireAt })),
      }))
    }

    if (parsed.values['once']) {
      await scheduler.tickOnce(Date.now(), abort.signal)
    } else {
      const reason = await scheduler.run(abort.signal)
      if (reason === 'idle' && !opts.json) {
        process.stderr.write(
          `${dim('本工作区已无待处理的 Auto 唤醒，scheduler 正常退出。')}\n`,
        )
      }
    }
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

export async function runAttachedAuto(opts: CliOptions): Promise<void> {
  const userCancelReason = 'attached-auto:user-cancel'
  const projectDir = resolve(opts.workspace ?? process.cwd())
  const store = new AutoContinuationStore(projectDir)
  const claimOwner = `${autoContinuationClaimOwner()}:attached`
  const abort = new AbortController()
  const interrupt = () => abort.abort(userCancelReason)
  const terminate = () => abort.abort('attached-auto:terminated')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)

  // Attached runs sit in the foreground for hours, which is exactly when a
  // mid-course correction is most useful — so this path DOES get keyboard
  // steering. (The detached scheduler cannot: no TTY. It uses the filesystem
  // channel instead — `meta-agent steer <sessionId> "…"`.)
  const steerControl = createAttachedSteerHooks({ json: opts.json })

  try {
    const initial = await runSingleTurn(opts, undefined, {
      claimOwner,
      signal: abort.signal,
      ...(steerControl ? { steerHooks: steerControl.hooks } : {}),
    })
    if (abort.signal.aborted) {
      if (abort.signal.reason === userCancelReason && initial.sessionId) {
        await cancelAttachedAutoSession(store, projectDir, initial.sessionId)
      } else if (initial.armedWake?.claim?.token) {
        await store.release(
          initial.armedWake.wakeId,
          initial.armedWake.claim.token,
          'pending',
          initial.armedWake.fireAt,
        )
      }
      return
    }
    if (!initial.armedWake) return

    const attached = new AttachedAutoScheduler(
      store,
      (record, signal) =>
        resumeAutoContinuation(
          opts, projectDir, record, signal, claimOwner,
          steerControl?.hooks,
        ),
      {
        cancelActiveAbort: reason => reason === userCancelReason,
        onEvent: message => {
          if (opts.json) console.log(JSON.stringify({ type: 'auto_attached', message }))
          else process.stderr.write(`${message}\n`)
        },
      },
    )
    const outcome = await attached.run(initial.armedWake, abort.signal)
    if (outcome === 'cancelled') {
      await cancelAttachedAutoSession(
        store,
        projectDir,
        initial.sessionId ?? initial.armedWake.sessionId,
      )
      if (!opts.json) {
        process.stderr.write(
          `${dim('当前 Auto 会话及其定时恢复已取消；下次命令会创建全新会话。')}\n`,
        )
      }
    } else if (!opts.json && outcome === 'detached') {
      process.stderr.write(
        `${dim('当前窗口已停止等待；wake 保留在持久队列中，可由 auto-scheduler 接管。')}\n`,
      )
    }
  } finally {
    // Must run before we return, or the shell is left in raw mode.
    steerControl?.dispose()
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}

async function cancelAttachedAutoSession(
  store: AutoContinuationStore,
  projectDir: string,
  sessionId: string,
): Promise<void> {
  await store.cancelSession(sessionId)
  await updateAutoCheckpointWithStatus(projectDir, sessionId, {
    stopReason: 'cancelled_by_user',
    pendingWake: null,
  })
}

/**
 * Like parsePositiveIntOption but accepts 0, which these two flags use to mean
 * "disable this behaviour" (`--idle-exit-ms 0` = never exit on an empty queue,
 * `--stale-wake-ms 0` = never expire a wake).
 */
function parseNonNegativeIntOption(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer (got "${value}")`)
  }
  return parsed
}

function parsePositiveIntOption(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer (got "${value}")`)
  }
  return parsed
}

