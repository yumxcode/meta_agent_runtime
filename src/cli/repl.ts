/**
 * cli/repl — the interactive session loop.
 *
 * Owns stdin: readline wiring, bracketed paste, Shift+Enter newlines, Ctrl+C /
 * Ctrl+G handling, slash-command dispatch, and the per-turn call into
 * streamPrompt. Everything a slash command actually DOES lives in ./commands/*;
 * this file decides when to call it.
 *
 * Extracted from cli/index.ts, which had grown past 6,000 lines with this
 * function alone accounting for ~800 of them.
 */
import * as readline from 'node:readline'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { resolve, join, basename } from 'node:path'
import { existsSync } from 'node:fs'
import { SessionRouter } from '../routing/SessionRouter.js'
import { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import { isAutonomousMode } from '../core/modes.js'
import type { SessionMode } from '../core/modes.js'
import { RuntimeEnv } from '../infra/env/RuntimeEnv.js'
import { META_AGENT_HOME } from '../core/metaAgentHome.js'
import { SessionStore } from '../core/SessionStore.js'
import type { ConversationMessage } from '../core/types.js'
import { HardwareProfile } from '../robotics/HardwareProfile.js'
import { getMemoryPendingStore, ensureMemoryPendingLoaded } from '../core/memory/MemoryPendingStore.js'
import { PasteAccumulator, BRACKETED_PASTE_ENABLE, BRACKETED_PASTE_DISABLE } from './pasteAccumulator.js'
import { sanitizeTerminalPreview, sanitizeTerminalText } from './terminalSanitizer.js'
import { formatLocalClock, formatLocalTimestamp } from '../loop/localTime.js'
import { disposeMcpClients } from '../tools/mcp/index.js'
import { getModelProtocol, resolveProvider } from '../providers/registry.js'
import { loadModelConfig } from '../core/config/ConfigService.js'
import {
  c, bold, cyan, dim, gray, green, red, yellow, isTTY, terminalText,
  safeStdoutWrite, pauseActiveThinkingMeter, setActiveThinkingMeterSuppressed,
} from './term.js'
import { askQuestion, isNativeQuestionActive, confirmWorkspace } from './prompts.js'
import { selectHardwareProfile, buildHardwareSystemPrompt } from './hardware.js'
import { makeRouter } from './router.js'
import { streamPrompt, getCliMaxVisibleChars, type SteerHooks } from './stream.js'
import {
  sessionDisplayTitle, runSessionPicker, persistSessionSnapshot, armAutoContinuation,
} from './sessionFlow.js'
import { streamExperienceSummary, generateSessionTitle } from './sideCalls.js'
import { formatAge } from './transcript.js'
import {
  reviewPendingExperiences, reviewPendingMemories,
  reviewPendingPrinciples, reviewPendingPhysicalAnchors,
} from './commands/review.js'
import { makeDeletionAdapter, handleDeleteSubcommand } from './commands/deletion.js'
import {
  formatTeamState, formatTeamLog, formatTeamWatcherEvents, teamEventKey,
  runTeamEntryGuide, getTeamController, offerTeamPush, printTeamPublishHint,
  handleTeamCommand, type TeamCliController,
} from './commands/team.js'
import { ensureMcpServerInstructions } from './mcpInstructions.js'
import { assertApiKeyConfigured } from './keys.js'
import { DEFAULT_CLI_MAX_TURNS, AUTO_CLI_MAX_TURNS } from './limits.js'
import { printHelp, VERSION, type CliOptions } from './args.js'
import { readAutoCheckpoint } from '../core/auto/AutoCheckpointStore.js'
import { createStandardTools } from '../tools/index.js'
import { fallbackSessionTitle } from './sideCalls.js'
import { ExperiencePendingStore } from '../robotics/ExperiencePendingStore.js'
import { ExperienceStore } from '../robotics/ExperienceStore.js'
import { PhysicalAnchorStore } from '../robotics/PhysicalAnchorStore.js'
import { PrincipleStore } from '../robotics/PrincipleStore.js'
import type { StreamPromptResult } from './stream.js'

const PASTE_FALLBACK_COALESCE_MS = 80
const PASTE_NOTICE_DEBOUNCE_MS = 250
const PASTE_NOTICE_MIN_CHARS = 80
const PASTE_NOTICE_MIN_LINES = 3
const SHIFT_ENTER_SEQUENCES = [
  '\x1b[13;2u',
  '\x1b[13;2~',
  '\x1b[27;2;13~',
]

// ── Terminal primitives ───────────────────────────────────────────────────────
// Colours, sanitised output, stdout backpressure and the thinking-meter
// registry live in ./term.ts so command modules can render without importing
// the REPL. See the note at the top of that file.

class ReadlineOutput extends Writable {
  private muted = false
  private muteDepth = 0
  private passthroughDepth = 0
  private unmuteScheduled = false
  readonly isTTY: boolean | undefined

  constructor(private readonly target: NodeJS.WriteStream) {
    super()
    this.isTTY = target.isTTY
  }

  get columns(): number | undefined { return this.target.columns }
  get rows(): number | undefined { return this.target.rows }

  beginMute(): void {
    this.muteDepth++
  }

  endMute(): void {
    this.muteDepth = Math.max(0, this.muteDepth - 1)
  }

  withPassthrough(fn: () => void): void {
    this.passthroughDepth++
    try {
      fn()
    } finally {
      this.passthroughDepth = Math.max(0, this.passthroughDepth - 1)
    }
  }

  muteForCurrentInput(): void {
    this.muted = true
    if (this.unmuteScheduled) return
    this.unmuteScheduled = true
    setImmediate(() => {
      this.muted = false
      this.unmuteScheduled = false
    })
  }

  _write(
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.passthroughDepth === 0 && (this.muted || this.muteDepth > 0)) {
      callback()
      return
    }
    const done = (err?: Error | null) => callback(err ?? undefined)
    if (this.target.write(chunk, encoding)) done()
    else this.target.once('drain', done)
  }
}




// ── Interactive REPL ──────────────────────────────────────────────────────────

