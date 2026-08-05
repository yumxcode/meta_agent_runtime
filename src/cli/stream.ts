/**
 * cli/stream — render one model turn to the terminal.
 *
 * Owns the streaming event loop: text/thinking deltas, tool call rendering, the
 * thinking meter, mid-turn steering (Ctrl+G), output truncation and abort
 * handling. Everything that decides what a turn LOOKS like is here; what a turn
 * DOES is the session's business.
 *
 * Extracted from cli/index.ts.
 */
import * as readline from 'node:readline'
import { SessionRouter } from '../routing/SessionRouter.js'
import { RuntimeEnv } from '../infra/env/RuntimeEnv.js'
import { ThinkingMeter } from './thinkingMeter.js'
import { TerminalSanitizer, sanitizeTerminalPreview, sanitizeTerminalText } from './terminalSanitizer.js'
import { referencesDistillTrace } from './distillTraceGuard.js'
import { createDegenerateLoopGuard } from './degenerateLoopGuard.js'
import { shouldSuppressAttachedParkPresentation } from './autoPresentation.js'
import { formatLocalClock } from '../loop/localTime.js'
import type { MetaAgentEvent, MetaAgentResultEvent } from '../core/types.js'
import { isAutonomousMode } from '../core/modes.js'
import type { SessionMode } from '../core/modes.js'
import { analyzeAbnormalTermination, terminationReasonLabel } from './sideCalls.js'
import {
  c, bold, cyan, dim, gray, green, red, yellow, isTTY, terminalText, abortError,
  safeStdoutWrite, setActiveThinkingMeter, pauseActiveThinkingMeter,
  setActiveThinkingMeterSuppressed, canShowActiveThinkingMeter,
} from './term.js'

// ── Stream a single prompt ────────────────────────────────────────────────────

const DEFAULT_CLI_MAX_VISIBLE_CHARS = 50_000

export function getCliMaxVisibleChars(): number {
  return RuntimeEnv.cliMaxVisibleChars(DEFAULT_CLI_MAX_VISIBLE_CHARS)
}


/**
 * Hooks that let the REPL steer the model mid-turn (Ctrl+G). The CLI's stdin
 * listener arms a correction; streamPrompt pauses output (without aborting the
 * stream), reads one line of guidance, and forwards it to router.steer().
 */
export interface SteerHooks {
  /** Resolves when a steer has been armed (Ctrl+G); immediate if already armed. */
  waitArmed: () => Promise<void>
  /** Synchronous armed check, so an already-armed steer can pre-empt a resolved
   *  pending event instead of losing the Promise.race to it. */
  isArmed: () => boolean
  /** Clear the armed flag after servicing a steer prompt. */
  consume: () => void
  /**
   * Hand the input line over to readline with a `steer ›` prompt and render it.
   * Required so readline owns the prompt — otherwise its own `you ›` prompt
   * redraws over a manually printed one the moment the user types.
   */
  beginInput: () => void
  /** Read one line of correction text (null on EOF). */
  read: () => Promise<string | null>
  /** Restore the normal `you ›` prompt after the correction line is read. */
  endInput: () => void
}

interface StreamPromptSession {
  submit(prompt: string): AsyncGenerator<MetaAgentEvent>
  steer(text: string): boolean
  interrupt?(): void
  getEstimatedCost(): number
  readonly mode: SessionMode | null
}

export interface StreamPromptResult {
  text: string
  result?: MetaAgentResultEvent
  /** Set when the phase was cut off for repeating itself; see
   * `createDegenerateLoopGuard`. */
  degenerateLoop?: string
}

export async function streamPrompt(
  router: StreamPromptSession,
  prompt: string,
  jsonMode: boolean,
  showThinking = false,
  steerHooks?: SteerHooks,
  signal?: AbortSignal,
  attachedLease = false,
  /** Enabled for Distill phases, whose output is a bounded envelope: a model
   * that starts restating the same paragraph there will never produce one. */
  guardDegenerateLoop = false,
): Promise<StreamPromptResult> {
  if (signal?.aborted) throw abortError(signal.reason)
  const onAbort = () => router.interrupt?.()
  signal?.addEventListener('abort', onAbort, { once: true })
  const gen = router.submit(prompt)
  const loopGuard = guardDegenerateLoop ? createDegenerateLoopGuard() : null
  let degenerateLoop: string | undefined
  const steering = steerHooks ?? null
  let hasText = false
  let thinkingOpen = false   // whether we're currently inside a thinking block
  // Captured for abnormal-termination diagnosis (auto-series): the agent's
  // recent narration + a compact trail of tool calls, fed to a one-shot LLM
  // analysis when the run ends in a non-success terminal state. Accumulated in
  // BOTH json and text paths (see the event loop below).
  let recentAgentText = ''
  let capturedText = ''
  let terminalResult: MetaAgentResultEvent | undefined
  const recentToolTrail: string[] = []
  let visibleChars = 0
  let visibleTruncated = false
  const visibleLimit = getCliMaxVisibleChars()
  const outputSanitizer = new TerminalSanitizer()

  // ── Live reasoning indicator ──────────────────────────────────────────────
  // Reasoning models stream their chain of thought before any visible answer.
  // When that text is hidden the terminal would otherwise look frozen during a
  // long reasoning phase, so we draw a single in-place status line (spinner +
  // elapsed time + estimated reasoning tokens). A timer advances the spinner so
  // it stays alive even while waiting for the first token. Disabled outside an
  // interactive TTY (and in --json mode) so it never pollutes piped output.
  const meterEnabled = isTTY && !jsonMode
  const meter = new ThinkingMeter({ enabled: meterEnabled })
  let meterTimer: ReturnType<typeof setInterval> | null = null
  if (meterEnabled) {
    if (canShowActiveThinkingMeter()) meter.show()
    meterTimer = setInterval(() => {
      if (canShowActiveThinkingMeter()) meter.tick()
    }, 120)
    if (typeof meterTimer.unref === 'function') meterTimer.unref()
  }
  // Expose this turn's meter so mid-turn interactive prompts can pause the
  // spinner before printing (otherwise the timer redraws over the question).
  setActiveThinkingMeter(meter)

  async function writeVisible(text: string): Promise<void> {
    if (!text || visibleTruncated) return
    const safeText = outputSanitizer.sanitize(text)
    if (!safeText) return
    const remaining = visibleLimit - visibleChars
    if (remaining <= 0) {
      visibleTruncated = true
      await safeStdoutWrite(`\n${yellow('⚠')}  ${yellow('本轮终端输出已达到显示上限，后续内容已隐藏。')} ${dim('完整上下文仍保留在会话历史中。')}\n`)
      return
    }
    const chunk = safeText.length > remaining ? safeText.slice(0, remaining) : safeText
    visibleChars += chunk.length
    await safeStdoutWrite(chunk)
    if (chunk.length < safeText.length) {
      visibleTruncated = true
      await safeStdoutWrite(`\n${yellow('⚠')}  ${yellow('本轮终端输出已达到显示上限，后续内容已隐藏。')} ${dim('完整上下文仍保留在会话历史中。')}\n`)
    }
  }

  // ── Thinking block helpers ────────────────────────────────────────────────
  async function openThinkingBlock(): Promise<void> {
    if (thinkingOpen) return
    await safeStdoutWrite(
      `\n${dim('┌─ 思考中 ──────────────────────────────────────────────────────')}\n`,
    )
    thinkingOpen = true
  }
  async function closeThinkingBlock(): Promise<void> {
    if (!thinkingOpen) return
    await safeStdoutWrite(
      `\n${dim('└───────────────────────────────────────────────────────────────')}\n`,
    )
    thinkingOpen = false
  }

  try {
    // Manual drive (instead of `for await`) so a Ctrl+G steer can be serviced
    // even while we're blocked waiting for the next event during a long
    // reasoning phase. We race the pending event against the steer signal; if
    // steering wins we pause, collect a correction, inject it, then re-race the
    // SAME pending event — so the model is never aborted, only back-pressured.
    let pending = gen.next()
    while (true) {
      // An already-armed steer must pre-empt the next event. During a heavy
      // reasoning phase `pending` is almost always already resolved, so a plain
      // Promise.race would keep choosing it (it sits first in the array) and the
      // armed steer would be starved — the symptom being a flickering meter and a
      // `steer ›` prompt that never holds. Check the armed flag synchronously
      // first; only race when nothing is armed yet.
      const raced = steering
        ? (steering.isArmed()
            ? ('__steer__' as const)
            : await Promise.race([pending, steering.waitArmed().then(() => '__steer__' as const)]))
        : await pending

      if (raced === '__steer__') {
        steering!.consume()
        meter.hide()
        await safeStdoutWrite(
          `\n${yellow('⏸ 已暂停输出')} ${dim('输入纠正指令并回车注入（直接回车取消）:')}\n`,
        )
        // Hand the line to readline with a `steer ›` prompt so it renders and
        // owns the input — otherwise readline's own `you ›` prompt redraws over
        // a manually printed one the instant the user types.
        steering!.beginInput()
        let correction: string | null
        try {
          correction = await steering!.read()
        } finally {
          steering!.endInput()
        }
        const trimmed = (correction ?? '').trim()
        if (trimmed) {
          const ok = router.steer(trimmed)
          await safeStdoutWrite(
            ok
              ? `${green('✓')} ${dim('纠正已加入队列，将在下个步骤边界注入，不中断当前生成。')}\n`
              : `${yellow('·')} ${dim('当前没有进行中的回合，已忽略该纠正。')}\n`,
          )
        } else {
          await safeStdoutWrite(`${dim('已取消，继续。')}\n`)
        }
        if (meterEnabled && canShowActiveThinkingMeter()) meter.show()
        continue
      }

      const step = raced
      if (step.done) break
      const event = step.value
      pending = gen.next()

      // Accumulate recent agent activity for abnormal-termination diagnosis
      // (runs in BOTH json and text modes, before any mode-specific handling).
      if (event.type === 'text') {
        capturedText += event.text
        if (loopGuard) {
          const degenerate = loopGuard.inspect(capturedText)
          if (degenerate) {
            degenerateLoop = degenerate
            router.interrupt?.()
          }
        }
        recentAgentText += event.text
        if (recentAgentText.length > 8000) recentAgentText = recentAgentText.slice(-8000)
      } else if (event.type === 'tool_use') {
        recentToolTrail.push(`${event.toolName} ${JSON.stringify(event.toolInput).slice(0, 80)}`)
        if (recentToolTrail.length > 40) recentToolTrail.shift()
      }
      if (event.type === 'result') terminalResult = event

      if (jsonMode) {
        console.log(JSON.stringify(event))
        // Programmatic callers (e.g. a remote orchestrator) otherwise get only a
        // bare reason code on abnormal exit. Emit a follow-up diagnosis event so
        // they receive the same LLM analysis a human would see.
        if (
          event.type === 'result' && event.isError &&
          isAutonomousMode(router.mode)
        ) {
          const analysis = router instanceof SessionRouter ? await analyzeAbnormalTermination(router, {
            goal: prompt, subtype: event.subtype,
            recentText: recentAgentText, toolTrail: recentToolTrail,
          }) : null
          if (analysis) {
            console.log(JSON.stringify({
              type: 'termination_analysis',
              subtype: event.subtype,
              analysis,
              sessionId: event.sessionId,
            }))
          }
        }
        continue
      }
      switch (event.type) {
        case 'thinking_delta': {
          meter.note(event.delta)
          if (showThinking) {
            meter.hide()
            await openThinkingBlock()
            await writeVisible(dim(event.delta))
          } else {
            // Keep the compact live indicator visible (it now shows a token count).
            if (canShowActiveThinkingMeter()) meter.show()
          }
          break
        }
        case 'text': {
          meter.hide()
          // Close any open thinking block before the first reply text
          await closeThinkingBlock()
          if (!hasText) {
            await safeStdoutWrite(`\n${bold(green('agent'))} › `)
            hasText = true
          }
          await writeVisible(event.text)
          break
        }
        case 'tool_use': {
          meter.hide()
          const toolName = sanitizeTerminalText(event.toolName)
          const preview = sanitizeTerminalPreview(JSON.stringify(event.toolInput), 80)
          await safeStdoutWrite(
            `\n${dim('⚙')}  ${cyan(toolName)} ${gray(preview)}\n`,
          )
          break
        }
        case 'tool_result': {
          meter.hide()
          const preview = sanitizeTerminalPreview(event.content, 120)
          await safeStdoutWrite(
            `   ${dim('→')} ${gray(preview)}${preview.length >= 120 ? gray('…') : ''}\n`,
          )
          break
        }
        case 'api_retry': {
          meter.hide()
          await safeStdoutWrite(
            `\n${yellow('⚠')}  retrying (attempt ${event.attempt}/${event.maxRetries}, delay ${event.retryDelayMs}ms)\n`,
          )
          break
        }
        case 'system_message': {
          meter.hide()
          const icon = event.subtype === 'warning' ? yellow('⚠') : dim('ℹ')
          const text = sanitizeTerminalPreview(event.text, 300)
          await safeStdoutWrite(
            `\n${icon}  ${event.subtype === 'warning' ? yellow(text) : dim(text)}\n`,
          )
          break
        }
        case 'compact_start': {
          meter.hide()
          await safeStdoutWrite(`\n${dim('🗜  会话压缩中…')}\n`)
          break
        }
        case 'compact_boundary': {
          meter.hide()
          const prev = event.previousTokens ?? 0
          const after = event.summaryTokens ?? 0
          const freed = Math.max(0, prev - after)
          const k = (n: number) => `${(n / 1000).toFixed(1)}k`
          await safeStdoutWrite(
            `${dim(`🗜  压缩完成 ${k(prev)} → ${k(after)}（释放 ${k(freed)}）`)}\n`,
          )
          break
        }
        case 'compact_failed': {
          meter.hide()
          const attempt = typeof event.attempt === 'number' ? event.attempt : 0
          const err = sanitizeTerminalPreview(event.error ?? 'unknown error', 120)
          await safeStdoutWrite(
            `\n${yellow('⚠')}  ${yellow(`会话压缩失败（第 ${attempt}/3 次），继续使用当前上下文。`)} ${dim(err)}\n`,
          )
          break
        }
        case 'result': {
          const suppressParkedPresentation =
            shouldSuppressAttachedParkPresentation(attachedLease, event.subtype)
          meter.hide()
          await closeThinkingBlock()
          if (hasText) await safeStdoutWrite('\n')
          // Show explicit warnings for non-success result subtypes so the user
          // is never silently left wondering why the agent stopped.
          if (event.subtype === 'error_max_turns') {
            await safeStdoutWrite(
              `\n${yellow('⚠')}  ${yellow('已达到本轮最大步数上限。')} ` +
              `${dim('继续输入以接着分析，或用 --max-turns <n> 提高上限。')}\n`,
            )
          } else if (event.subtype === 'error_max_budget') {
            await safeStdoutWrite(
              `\n${yellow('⚠')}  ${yellow('已超出 token 预算上限。')} ` +
              `${dim('任务已提前终止。可继续输入或拆分为更小的子任务。')}\n`,
            )
          } else if (event.subtype === 'error_max_output_tokens') {
            await safeStdoutWrite(
              `\n${yellow('⚠')}  ${yellow('模型输出连续达到上限，结果可能不完整。')} ` +
              `${dim('请缩小任务范围、提高输出上限或继续该任务。')}\n`,
            )
          } else if (event.subtype === 'error_during_execution') {
            const errDetails = sanitizeTerminalText((event as { errors?: string[] }).errors?.join('\n  ') ?? '')
            await safeStdoutWrite(
              `\n${red('✗')}  ${red('执行过程中发生错误。')} ` +
              `${dim('请检查以下错误信息，调整指令后重试。')}\n` +
              (errDetails ? `${red('  错误详情：')} ${errDetails}\n` : ''),
            )
          } else if (event.subtype === 'parked' && !suppressParkedPresentation) {
            const wakeAt = event.parkRequest
              ? new Date(Date.now() + event.parkRequest.afterMs).toLocaleString()
              : 'unknown'
            await safeStdoutWrite(
              `\n${yellow('⏲')}  ${yellow('Auto 会话已停放。')} ` +
              `${dim(`预计恢复时间：${wakeAt}`)}\n`,
            )
          }
          // Auto-series abnormal exit: replace the bare reason with an actual
          // LLM diagnosis (what happened / root cause / what's needed next).
          if (event.isError && isAutonomousMode(router.mode)) {
            const analysis = router instanceof SessionRouter ? await analyzeAbnormalTermination(router, {
              goal: prompt, subtype: event.subtype,
              recentText: recentAgentText, toolTrail: recentToolTrail,
            }) : null
            if (analysis) {
              await safeStdoutWrite(
                `\n${dim('─── 终态诊断 (LLM) ───────────────────────────────────────────')}\n` +
                `${analysis}\n` +
                `${dim('─────────────────────────────────────────────────────────────')}\n`,
              )
            }
          }
          if (!suppressParkedPresentation) {
            const usage = event.usage
            const cost  = router.getEstimatedCost()
            const mode  = router.mode ?? 'agentic'
            const modeTag = mode === 'campaign' ? cyan(mode)
                          : mode === 'agentic'  ? green(mode)
                          : mode === 'robotics' ? `${c.magenta}${mode}${c.reset}`
                          : mode === 'auto'     ? yellow(mode)
                          : mode === 'simple_auto' ? yellow(mode)
                          : gray(mode)
            const thinkTag = meter.charCount > 0
              ? `  ${gray(`think:~${meter.tokenEstimate}`)}`
              : ''
            await safeStdoutWrite(
              `\n${gray('─'.repeat(56))}\n` +
              `${modeTag}  ` +
              `${gray(`in:${usage.inputTokens} out:${usage.outputTokens}`)}${thinkTag}  ` +
              `${gray(`$${cost.toFixed(4)}`)}\n`,
            )
          }
          break
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ERR_STREAM_PREMATURE_CLOSE') return { text: capturedText, ...(terminalResult ? { result: terminalResult } : {}), ...(degenerateLoop ? { degenerateLoop } : {}) }
    throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // Always tear down the spinner timer and wipe any lingering status line —
    // including on interrupt/error paths — so it never bleeds into the prompt.
    if (meterTimer) clearInterval(meterTimer)
    meter.hide()
    setActiveThinkingMeter(null)
    setActiveThinkingMeterSuppressed(false)
  }
  return { text: capturedText, ...(terminalResult ? { result: terminalResult } : {}), ...(degenerateLoop ? { degenerateLoop } : {}) }
}