export async function runRepl(opts: CliOptions): Promise<void> {
  let hardwareProfileText = ''

  // ── Workspace confirmation (REPL only, single-turn skips for scripting) ──
  if (!opts.json && isTTY) {
    const needsStartupPrompt = !opts.workspace || opts.mode === 'robotics'
    const startupRl = needsStartupPrompt
      ? createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY })
      : undefined
    try {
      if (!opts.workspace) {
        opts.workspace = await confirmWorkspace(process.cwd(), startupRl)
      }
      console.log(green(`✓ 工作目录: ${opts.workspace}\n`))

      // ── Auto-mode resume banner ───────────────────────────────────────────
      // Surface the prior auto checkpoint (goal / pending todos / active
      // sub-agents) so a resumed unattended run shows where it left off.
      if (opts.mode === 'auto' && opts.resume && opts.resume !== 'last') {
        const cp = readAutoCheckpoint(opts.workspace, opts.resume)
        if (cp) {
          const lines = [yellow('↻ 恢复 auto 会话 — 上次进度:')]
          if (cp.goal) lines.push(`  目标: ${cp.goal.slice(0, 200)}`)
          if (cp.stopReason) lines.push(`  上次停因: ${cp.stopReason}`)
          if (cp.pendingTodos?.length) lines.push(`  待办(${cp.pendingTodos.length}): ${cp.pendingTodos.slice(0, 5).join('；')}`)
          if (cp.activeSubAgentIds?.length) lines.push(`  活跃子代理: ${cp.activeSubAgentIds.join(', ')}`)
          if (typeof cp.turnCount === 'number') lines.push(`  已进行轮次: ${cp.turnCount}`)
          console.log(lines.join('\n') + '\n')
        }
      }

      // ── Hardware profile selection (robotics mode only) ───────────────────
      if (opts.mode === 'robotics') {
        const hp = new HardwareProfile()
        const selected = await selectHardwareProfile(hp, opts.workspace, startupRl)
        opts.hardwareId      = selected.name || undefined
        hardwareProfileText  = selected.profileText
      }
    } finally {
      startupRl?.close()
    }
  } else if (!opts.workspace) {
    // Non-TTY / json mode: default to cwd silently
    opts.workspace = process.cwd()
  }

  if (!opts.json) {
    const debugDir = opts.debug
      ? join(META_AGENT_HOME, 'debug', '<sessionId>')
      : ''
    console.log(
      `${bold('meta-agent')}  ${dim(`v${VERSION}`)}\n` +
      `Mode: ${cyan(opts.mode)}` +
      (opts.hardwareId ? `  ${dim('hw:')} ${cyan(opts.hardwareId)}` : '') +
      (opts.yes ? `  ${yellow('[AUTO-APPROVE]')}` : '') +
      (opts.debug ? `  ${yellow('[DEBUG]')}` : '') +
      `  ${dim('(type /help for commands, Ctrl+D to quit)')}\n`,
    )
    if (opts.debug) {
      console.log(
        `${yellow('⚙  调试模式已启用')} — 每轮 LLM 完整输入/输出写入：\n` +
        `   ${cyan(debugDir)}\n` +
        `   ${dim('(<sessionId> 在首次提交后确定)')}\n`,
      )
    }
  }

  // Create rl BEFORE router so makeRouter can capture it in beforeToolCall.
  // The guard hook uses this interface; creating it later would mean the first
  // router is built without a guard (before the first `/clear`).
  const PROMPT_YOU = `\n${bold(cyan('you'))} › `
  const rlOutput = new ReadlineOutput(process.stdout)
  const rl = createInterface({
    input:  process.stdin,
    output: rlOutput,
    prompt: PROMPT_YOU,
    terminal: isTTY,
    historySize: 100,
  })

  // ── Session resume ────────────────────────────────────────────────────────
  let resumedMessages: ConversationMessage[] = []
  // The picked session's id — forwarded to RoboticsSession as resumeSessionId so
  // R5 binds to THIS exact session's milestone bucket (findBySession) rather than
  // the most recently active session in the workspace.
  let resumedSessionId: string | undefined
  if (!opts.json && isTTY) {
    if (opts.resume) {
      // Explicit --resume <id> or --resume last
      let targetId = opts.resume
      if (targetId === 'last') {
        const sessions = await SessionStore.listSessions(1, { workspace: opts.workspace })
        targetId = sessions[0]?.sessionId ?? ''
      }
      if (targetId) {
        const meta = await SessionStore.getSession(targetId)
        if (meta && meta.workspace !== opts.workspace) {
          console.log(
            yellow(`⚠  会话 ${targetId.slice(0, 8)}… 属于其他 workspace，已拒绝恢复。`) + '\n' +
            dim(`当前: ${opts.workspace ?? '(unset)'}`) + '\n' +
            dim(`会话: ${meta.workspace ?? '(unknown)'}`) + '\n',
          )
        } else {
          resumedMessages = await SessionStore.loadHistory(targetId)
          resumedSessionId = targetId
          // Restore the mode from the saved session. An autonomous mode (auto /
          // simple_auto) must never run over a history produced in a
          // NON-autonomous mode (agentic / campaign / robotics): the workspace
          // jail, auto-approval, and tool-set posture differ from what the saved
          // turns assumed. Use isAutonomousMode on BOTH sides so the rule covers
          // every autonomous flavour, not just 'auto'.
          if (
            meta?.mode &&
            (!opts.modeExplicit || (isAutonomousMode(opts.mode) && !isAutonomousMode(meta.mode)))
          ) {
            opts.mode = meta.mode as CliOptions['mode']
            opts.modeExplicit = true
          }
        }
        if (resumedMessages.length > 0) {
          console.log(green(`✓ 已恢复会话 ${targetId.slice(0, 8)}… (${resumedMessages.length} 条历史)\n`))
        } else if (!meta || meta.workspace === opts.workspace) {
          console.log(yellow(`⚠  找不到会话 ${targetId}，将新建会话。\n`))
        }
      }
    } else {
      // Auto-show session picker if recent sessions exist
      const sessions = await SessionStore.listSessions(1, { workspace: opts.workspace })
      if (sessions.length > 0) {
        const resumed = await runSessionPicker(rl, opts.workspace)
        if (resumed) {
          resumedMessages = resumed.messages
          resumedSessionId = resumed.sessionId
          // Restore the mode from the saved session so the router starts in the
          // correct mode instead of starting the resumed history in default agentic.
          // Same rule as above: never run an autonomous mode (auto / simple_auto /
          // simple_auto) over a non-autonomous history.
          if (
            resumed.mode &&
            (!opts.modeExplicit || (isAutonomousMode(opts.mode) && !isAutonomousMode(resumed.mode)))
          ) {
            opts.mode = resumed.mode as CliOptions['mode']
            opts.modeExplicit = true
          }
        }
      }
    }
  }

  let router: SessionRouter
  const getCurrentRouter = () => router
  router = makeRouter(opts, hardwareProfileText || undefined, rl, resumedMessages.length > 0 ? resumedMessages : undefined, getCurrentRouter, _promptLineInline, resumedSessionId)

  // Register standard tools for agentic/campaign/auto modes.
  // Robotics mode registers its own tools internally (RoboticsSession.init).
  if (opts.mode !== 'robotics') {
    const tools = await createStandardTools({
      // planModeRef MUST be the router's shared ref so enter_plan_mode /
      // exit_plan_mode flip the same object the backend's kernel permission
      // policy reads — otherwise plan mode never gates writes.
      system: {
        cwd: opts.workspace,
        mode: opts.mode,
        planModeRef: router.planModeRef,
      },
      // Main-session web_fetch is result-budgeted: full-text reading belongs in
      // isolated research sub-agents (research_dispatch), not the long-lived
      // main context. Sub-agents get an unbudgeted override via the bridge.
      network: { webFetch: { maxResultSizeChars: 8_000 } },
      // Mode-specific tool selection (auto mode excludes ask_user/send_message).
      mode: opts.mode,
    })
    for (const tool of tools) {
      router.registerTool(tool)
    }
  }
  let interrupted = false
  // Track how many messages we've already saved so append writes only new ones.
  let savedMessageCount = resumedMessages.length
  // ── Session title state ──
  // One session = one goal = one title:
  //   - NEW session → flash side-call generates the goal title after turn 1.
  //   - RESUMED session → the old title is carried over verbatim; flash is
  //     never re-invoked (re-entering a session means continuing its goal).
  //   - Flash failure → deterministic local fallback (first clause of the
  //     first user message) is written immediately so the picker always shows
  //     something concise; later flash attempts (≤3 total) may upgrade it.
  const TITLE_FLASH_MAX_ATTEMPTS = 3
  let sessionTitle: string | null = null
  let titleSource: 'flash' | 'fallback' | 'carried' | null = null
  let titleFlashAttempts = 0
  let titleGenInFlight = false
  /** sessionId the current title was last written to (resume → new id). */
  let titlePersistedFor: string | null = null
  let titlePersistedValue: string | null = null
  const resetTitleState = (): void => {
    sessionTitle = null
    titleSource = null
    titleFlashAttempts = 0
    titlePersistedFor = null
    titlePersistedValue = null
  }
  const maybeGenerateSessionTitle = (): void => {
    if (opts.json || titleGenInFlight) return
    const sessionId = router.getSessionId()
    if (!sessionId) return
    const count = router.getMessages().length
    const needFlash =
      titleSource !== 'carried' &&            // resumed sessions keep their goal title
      titleSource !== 'flash' &&              // flash title is final
      titleFlashAttempts < TITLE_FLASH_MAX_ATTEMPTS &&
      count >= 2
    const needPersist =
      sessionTitle !== null &&
      (titlePersistedFor !== sessionId || titlePersistedValue !== sessionTitle)
    if (!needFlash && !needPersist) return
    titleGenInFlight = true
    void (async () => {
      try {
        if (needFlash) {
          titleFlashAttempts++
          const title = await generateSessionTitle(router)
          if (title) {
            sessionTitle = title
            titleSource = 'flash'
          } else if (titleSource === null) {
            const fb = fallbackSessionTitle(router.getMessages())
            if (fb) {
              sessionTitle = fb
              titleSource = 'fallback'   // flash may upgrade on a later turn
            }
          }
        }
        if (sessionTitle !== null &&
            (titlePersistedFor !== sessionId || titlePersistedValue !== sessionTitle)) {
          await SessionStore.updateTitle(sessionId, sessionTitle, count)
          titlePersistedFor = sessionId
          titlePersistedValue = sessionTitle
        }
      } catch { /* best-effort */ }
      finally { titleGenInFlight = false }
    })()
  }
  // Resumed session: carry the old goal title over to the new session entry.
  if (resumedSessionId) {
    const resumedMeta = await SessionStore.getSession(resumedSessionId)
    const carried = resumedMeta?.title?.trim()
    if (carried) {
      sessionTitle = carried
      titleSource = 'carried'
    }
  }
  // Track whether the real debug dir has been printed (becomes known after first submit)
  let debugDirShown = false
  // Bounded: a weeks-long robotics session polls every 45s and would otherwise
  // accumulate one key per team event forever. When the cap is hit the oldest
  // half is pruned (Set preserves insertion order); re-notifying a months-old
  // event once is harmless, unbounded growth is not.
  const MAX_SEEN_TEAM_EVENTS = 2_000
  const seenTeamReminderEvents = new Set<string>()
  const pruneSeenTeamEvents = (): void => {
    if (seenTeamReminderEvents.size <= MAX_SEEN_TEAM_EVENTS) return
    const dropCount = Math.floor(MAX_SEEN_TEAM_EVENTS / 2)
    let dropped = 0
    for (const key of seenTeamReminderEvents) {
      if (dropped++ >= dropCount) break
      seenTeamReminderEvents.delete(key)
    }
  }
  let teamReminderInitialized = false
  let teamReminderRunning = false
  // Only show Team 动态 notifications after the user explicitly uses a /team command
  // in this session. Prevents noise for users with a team.json who aren't using team mode.
  let teamModeUsed = false
  // Guards against showing the hardware-binding prompt more than once per session
  // (set to true after the first prompt, even if the user skips it).
  let hardwareBindingPrompted = false
  const persistCurrentSession = async (currentInput: string): Promise<void> => {
    savedMessageCount = await persistSessionSnapshot({
      router,
      opts,
      currentInput,
      savedMessageCount,
      skipJson: true,
    })
  }
  let interactiveInputActive = false
  const setInteractiveActive = (v: boolean) => { interactiveInputActive = v }
  const teamReminderTimer = (!opts.json && isTTY)
    ? setInterval(() => {
        if (exiting || teamReminderRunning || interactiveInputActive || !router.ready || router.mode !== 'robotics') return
        const controller = router.getRoboticsTeamController()
        if (!controller?.teamWatcherPoll) return
        teamReminderRunning = true
        void (async () => {
          try {
            const events = await controller.teamWatcherPoll?.() ?? []
            const fresh = events.filter(event => {
              const key = teamEventKey(event)
              const seen = seenTeamReminderEvents.has(key)
              seenTeamReminderEvents.add(key)
              return !seen
            })
            pruneSeenTeamEvents()
            if (!teamReminderInitialized) {
              teamReminderInitialized = true
              return
            }
            if (fresh.length > 0 && teamModeUsed) {
              process.stdout.write(`\n${yellow('Team 动态')}\n`)
              fresh.slice(-5).forEach(event => {
                process.stdout.write(`  - ${sanitizeTerminalText(event.message)}\n`)
              })
              process.stdout.write(`${dim('使用 /team status、/team sync 或 /team pull 查看详情。')}\n`)
              rl.prompt(true)
            }
          } catch {
            // Advisory reminder only; never disrupt the REPL.
          } finally {
            teamReminderRunning = false
          }
        })()
      }, 45_000)
    : null
  if (teamReminderTimer?.unref) teamReminderTimer.unref()

  // Handle Ctrl+C: first press interrupts, second exits
  let ctrlCPressed = false
  let exiting = false
  /**
   * Timestamp until which incoming readline lines should be silently discarded.
   *
   * When the user presses Ctrl+C to interrupt an in-flight LLM call, the
   * readline buffer may already contain lines that were pasted BEFORE the
   * interrupt (e.g. the remaining lines of a multi-line paste).  Without this
   * drain window those buffered lines fire immediately after the interrupt
   * clears, causing the REPL to auto-submit them — which looks like the CLI
   * is "sending messages on its own" after Ctrl+C.
   *
   * Set to Date.now() + 300 ms on every SIGINT so the main loop skips any
   * lines that arrive within that window.  300 ms is well above the ~0 ms
   * that buffered paste lines need to drain, yet well below the ~500+ ms
   * a human needs to type the next keystroke.
   */
  let ignoreInputUntil = 0
  // ── Multi-line paste accumulator ─────────────────────────────────────────
  //
  // A terminal delivers pasted text to stdin with its internal \n bytes intact,
  // and readline cannot tell those apart from the \n produced by pressing
  // Enter — so it fires a 'line' event for every embedded newline.  We
  // distinguish the two by inspecting the raw stdin chunk that triggered each
  // 'line' event, with a short fallback coalesce window for terminals that
  // split a markerless paste so a paste-internal newline arrives alone:
  //
  //   • Bare Enter  — the chunk is ONLY \r / \n.  Can only come from the user
  //                   pressing Enter → submit everything accumulated so far.
  //   • Paste line  — the chunk also contains text, so its newline was pasted,
  //                   not typed → accumulate and keep waiting for a real Enter.
  //
  // This replaces an earlier 300 ms debounce that auto-submitted a paste ending
  // in \n.  That timer raced the user: pausing >300 ms after a paste and then
  // typing more caused the paste to submit on its own and the typed tail to
  // submit as a second message (the "auto-replied before I pressed Enter /
  // replied twice" bug). Waiting for an explicit bare Enter, then holding only
  // ambiguous markerless flushes for a few milliseconds, removes the race while
  // normal typing is unaffected because its first Enter is always an
  // unambiguous bare-newline chunk with no buffered pasted content.
  //
  // We prepend the stdin 'data' listener so onData() records the chunk BEFORE
  // readline emits the resulting 'line' event(s) in the same call stack.
  // The SIGINT drain window (ignoreInputUntil) is honored in both handlers.

  let _pendingOrderedSubmit: string | null = null
  const _paste = new PasteAccumulator({
    coalesceMs: PASTE_FALLBACK_COALESCE_MS,
    onDeferredSubmit: (submit) => {
      if (Date.now() < ignoreInputUntil) return
      const orderedSubmit = _pendingOrderedSubmit ?? submit
      finishPasteNotice()
      restorePromptAfterPasteFlush()
      _enqueueInput(orderedSubmit)
    },
  })
  type PasteDisplaySegment = {
    placeholder: string
    chars: number
    text: string
    visibleTail: string
  }

  let _pasteNoticeChars = 0
  let _pasteNoticeTimer: ReturnType<typeof setTimeout> | null = null
  let _pasteOutputMuted = false
  let _pasteApplySerial = 0
  let _pasteCollecting = false
  let _pendingPasteTail = ''
  let _pendingPasteText = ''
  let _activePasteSegment: PasteDisplaySegment | null = null
  const _pasteSegments: PasteDisplaySegment[] = []
  /**
   * Snapshot of readline's line/cursor taken the instant a paste collection
   * starts (from the PREPENDED stdin listener, i.e. before readline ingests the
   * chunk). A MULTI-LINE paste makes readline consume that pre-paste line —
   * typed prefix and any earlier segment placeholders — into an intermediate
   * 'line' event, leaving only the paste tail in rl.line. Without this snapshot
   * the placeholder renderer overwrites the line with a bare [已粘贴N字] (typed
   * chars vanish from display) AND the Enter-time ordered submit — which
   * expands placeholders from the restored line and DISCARDS the accumulator
   * copy — silently drops the typed prefix from the submitted message.
   */
  let _prePasteLine = ''
  let _prePasteCursor = 0

  function beginPasteOutputMute(): void {
    if (_pasteOutputMuted) return
    rlOutput.beginMute()
    _pasteOutputMuted = true
  }

  function endPasteOutputMute(): void {
    if (!_pasteOutputMuted) return
    rlOutput.endMute()
    _pasteOutputMuted = false
  }

  function charCount(text: string): number {
    return Array.from(text).length
  }

  function pasteTail(text: string): string {
    const parts = text.split(/\r\n|\r|\n/)
    return parts[parts.length - 1] ?? ''
  }

  function recordPasteDisplayText(text: string): void {
    if (!_pasteCollecting) {
      _pasteCollecting = true
      _pasteNoticeChars = 0
      _pendingPasteTail = ''
      _pendingPasteText = ''
      _activePasteSegment = null
      // This runs from the prepended stdin listener, BEFORE readline ingests
      // the paste chunk — rl.line still holds exactly what preceded the paste.
      const rlm = mutableReadline()
      _prePasteLine = rlm.line ?? ''
      _prePasteCursor = Math.min(rlm.cursor ?? _prePasteLine.length, _prePasteLine.length)
    }
    _pasteNoticeChars += charCount(text)
    _pendingPasteText += text
    const nextTail = /[\r\n]/.test(text)
      ? pasteTail(text)
      : `${_pendingPasteTail}${text}`
    _pendingPasteTail = nextTail
    if (_activePasteSegment) {
      _activePasteSegment.chars = _pasteNoticeChars
      _activePasteSegment.text = _pendingPasteText
      _activePasteSegment.visibleTail = nextTail
    }
  }

  function ensureActivePasteSegment(): PasteDisplaySegment {
    if (_activePasteSegment) return _activePasteSegment
    const segment: PasteDisplaySegment = {
      placeholder: '',
      chars: _pasteNoticeChars,
      text: _pendingPasteText,
      visibleTail: _pendingPasteTail,
    }
    _pasteSegments.push(segment)
    _activePasteSegment = segment
    return segment
  }

  function lineBreakCount(text: string): number {
    return (text.match(/\r\n|\r|\n/g) ?? []).length
  }

  function shouldShowPasteNotice(pasteInfo: { source: string; text: string }): boolean {
    if (pasteInfo.source === 'none') return false
    if (pasteInfo.source === 'markerless-bare-newline') return _pasteNoticeChars > 0
    const textChars = charCount(pasteInfo.text)
    if (_pasteNoticeChars >= PASTE_NOTICE_MIN_CHARS) return true
    if (textChars >= PASTE_NOTICE_MIN_CHARS) return true
    return lineBreakCount(pasteInfo.text) >= PASTE_NOTICE_MIN_LINES
  }

  function isPostPasteImeCommit(pasteInfo: { source: string; text: string }): boolean {
    return _pasteSegments.length > 0 &&
      !_pasteCollecting &&
      !_pasteOutputMuted &&
      pasteInfo.source === 'bracketed' &&
      charCount(pasteInfo.text) < PASTE_NOTICE_MIN_CHARS &&
      lineBreakCount(pasteInfo.text) === 0
  }

  function schedulePasteNotice(text: string): void {
    if (charCount(text) === 0 && _pasteNoticeChars === 0) return
    if (_activePasteSegment?.placeholder) {
      const serial = ++_pasteApplySerial
      setImmediate(() => {
        if (serial === _pasteApplySerial && _activePasteSegment) {
          applyPastePlaceholder(_activePasteSegment)
        }
      })
      return
    }
    if (_pasteNoticeTimer) clearTimeout(_pasteNoticeTimer)
    _pasteNoticeTimer = setTimeout(() => { renderPasteNotice() }, PASTE_NOTICE_DEBOUNCE_MS)
    _pasteNoticeTimer.unref?.()
  }

  function renderPasteNotice(): void {
    if (_pasteNoticeTimer) clearTimeout(_pasteNoticeTimer)
    _pasteNoticeTimer = null
    if (_pasteNoticeChars <= 0 || Date.now() < ignoreInputUntil) return
    applyPastePlaceholder(ensureActivePasteSegment())
  }

  function applyPastePlaceholder(segment: PasteDisplaySegment): void {
    const mutableRl = rl as readline.Interface & {
      line?: string
      cursor?: number
      _refreshLine?: () => void
    }
    const current = mutableRl.line ?? ''
    const nextPlaceholder = `[已粘贴${segment.chars}字]`
    let cursorAt = -1
    if (segment.placeholder && current.includes(segment.placeholder)) {
      mutableRl.line = current.replace(segment.placeholder, nextPlaceholder)
    } else {
      let visiblePasteChars = 0
      const max = Math.min(current.length, segment.visibleTail.length)
      for (let len = max; len > 0; len--) {
        if (current.slice(current.length - len) === segment.visibleTail.slice(0, len)) {
          visiblePasteChars = len
          break
        }
      }
      let prefix = visiblePasteChars > 0
        ? current.slice(0, current.length - visiblePasteChars)
        : current
      let suffix = ''
      // Multi-line paste: readline consumed the pre-paste line (typed prefix +
      // earlier placeholders) into an intermediate 'line' event, so `current`
      // holds only the paste tail. Re-anchor the placeholder inside the
      // snapshotted pre-paste line — otherwise the typed prefix vanishes from
      // the display AND from the ordered submit (the accumulator copy that
      // still contains it is discarded in favour of the restored line).
      if (lineBreakCount(segment.text) > 0 && _prePasteLine && !prefix.includes(_prePasteLine)) {
        suffix = _prePasteLine.slice(_prePasteCursor)
        prefix = `${_prePasteLine.slice(0, _prePasteCursor)}${prefix}`
      }
      mutableRl.line = `${prefix}${nextPlaceholder}${suffix}`
      // Keep the insertion point right after the pasted block (before any text
      // that sat after the cursor when the paste began).
      cursorAt = `${prefix}${nextPlaceholder}`.length
    }
    segment.placeholder = nextPlaceholder
    mutableRl.cursor = cursorAt >= 0 ? cursorAt : mutableRl.line.length
    rlOutput.withPassthrough(() => { mutableRl._refreshLine?.() })
  }

  function restoreHiddenPasteLine(line: string): string {
    let restored = line
    for (const segment of _pasteSegments) {
      if (!segment.placeholder || !restored.includes(segment.placeholder)) continue
      restored = restored.replace(segment.placeholder, segment.text)
    }
    return restored
  }

  // ── Placeholder-aware editing ─────────────────────────────────────────────
  //
  // The [已粘贴N字] placeholder is literal text in readline's buffer, but it
  // STANDS FOR the hidden pasted content — so it must edit like a single
  // token. Without this, backspace eats the placeholder one CHARACTER at a
  // time: the user "deletes" for a while, the hidden paste text is never
  // dropped, and once the placeholder string is damaged the Enter-time
  // restore no longer matches — the submit silently carries the mangled
  // literal "[已粘贴50" instead of either the paste or its deletion.
  //
  //   • Backspace / forward-delete touching a placeholder deletes the WHOLE
  //     block (placeholder + hidden text + its accumulator lines).
  //   • Any other edit that leaves a placeholder partially damaged is undone
  //     (line restored) — corruption is never representable.
  //   • An edit that removes a placeholder cleanly (e.g. kill-line) drops the
  //     segment with it.

  const BACKSPACE_CHUNKS = new Set(['\x7f', '\b'])
  const FORWARD_DELETE_CHUNK = '\x1b[3~'

  /** The placeholder span a BS/DEL keypress at `cursor` should atomically remove. */
  function placeholderSpanFor(
    line: string,
    cursor: number,
    kind: 'bs' | 'del',
  ): { segment: PasteDisplaySegment; start: number; end: number } | null {
    for (const segment of _pasteSegments) {
      if (!segment.placeholder) continue
      let start = line.indexOf(segment.placeholder)
      while (start !== -1) {
        const end = start + segment.placeholder.length
        // BS deletes the char BEFORE the cursor → fires when that char is any
        // part of the placeholder; DEL deletes AT the cursor → same, shifted.
        if (kind === 'bs' ? cursor > start && cursor <= end : cursor >= start && cursor < end) {
          return { segment, start, end }
        }
        start = line.indexOf(segment.placeholder, start + 1)
      }
    }
    return null
  }

  function dropPasteSegment(segment: PasteDisplaySegment): void {
    const i = _pasteSegments.indexOf(segment)
    if (i >= 0) _pasteSegments.splice(i, 1)
    // The paste's intermediate lines live in the accumulator (multi-line paste);
    // deleting the block must delete them too, or Enter would resurrect them.
    _paste.clear()
  }

  /**
   * Runs in the prepended stdin listener (BEFORE readline edits the line), so
   * the pre-edit line/cursor can be captured; the correction is applied on
   * setImmediate, after readline has processed the same chunk.
   */
  function handlePasteAwareEditChunk(chunk: string): void {
    if (_pasteSegments.length === 0) return
    const before = mutableReadline()
    const beforeLine = before.line ?? ''
    const beforeCursor = Math.min(before.cursor ?? beforeLine.length, beforeLine.length)
    if (!_pasteSegments.some(s => s.placeholder && beforeLine.includes(s.placeholder))) return
    const kind = BACKSPACE_CHUNKS.has(chunk) ? 'bs' : chunk === FORWARD_DELETE_CHUNK ? 'del' : null
    const hit = kind ? placeholderSpanFor(beforeLine, beforeCursor, kind) : null
    setImmediate(() => {
      const rlm = mutableReadline()
      if (hit) {
        // Atomic delete: one keypress removes the whole pasted block.
        rlm.line = beforeLine.slice(0, hit.start) + beforeLine.slice(hit.end)
        rlm.cursor = hit.start
        dropPasteSegment(hit.segment)
        rlOutput.withPassthrough(() => { rlm._refreshLine?.() })
        return
      }
      // Integrity guard for every other editing key.
      const line = rlm.line ?? ''
      for (const segment of [..._pasteSegments]) {
        if (!segment.placeholder || !beforeLine.includes(segment.placeholder)) continue
        if (line.includes(segment.placeholder)) continue
        if (beforeLine.replace(segment.placeholder, '') === line) {
          dropPasteSegment(segment)   // clean removal (e.g. kill-line on a lone block)
          continue
        }
        // Partial damage — undo the edit rather than let a mangled placeholder
        // corrupt the submit.
        rlm.line = beforeLine
        rlm.cursor = beforeCursor
        rlOutput.withPassthrough(() => { rlm._refreshLine?.() })
        return
      }
    })
  }

  function mutableReadline(): readline.Interface & {
    line?: string
    cursor?: number
    _refreshLine?: () => void
  } {
    return rl as readline.Interface & {
      line?: string
      cursor?: number
      _refreshLine?: () => void
    }
  }

  function insertReadlineText(text: string): void {
    const mutableRl = mutableReadline()
    const line = mutableRl.line ?? ''
    const cursor = mutableRl.cursor ?? line.length
    mutableRl.line = `${line.slice(0, cursor)}${text}${line.slice(cursor)}`
    mutableRl.cursor = cursor + text.length
    mutableRl._refreshLine?.()
  }

  function removeShiftEnterSequencesFromReadline(): void {
    const mutableRl = mutableReadline()
    const line = mutableRl.line ?? ''
    let cleaned = line
    for (const seq of SHIFT_ENTER_SEQUENCES) cleaned = cleaned.split(seq).join('')
    if (cleaned === line) return
    mutableRl.line = cleaned
    mutableRl.cursor = Math.min(mutableRl.cursor ?? cleaned.length, cleaned.length)
  }

  function handleShiftEnterChunk(chunk: string): boolean {
    let count = 0
    for (const seq of SHIFT_ENTER_SEQUENCES) {
      let idx = chunk.indexOf(seq)
      while (idx !== -1) {
        count++
        idx = chunk.indexOf(seq, idx + seq.length)
      }
    }
    if (count === 0) return false
    const before = mutableReadline()
    const beforeLine = before.line ?? ''
    const beforeCursor = before.cursor ?? beforeLine.length
    rlOutput.muteForCurrentInput()
    setImmediate(() => {
      const mutableRl = mutableReadline()
      mutableRl.line = beforeLine
      mutableRl.cursor = beforeCursor
      insertReadlineText('\n'.repeat(count))
      removeShiftEnterSequencesFromReadline()
    })
    return true
  }

  function finishPasteNotice(): void {
    if (pasteNoticeActive()) renderPasteNotice()
    _pasteNoticeTimer = null
    _pasteNoticeChars = 0
    _pendingPasteTail = ''
    _pendingPasteText = ''
    _prePasteLine = ''
    _prePasteCursor = 0
    _pasteCollecting = false
    _activePasteSegment = null
    _pasteSegments.length = 0
    _pendingOrderedSubmit = null
    _pasteApplySerial++
    endPasteOutputMute()
  }

  function clearPasteNotice(): void {
    if (_pasteNoticeTimer) clearTimeout(_pasteNoticeTimer)
    _pasteNoticeTimer = null
    _pasteNoticeChars = 0
    _pendingPasteTail = ''
    _pendingPasteText = ''
    _prePasteLine = ''
    _prePasteCursor = 0
    _pasteCollecting = false
    _activePasteSegment = null
    _pasteSegments.length = 0
    _pendingOrderedSubmit = null
    _pasteApplySerial++
    endPasteOutputMute()
  }

  function endCurrentPasteDisplaySegment(): void {
    if (_pasteNoticeTimer) clearTimeout(_pasteNoticeTimer)
    _pasteNoticeTimer = null
    _pasteNoticeChars = 0
    _pendingPasteTail = ''
    _pendingPasteText = ''
    _prePasteLine = ''
    _prePasteCursor = 0
    _pasteCollecting = false
    _activePasteSegment = null
    _pasteApplySerial++
    endPasteOutputMute()
  }

  function discardCurrentPasteCandidate(): void {
    if (_pasteNoticeTimer) clearTimeout(_pasteNoticeTimer)
    _pasteNoticeTimer = null
    _pasteNoticeChars = 0
    _pendingPasteTail = ''
    _pendingPasteText = ''
    _prePasteLine = ''
    _prePasteCursor = 0
    _pasteCollecting = false
    _activePasteSegment = null
    _pasteApplySerial++
    endPasteOutputMute()
  }

  function pasteNoticeActive(): boolean {
    return _pasteNoticeTimer !== null || _pasteOutputMuted
  }

  // Ask the terminal to wrap pastes in ESC[200~ / ESC[201~ markers so pasted
  // newlines can be told apart from a typed Enter with certainty. Restore the
  // terminal's default on every exit path so we never leave the mode dangling.
  let _bracketedPasteOn = false
  const enableBracketedPaste = (): void => {
    if (isTTY && !_bracketedPasteOn) {
      process.stdout.write(BRACKETED_PASTE_ENABLE)
      _bracketedPasteOn = true
    }
  }
  const disableBracketedPaste = (): void => {
    if (_bracketedPasteOn) {
      process.stdout.write(BRACKETED_PASTE_DISABLE)
      _bracketedPasteOn = false
    }
  }
  enableBracketedPaste()

  const _inputQueue: string[] = []
  const _inputResolvers: Array<(v: string | null) => void> = []
  let _rlClosed = false

  // ── Mid-turn steering (Ctrl+G) ────────────────────────────────────────────
  // While a turn is streaming, Ctrl+G (BEL, 0x07) arms a one-shot "correction"
  // prompt. The byte is delivered immediately because readline keeps the TTY in
  // raw mode, so the stdin 'data' listener below sees it the instant it's typed.
  // We never abort the model — the correction is injected at the next kernel
  // loop boundary via router.steer().
  let _isStreaming = false
  let _steerArmed = false
  let _steerNotify: (() => void) | null = null
  // True only while readline owns the `steer ›` prompt during a steer input, so
  // the paste-driven prompt sync below doesn't clobber it back to `you ›`.
  let _steerInputActive = false
  // True while a wizard (e.g. the hardware-profile prompts) owns the line via
  // rl.question(). Unlike interactiveInputActive (used by _promptLineInline,
  // which reads through the shared paste queue), a wizard reads input NATIVELY
  // through readline — so the stdin 'data' handler must NOT feed the paste
  // accumulator or reset the prompt while it's set, and the 'line' handler must
  // not enqueue. Otherwise the data handler clobbers the wizard's question
  // prompt with `you ›` on every keystroke, and the accumulator is left in a
  // half-buffered state that swallows the first real line afterward (the
  // "wizard hint vanishes, then the prompt freezes" bug).
  let _wizardActive = false
  const _armSteer = (): void => {
    _steerArmed = true
    const notify = _steerNotify
    _steerNotify = null
    notify?.()
  }
  const _steerPrompt = `${bold(cyan('steer'))} › `
  const steerHooks = {
    waitArmed: (): Promise<void> =>
      _steerArmed ? Promise.resolve() : new Promise<void>(resolve => { _steerNotify = resolve }),
    isArmed: (): boolean => _steerArmed,
    consume: (): void => { _steerArmed = false; _steerNotify = null },
    beginInput: (): void => {
      // readline now renders + redraws THIS prompt as the user types, so the
      // line stays a `steer ›` line instead of reverting to `you ›`.
      _steerInputActive = true
      setInteractiveActive(true)
      rl.setPrompt(_steerPrompt)
      rl.prompt()
    },
    read: (): Promise<string | null> => _nextInput(),
    endInput: (): void => {
      _steerInputActive = false
      setInteractiveActive(false)
      rl.setPrompt(PROMPT_YOU)
    },
  }

  function _enqueueInput(combined: string): void {
    if (_inputResolvers.length > 0) {
      _inputResolvers.shift()!(combined)
    } else {
      _inputQueue.push(combined)
    }
  }

  function _nextInput(): Promise<string | null> {
    if (_rlClosed && _inputQueue.length === 0) return Promise.resolve(null)
    if (_inputQueue.length > 0) return Promise.resolve(_inputQueue.shift()!)
    return new Promise<string | null>(resolve => _inputResolvers.push(resolve))
  }

  function restorePromptAfterPasteFlush(): void {
    if (isTTY && !_steerInputActive && !interactiveInputActive) rl.setPrompt(PROMPT_YOU)
  }

  // Inline confirmation reader for mid-turn prompts (e.g. multi-agent escalation).
  // Prints the question and reads the next line through the SAME shared queue the
  // main loop uses, so the keystroke is never lost to a competing raw-stdin read.
  // Marks input active so the team-reminder timer doesn't fire over the prompt.
  async function _promptLineInline(question: string): Promise<string | null> {
    // Pause the streaming spinner first — its 120ms redraw timer would otherwise
    // erase this question on the next tick, hiding the prompt entirely. The
    // stream's event handlers re-show the meter on the next model event.
    pauseActiveThinkingMeter()
    setInteractiveActive(true)
    try {
      process.stdout.write(question)
      return await _nextInput()
    } finally {
      setInteractiveActive(false)
      if (isTTY && !_steerInputActive) rl.setPrompt(PROMPT_YOU)
    }
  }

  // Run an interactive wizard that reads input natively via rl.question() (the
  // hardware-profile prompts). While it runs we suspend the paste accumulator
  // and prompt-sync (see _wizardActive), then clear any stale chunk state and
  // restore the `you ›` prompt so the main loop's next line is classified fresh
  // and actually reaches _nextInput().
  async function runWizard<T>(fn: () => Promise<T>): Promise<T> {
    _wizardActive = true
    setInteractiveActive(true)   // also silence the team-reminder timer
    try {
      return await fn()
    } finally {
      _wizardActive = false
      setInteractiveActive(false)
      _paste.clear()
      if (isTTY) rl.setPrompt(PROMPT_YOU)
    }
  }

  // Must be prepended so it fires BEFORE readline's own 'data' handler — this
  // guarantees the chunk is recorded before any resulting 'line' event fires.
  process.stdin.prependListener('data', (buf: Buffer) => {
    // Ctrl+G during a streaming turn arms a steering correction (handled by
    // streamPrompt). Outside a turn it's ignored. We still feed the chunk to the
    // paste accumulator below — readline does not insert a BEL into the buffer.
    if (_isStreaming && buf.includes(0x07)) _armSteer()
    if (Date.now() < ignoreInputUntil) {
      _paste.resetChunk()   // SIGINT drain — don't classify against this chunk
      return
    }
    // A native readline question owns the line: let readline render and read it
    // natively. Touching the paste state or prompt here would overwrite the
    // question prompt with `you ›` and corrupt the accumulator.
    if (_wizardActive || isNativeQuestionActive(rl)) return
    if (handleShiftEnterChunk(buf.toString())) {
      _paste.resetChunk()
      return
    }
    const pasteInfo = _paste.onData(buf.toString())
    if (pasteInfo.isPaste) {
      const postPasteImeCommit = isPostPasteImeCommit(pasteInfo)
      if (postPasteImeCommit) {
        _pasteApplySerial++
        endPasteOutputMute()
      } else {
        recordPasteDisplayText(pasteInfo.text)
      }
      if (!postPasteImeCommit && shouldShowPasteNotice(pasteInfo)) {
        beginPasteOutputMute()
        rlOutput.muteForCurrentInput()
        schedulePasteNotice(pasteInfo.text)
      }
    } else if (pasteNoticeActive()) {
      renderPasteNotice()
      endCurrentPasteDisplaySegment()
      handlePasteAwareEditChunk(buf.toString())
    } else if (!_paste.buffering && _pasteCollecting) {
      discardCurrentPasteCandidate()
      handlePasteAwareEditChunk(buf.toString())
    } else {
      // Ordinary keystroke while placeholders are on the line: keep the pasted
      // blocks atomic under backspace/delete and immune to partial damage.
      handlePasteAwareEditChunk(buf.toString())
    }
    // While a multi-line paste is still being collected, blank readline's prompt
    // so the trailing partial line isn't redrawn with a second `you ›` prefix on
    // the next keystroke. Restored to PROMPT_YOU once the buffer flushes.
    if (isTTY && _steerInputActive) {
      // Some editing keys force readline to refresh the current line. Keep the
      // active prompt locked to `steer ›` for the whole correction input.
      rl.setPrompt(_steerPrompt)
    } else if (isTTY && !interactiveInputActive) {
      rl.setPrompt(_paste.buffering ? '' : PROMPT_YOU)
    }
  })

  rl.on('line', (rawLine) => {
    if (Date.now() < ignoreInputUntil) return   // SIGINT drain — silently discard
    // Native rl.question consumers handle the line via their own callback; this listener
    // must stay out of the way so it doesn't double-handle or enqueue them.
    if (_wizardActive || isNativeQuestionActive(rl)) return
    // Returns a complete message only on a bare Enter; null means "still a
    // paste in progress — accumulate and wait for the user's explicit Enter".
    const restoredLine = restoreHiddenPasteLine(rawLine)
    _pendingOrderedSubmit = _pasteSegments.length > 0 ? restoredLine : null
    const submit = _paste.onLine(restoredLine)
    if (submit !== null) {
      // Buffer flushed — restore the normal prompt for the next turn (the data
      // handler blanked it while the paste was being collected).
      const orderedSubmit = _pasteSegments.length > 0 ? restoredLine : submit
      finishPasteNotice()
      restorePromptAfterPasteFlush()
      _enqueueInput(orderedSubmit)
    }
  })

  rl.on('SIGINT', () => {
    if (ctrlCPressed) { rl.close(); return }
    ctrlCPressed = true
    router.interrupt()
    interrupted = true
    // Drain any lines already in the readline buffer so they don't auto-fire
    // as new prompts after the interrupt clears.
    ignoreInputUntil = Date.now() + 300
    // Clear any paste accumulator state so buffered content before the
    // interrupt is not submitted after the drain window expires.
    _paste.clear()
    clearPasteNotice()
    if (isTTY) rl.setPrompt(PROMPT_YOU)   // paste-collection may have blanked it
    process.stdout.write(`\n${yellow('Interrupted')} ${dim('(press Ctrl+C again to exit)')}\n`)
    setTimeout(() => { ctrlCPressed = false }, 2000)
    rl.prompt()
  })

  rl.on('close', () => {
    disableBracketedPaste()
    clearPasteNotice()
    // Signal EOF to the accumulator queue so _nextInput() unblocks
    _rlClosed = true
    // Recover any paste left in the buffer at EOF (e.g. Ctrl+D after a paste).
    const _pasteTail = _paste.drain()
    if (_pasteTail !== null) _enqueueInput(_pasteTail)
    for (const resolve of _inputResolvers) resolve(null)
    _inputResolvers.length = 0

    if (exiting) return
    exiting = true
    if (teamReminderTimer) clearInterval(teamReminderTimer)
    // Hard-exit fuse for the EOF/Ctrl+D path — same rationale as disposeAndExit.
    const hardExit = setTimeout(() => process.exit(0), 15_000)
    hardExit.unref?.()
    void (async () => {
      try {
        if (!opts.json) {
          // Show LLM-guided experience summary at session end (not per-turn).
          const pending = router.getPendingExperiences()
          const pendingCount = pending?.count ?? 0
          if (pendingCount > 0 && pending) {
            await streamExperienceSummary(router, [...pending.list()])
            console.log(
              `${yellow(`⏸  ${pendingCount} 条经验待审核`)} — ` +
              `${dim('下次在同一项目启动 robotics 模式后，可用 /experience review 继续审核。')}\n`,
            )
          }
          // Show pending physical anchor count (populated after dispose() extraction).
          // Note: we can only read the count that was already in queue before dispose();
          // the post-session Flash extraction runs inside dispose() below.
          const pendingAnchors = router.getPendingPhysicalAnchors()
          const anchorCount = pendingAnchors?.count ?? 0
          if (anchorCount > 0) {
            console.log(
              `${yellow(`⚓  ${anchorCount} 条物理锚点待审核`)} — ` +
              `${dim('下次在同一项目启动 robotics 模式后，可用 /anchor review 审核提交。')}\n`,
            )
          }
          const pendingPrinciples = router.getPendingPrinciples()
          const principleCount = pendingPrinciples?.count ?? 0
          if (principleCount > 0) {
            console.log(
              `${yellow(`⏸  ${principleCount} 条原则待审核`)} — ` +
              `${dim('下次在同一项目启动 robotics 模式后，可用 /principle review 审核提交。')}\n`,
            )
          }
          // Memory is global (all modes). Surface tool-proposed memories queued
          // this session; the post-session auto-writer runs inside dispose()
          // below and its proposals are surfaced via /memory on next launch.
          const memoryCount = getMemoryPendingStore().count
          if (memoryCount > 0) {
            console.log(
              `${yellow(`⏸  ${memoryCount} 条记忆待审核`)} — ` +
              `${dim('使用 /memory review 审核提交。')}\n`,
            )
          }
          console.log(`\n${dim('Goodbye.')}\n`)
        }
      } catch { /* best-effort — close-path errors must not block process exit */ }
      try { await router.dispose() } catch { /* best-effort */ }
      process.exit(0)
    })()
  })

  // ── Process-level cleanup handlers ───────────────────────────────────────
  // Called on graceful shutdown (SIGTERM) or unhandled crashes.
  // We await router.dispose() so RoboticsSession can cancel sub-agents,
  // stop heartbeat timers, and purge git worktrees before the process exits.
  // `router` is a `let` so the handlers always see the current router even
  // after `/clear` or `/hardware select` rebuilt it.
  const disposeAndExit = async (code: number, err?: unknown): Promise<void> => {
    if (exiting) return
    exiting = true
    // Hard-exit fuse: if router.dispose() hangs (stuck git worktree purge,
    // wedged sub-agent teardown, …) the process must still terminate.
    // unref() keeps the timer from holding the event loop open itself.
    const hardExit = setTimeout(() => process.exit(code), 15_000)
    hardExit.unref?.()
    if (teamReminderTimer) clearInterval(teamReminderTimer)
    disableBracketedPaste()
    if (err) console.error(`\n${red('Fatal:')} ${terminalText(err instanceof Error ? err.message : String(err))}\n`)
    try { await router.dispose() } catch { /* best-effort */ }
    // Stdio MCP servers are long-lived child processes now (one per configured
    // server, not one per RPC), so they need an explicit kill or they outlive
    // the CLI as orphans holding ports and locks.
    try { disposeMcpClients() } catch { /* best-effort */ }
    try { rl.close() } catch { /* best-effort */ }
    process.exit(code)
  }
  process.once('SIGTERM',            () => { void disposeAndExit(0) })
  process.once('uncaughtException',  (e) => { void disposeAndExit(1, e) })
  process.once('unhandledRejection', (e) => { void disposeAndExit(1, e) })

  rl.prompt()

  while (true) {
    const rawInput = await _nextInput()
    if (rawInput === null) break   // rl closed (EOF / Ctrl+D)

    const input = rawInput.trim()
    if (!input) { rl.prompt(); continue }

    // ── Built-in slash commands ──
    if (input.startsWith('/')) {
      const cmd = input.split(/\s+/)[0]!.toLowerCase()
      switch (cmd) {
        case '/exit':
        case '/quit':
          rl.close()
          return
        case '/mode':
          console.log(`\nSession mode: ${cyan(router.mode ?? 'not yet determined')}\n`)
          break
        case '/workspace':
          console.log(`\nWorkspace: ${cyan(opts.workspace ?? '(unset — no file restrictions)')}\n`)
          break
        case '/hardware': {
          const subCmd = input.split(/\s+/).slice(1).join(' ').toLowerCase()
          if (subCmd === 'select') {
            // /hardware select — re-run hardware selection wizard
            if (opts.mode !== 'robotics') {
              console.log(`\n${yellow('硬件选择仅在 robotics 模式下可用。')}\n`)
            } else {
              const hp = new HardwareProfile()
              const selected = await runWizard(() => selectHardwareProfile(hp, opts.workspace, rl))
              opts.hardwareId     = selected.name || undefined
              hardwareProfileText = selected.profileText
              // Rebuild router with the new hardware binding (keeps same workspace/key/model)
              await router.dispose().catch(() => undefined)
              router = makeRouter(opts, hardwareProfileText || undefined, rl, undefined, getCurrentRouter, _promptLineInline)
              savedMessageCount = 0
              console.log(green('\n✓ 硬件配置已更新，新会话已启动。\n'))
            }
          } else {
            // /hardware — show current binding
            if (opts.hardwareId) {
              const hp = new HardwareProfile()
              const text = await hp.formatForPrompt(opts.hardwareId)
              console.log(`\n${text}\n`)
            } else if (opts.mode === 'robotics') {
              console.log(`\n${yellow('未绑定硬件配置。')} 使用 ${cyan('/hardware select')} 选择。\n`)
            } else {
              console.log(`\n${dim('硬件配置仅在 robotics 模式下可用。')}\n`)
            }
          }
          break
        }
        case '/usage': {
          const u = router.getUsage()
          const cost = router.getEstimatedCost()
          const autoCost = router.getAutoCostBreakdown()
          const costDetail = autoCost
            ? `Estimated cost: $${cost.toFixed(5)}  ` +
              `(main: $${autoCost.mainCostUsd.toFixed(5)}, sub-agents: $${autoCost.subAgentCostUsd.toFixed(5)}, ` +
              `reserved: $${autoCost.reservedSubAgentBudgetUsd.toFixed(5)}, ` +
              `budget: $${autoCost.budgetUsd.toFixed(5)})\n`
            : `Estimated cost: $${cost.toFixed(5)}\n`
          console.log(
            `\nTokens — in: ${u.inputTokens}  out: ${u.outputTokens}  ` +
            `cache_read: ${u.cacheReadInputTokens ?? 0}\n` +
            costDetail,
          )
          break
        }
        case '/sessions': {
          const sessionsSub = input.split(/\s+/).slice(1).join(' ').toLowerCase().trim()

          if (sessionsSub === 'clear') {
            // ── /sessions clear — delete sessions ───────────────────────────
            const sessions = await SessionStore.listSessions(50, { workspace: opts.workspace })
            if (sessions.length === 0) {
              console.log(dim('\n当前 workspace 暂无历史会话。\n'))
              break
            }
            console.log(`\n${bold('选择要删除的会话:')} ${dim('(仅当前 workspace；输入序号删除，all 删除全部，回车取消)')}\n`)
            sessions.forEach((s, i) => {
              const ago = formatAge(Date.now() - s.lastActivity)
              const preview = sessionDisplayTitle(s, 60)
              console.log(
                `  ${cyan(String(i + 1))}. ${bold(s.mode.padEnd(10))} ` +
                `${dim(ago.padEnd(12))} ${dim(`[${s.messageCount} 条]`)}  ${preview}`,
              )
            })
            console.log()
            const choice = await askQuestion(rl, `请选择 [1-${sessions.length} / all / 回车取消]: `)
            const choiceTrimmed = choice.trim().toLowerCase()
            if (!choiceTrimmed) {
              // cancelled
            } else if (choiceTrimmed === 'all') {
              const confirm = await askQuestion(rl, `${yellow('⚠  确认删除当前 workspace 的全部 ')}${sessions.length}${yellow(' 条历史会话？[y/N] ')}`)
              if (confirm.trim().toLowerCase() === 'y') {
                // Delete ONLY the sessions we listed for THIS workspace. The
                // earlier deleteAllSessions() wiped every workspace's history
                // despite the "当前 workspace" prompt — deleteSessions() filters
                // the index atomically (no last-writer-wins race) while staying
                // scoped to the listed IDs.
                await SessionStore.deleteSessions(sessions.map(s => s.sessionId))
                console.log(green(`\n✓ 已删除当前 workspace 的 ${sessions.length} 条历史会话。\n`))
              } else {
                console.log(dim('\n已取消。\n'))
              }
            } else {
              const idx = parseInt(choiceTrimmed, 10)
              if (idx >= 1 && idx <= sessions.length) {
                const selected = sessions[idx - 1]!
                await SessionStore.deleteSession(selected.sessionId)
                const preview = sessionDisplayTitle(selected, 50)
                console.log(green(`\n✓ 已删除会话: ${dim(preview)}\n`))
              } else {
                console.log(yellow('\n无效选择。\n'))
              }
            }
          } else {
            // ── /sessions — list & resume ────────────────────────────────────
              const sessions = await SessionStore.listSessions(8, { workspace: opts.workspace })
              if (sessions.length === 0) {
                console.log(dim('\n当前 workspace 暂无历史会话。\n'))
              } else {
                console.log(`\n${bold('历史会话:')} ${dim('(仅当前 workspace；输入序号加载并继续上次对话)')}\n`)
              sessions.forEach((s, i) => {
                const ago = formatAge(Date.now() - s.lastActivity)
                const preview = sessionDisplayTitle(s, 60)
                console.log(
                  `  ${cyan(String(i + 1))}. ${bold(s.mode.padEnd(10))} ` +
                  `${dim(ago.padEnd(12))} ${dim(`[${s.messageCount} 条]`)}  ${preview}`,
                )
              })
              console.log(`  ${cyan('0')}.  ${dim('取消')}\n`)
              const choice = await askQuestion(rl, `请选择 [0-${sessions.length}，回车取消]: `)
              const idx = parseInt(choice, 10)
              if (choice.trim() && idx >= 1 && idx <= sessions.length) {
                const selected = sessions[idx - 1]!
                console.log(dim('\n加载历史会话...\n'))
                const messages = await SessionStore.loadHistory(selected.sessionId)
                if (messages.length === 0) {
                  console.log(yellow('⚠  找不到历史记录。\n'))
                } else {
                  console.log(green(`✓ 已加载 ${messages.length} 条历史消息，继续 ${selected.mode} 模式。\n`))
                  opts.mode = selected.mode as CliOptions['mode']
                  await router.dispose().catch(() => undefined)
                  router = makeRouter(opts, hardwareProfileText || undefined, rl, messages, getCurrentRouter, _promptLineInline, selected.sessionId)
                  savedMessageCount = messages.length
                }
              }
            }
          }
          break
        }
        case '/experience': {
          const subCmd = input.split(/\s+/).slice(1).join(' ').toLowerCase()
          const subTokens = input.split(/\s+/).slice(1).map(t => t.toLowerCase())
          if (await handleDeleteSubcommand(rl, 'experience', subTokens, opts.mode === 'robotics' || router.mode === 'robotics')) break
          let pending = router.getPendingExperiences()
          // The robotics session is created lazily on the first message, so
          // before any prompt is sent `getPendingExperiences()` is null even in
          // robotics mode. Pending experiences are disk-persisted per project,
          // so load them directly to support "resume → review" without first
          // having to send a message.
          if (!pending && (opts.mode === 'robotics' || router.mode === 'robotics')) {
            const diskStore = new ExperiencePendingStore(opts.workspace)
            await diskStore.load()
            pending = diskStore
          }
          if (subCmd === 'review') {
            if (!pending) {
              console.log(yellow('\n/experience review 仅在 robotics 模式下可用。\n'))
            } else if (pending.count === 0) {
              console.log(`\n${dim('暂无待审经验。')}\n`)
            } else {
              const store = new ExperienceStore()
              // v1: commit only. Principle promotion / anchor claim / propagation
              // are deferred (code retained, not wired) — see
              // docs/knowledge-v1-experience-anchor.md.
              await reviewPendingExperiences(rl, pending, store)
            }
          } else {
            const count = pending?.count ?? 0
            if (count > 0) {
              console.log(`\n${yellow(`⏸  ${count} 条经验待审核`)} — 使用 ${cyan('/experience review')} 审核提交\n`)
            } else {
              console.log(`\n${dim('暂无待审经验。')}\n`)
            }
          }
          break
        }
        case '/principle': {
          const subCmd = input.split(/\s+/).slice(1).join(' ').toLowerCase()
          const subTokens = input.split(/\s+/).slice(1).map(t => t.toLowerCase())
          if (await handleDeleteSubcommand(rl, 'principle', subTokens, opts.mode === 'robotics' || router.mode === 'robotics')) break
          const pendingPrinciples = router.getPendingPrinciples()
          if (subCmd === 'review') {
            if (!pendingPrinciples) {
              console.log(yellow('\n/principle review 仅在 robotics 模式下可用。\n'))
            } else {
              const store = new PrincipleStore()
              await reviewPendingPrinciples(rl, pendingPrinciples, store, new ExperienceStore(), new PhysicalAnchorStore())
            }
          } else {
            const count = pendingPrinciples?.count ?? 0
            if (count > 0) {
              console.log(`\n${yellow(`⏸  ${count} 条原则待审核`)} — 使用 ${cyan('/principle review')} 审核提交\n`)
            } else {
              console.log(`\n${dim('暂无待审原则。')}\n`)
            }
          }
          break
        }
        case '/anchor': {
          const subCmd = input.split(/\s+/).slice(1).join(' ').toLowerCase()
          const subTokens = input.split(/\s+/).slice(1).map(t => t.toLowerCase())
          if (await handleDeleteSubcommand(rl, 'anchor', subTokens, opts.mode === 'robotics' || router.mode === 'robotics')) break
          const pendingAnchors = router.getPendingPhysicalAnchors()
          if (subCmd === 'review') {
            if (!pendingAnchors) {
              console.log(yellow('\n/anchor review 仅在 robotics 模式下可用。\n'))
            } else {
              const store = new PhysicalAnchorStore()
              const committed = await reviewPendingPhysicalAnchors(rl, pendingAnchors, store)
              // Newly committed anchors → refresh the memoized R6 set next turn.
              if (committed > 0) router.invalidateAnchors()
            }
          } else {
            const count = pendingAnchors?.count ?? 0
            if (count > 0) {
              console.log(`\n${yellow(`⏸  ${count} 条物理锚点待审核`)} — 使用 ${cyan('/anchor review')} 审核提交\n`)
            } else {
              console.log(`\n${dim('暂无待审物理锚点。')}\n`)
            }
          }
          break
        }
        case '/memory': {
          const subCmd = input.split(/\s+/).slice(1).join(' ').toLowerCase()
          const subTokens = input.split(/\s+/).slice(1).map(t => t.toLowerCase())
          if (await handleDeleteSubcommand(rl, 'memory', subTokens, true)) break
          // Memory is global (all modes); load the process-wide queue from disk.
          await ensureMemoryPendingLoaded()
          const pendingMemories = getMemoryPendingStore()
          if (subCmd === 'review') {
            if (pendingMemories.count === 0) {
              console.log(`\n${dim('暂无待审记忆。')}\n`)
            } else {
              await reviewPendingMemories(rl, pendingMemories)
            }
          } else {
            const count = pendingMemories.count
            if (count > 0) {
              console.log(`\n${yellow(`⏸  ${count} 条记忆待审核`)} — 使用 ${cyan('/memory review')} 审核提交\n`)
            } else {
              console.log(`\n${dim('暂无待审记忆。')}\n`)
            }
          }
          break
        }
        case '/team': {
          const [, rawTeamSub = ''] = input.split(/\s+/)
          const teamSub = rawTeamSub.toLowerCase()
          if (teamSub === 'off' || teamSub === 'exit') {
            console.log(`\n${dim('已退出 team 入口引导；当前仍是正常 robot mode。再次输入 /team 可重新选择工作。')}\n`)
            break
          }
          teamModeUsed = true   // user explicitly entered team mode — enable notifications
          await handleTeamCommand(input, router, opts, rl, setInteractiveActive)
          break
        }
        case '/compact': {
          // Manual compaction — same pipeline as auto-compact (summary +
          // keep-set + deterministic anchors + quality gate), forced now.
          console.log(dim('\n🗜  正在压缩会话上下文…'))
          const compactResult = await router.compactNow()
          if (compactResult.compacted) {
            const prev = ((compactResult.previousTokens ?? 0) / 1000).toFixed(1)
            const post = ((compactResult.postTokens ?? 0) / 1000).toFixed(1)
            console.log(green(`🗜  压缩完成 ${prev}k → ${post}k tokens\n`))
            // Persist the compacted history so resume sees the compact form.
            await persistCurrentSession(input).catch(() => undefined)
            savedMessageCount = router.getMessages().length
          } else {
            console.log(yellow(`未压缩：${compactResult.reason ?? '未知原因'}\n`))
          }
          break
        }
        case '/clear':
          await router.dispose().catch(() => undefined)
          router = makeRouter(opts, undefined, rl, undefined, getCurrentRouter, _promptLineInline)
          savedMessageCount = 0
          resetTitleState()
          console.log(green('\nNew session started.\n'))
          break
        case '/help':
          printHelp()
          break
        default:
          console.log(`\n${yellow('Unknown command:')} ${cmd}  ${dim('(try /help)')}\n`)
      }
      rl.prompt()
      continue
    }

    // ── Normal prompt ──
    interrupted = false

    // Snapshot pending counts before this turn so we can detect new additions
    const pendingCountBefore = router.getPendingExperiences()?.count ?? 0
    const anchorCountBefore = router.getPendingPhysicalAnchors()?.count ?? 0

    // Enable Ctrl+G steering only in an interactive TTY (and not in --json mode).
    const _steerEnabled = isTTY && !opts.json
    if (_steerEnabled) {
      _steerArmed = false
      _steerNotify = null
      _isStreaming = true
    }
    let turnStream: StreamPromptResult | undefined
    try {
      turnStream = await streamPrompt(
        router, input, opts.json, opts.showThinking,
        _steerEnabled ? steerHooks : undefined,
      )
    } catch (err) {
      if (!interrupted) {
        const msg = terminalText(err instanceof Error ? err.message : String(err))
        console.error(`\n${red('Error:')} ${msg}\n`)
      }
    } finally {
      // Disarm steering so a stray Ctrl+G at the idle prompt does nothing.
      _isStreaming = false
      _steerArmed = false
      _steerNotify = null
    }

    // ── Post-turn: nudge for newly queued physical anchors ───────────────────
    if (!opts.json) {
      const anchorCountAfter = router.getPendingPhysicalAnchors()?.count ?? 0
      const newAnchors = anchorCountAfter - anchorCountBefore
      if (newAnchors > 0) {
        process.stdout.write(
          `\n${yellow(`⚓  ${newAnchors} 条新物理锚点待审核`)} — ` +
          `${dim('使用 /anchor review 审核并提交至知识库。')}\n`,
        )
      }
    }
    void pendingCountBefore // suppress unused-variable lint

    // ── Show real debug dir once we have a sessionId ──────────────────────────
    if (opts.debug && !debugDirShown) {
      const sid = router.getSessionId()
      if (sid) {
        const realDir = join(META_AGENT_HOME, 'debug', sid)
        console.log(`\n${dim('调试日志目录:')} ${cyan(realDir)}\n`)
        debugDirShown = true
      }
    }

    // ── Post-turn: hardware binding catch-up ─────────────────────────────────
    // If a robotics router exists without hardware binding, prompt so subsequent
    // turns get hardware context.
    if (
      !interrupted && !opts.json && isTTY &&
      router.mode === 'robotics' && !opts.hardwareId && !hardwareBindingPrompted
    ) {
      hardwareBindingPrompted = true
      console.log(
        `\n${c.magenta}robotics${c.reset} 模式已激活，请绑定硬件配置以优化后续回复。\n`,
      )
      const hp = new HardwareProfile()
      const selected = await runWizard(() => selectHardwareProfile(hp, opts.workspace, rl))
      opts.hardwareId     = selected.name || undefined
      hardwareProfileText = selected.profileText
      if (hardwareProfileText) {
        await persistCurrentSession(input)
        opts.mode = 'robotics'
        await router.dispose().catch(() => undefined)
        router = makeRouter(opts, hardwareProfileText, rl, undefined, getCurrentRouter, _promptLineInline)
        savedMessageCount = 0
      }
      if (opts.hardwareId) {
        console.log(green(`✓ 硬件配置 "${opts.hardwareId}" 已绑定，后续回复将包含硬件上下文。\n`))
      }
    }

    // ── Persist session after each turn ──────────────────────────────────────
    // Append only the new messages (since savedMessageCount) so the file grows
    // incrementally rather than being rewritten on every turn.
    const expectedMessageCount = router.getMessages().length
    await persistCurrentSession(input)

    if (turnStream?.result?.subtype === 'parked') {
      if (savedMessageCount !== expectedMessageCount) {
        throw new Error(
          `Auto session requested a durable park, but only ${savedMessageCount}/` +
          `${expectedMessageCount} messages were confirmed persisted. Wake was not armed.`,
        )
      }
      const parkedSessionId = router.getSessionId()
      await router.dispose().catch(() => undefined)
      const record = await armAutoContinuation({
        sessionId: parkedSessionId,
        opts,
        result: turnStream.result,
        historyMessageCount: savedMessageCount,
      })
      if (!opts.json) {
        console.log(
          `${yellow('⏲')} Auto wake armed: ${record.wakeId}\n` +
          `${dim(`auto-scheduler 将在 ${new Date(record.fireAt).toLocaleString()} 后恢复同一会话。`)}\n`,
        )
      }
      exiting = true
      if (teamReminderTimer) clearInterval(teamReminderTimer)
      rl.close()
      break
    }

    // Fire-and-forget: generate (new sessions) or persist (carried titles).
    maybeGenerateSessionTitle()

    rl.prompt()
  }
}

