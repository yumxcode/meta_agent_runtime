/**
 * cli/sessionFlow — resuming, snapshotting and handing a session off.
 *
 * The resume picker, the on-exit snapshot write, and arming an auto-continuation
 * wake so an unattended run can pick itself back up in a fresh process.
 *
 * Extracted from cli/index.ts.
 */
import * as readline from 'node:readline'
import { SessionRouter } from '../routing/SessionRouter.js'
import { SessionStore, type SessionMeta } from '../core/SessionStore.js'
import { resolve } from 'node:path'
import type { ConversationMessage, MetaAgentResultEvent } from '../core/types.js'
import type { SessionMode } from '../core/modes.js'
import {
  readAutoCheckpoint,
  updateAutoCheckpointWithStatus,
} from '../core/auto/AutoCheckpointStore.js'
import {
  AutoContinuationStore,
  autoContinuationClaimOwner,
  type AutoContinuationRecord,
} from '../core/auto/AutoContinuationStore.js'
import { sanitizeTerminalText } from './terminalSanitizer.js'
import { bold, cyan, dim, gray, green, red, yellow, terminalText } from './term.js'
import { askQuestion } from './prompts.js'
import { generateSessionTitle } from './sideCalls.js'
import {
  sessionPromptPreview, formatAge, firstPromptFromMessage, findSessionPreviewMessage,
} from './transcript.js'
import type { CliOptions } from './args.js'

/** Picker display: prefer the generated title; fall back to the prompt preview. */
export function sessionDisplayTitle(s: SessionMeta, previewLimit: number): string {
  const title = s.title?.trim()
  if (title) return sanitizeTerminalText(title)
  return sessionPromptPreview(s.firstPrompt, previewLimit)
}

// ── Session resume picker ─────────────────────────────────────────────────────

/**
 * Show the last N sessions and let the user choose one to resume.
 * Returns the loaded ConversationMessage[] (empty if user declines).
 */
export async function runSessionPicker(
  rl: readline.Interface,
  workspace: string | undefined,
): Promise<{ sessionId: string; messages: ConversationMessage[]; mode: string } | null> {
  const sessions = await SessionStore.listSessions(8, { workspace })
  if (sessions.length === 0) return null

  console.log(`\n${bold('历史会话:')} ${dim('(仅显示当前 workspace，选择一个以继续上次对话)')}\n`)
  sessions.forEach((s, i) => {
    const ago = formatAge(Date.now() - s.lastActivity)
    const preview = sessionDisplayTitle(s, 60)
    console.log(
      `  ${cyan(String(i + 1))}. ${bold(s.mode.padEnd(10))} ` +
      `${dim(ago.padEnd(12))} ${dim(`[${s.messageCount} 条]`)}  ${preview}`,
    )
  })
  console.log(`  ${cyan('0')}.  ${dim('新建会话')}\n`)

  const choice = await askQuestion(rl, `请选择 [0-${sessions.length}，回车新建]: `)
  const idx = parseInt(choice, 10)
  if (!choice.trim() || idx === 0 || isNaN(idx) || idx < 1 || idx > sessions.length) {
    return null
  }

  const selected = sessions[idx - 1]!
  console.log(`\n${dim('加载历史会话...')}\n`)
  const messages = await SessionStore.loadHistory(selected.sessionId)
  if (messages.length === 0) {
    console.log(yellow('⚠  找不到历史记录，将新建会话。\n'))
    return null
  }
  console.log(green(`✓ 已加载 ${messages.length} 条历史消息，继续上次 ${selected.mode} 模式会话。\n`))
  return { sessionId: selected.sessionId, messages, mode: selected.mode }
}

interface PersistSessionSnapshotOptions {
  router: SessionRouter
  opts: CliOptions
  currentInput: string
  savedMessageCount: number
  sessionRoot?: string
  skipJson?: boolean
}

export async function persistSessionSnapshot({
  router,
  opts,
  currentInput,
  savedMessageCount,
  sessionRoot,
  skipJson = false,
}: PersistSessionSnapshotOptions): Promise<number> {
  if (skipJson && opts.json) return savedMessageCount
  try {
    const sessionId = router.getSessionId()
    if (!sessionId) return savedMessageCount
    const messages = router.getMessages()
    const firstUserMsg = findSessionPreviewMessage(messages)
    const firstPromptText = firstPromptFromMessage(firstUserMsg, currentInput)
    const meta = {
      mode:          router.mode ?? opts.mode,
      startTime:     Date.now(),
      lastActivity:  Date.now(),
      messageCount:  messages.length,
      firstPrompt:   firstPromptText,
      workspace:     opts.workspace,
    }
    const storeOptions = {
      ...(sessionRoot ? { rootDir: sessionRoot } : {}),
      expectedMessageCount: savedMessageCount,
    }
    if (messages.length < savedMessageCount) {
      await SessionStore.replace(sessionId, meta, messages, storeOptions)
    } else if (messages.length > savedMessageCount) {
      await SessionStore.append(sessionId, meta, messages, savedMessageCount, storeOptions)
    } else {
      return savedMessageCount
    }
    return messages.length
  } catch {
    // session save is best-effort — never crash the active run
    return savedMessageCount
  }
}

/**
 * The wake fence value for a park: how many messages a FRESH resume will see.
 *
 * MUST be read back through `loadHistory`, never taken from
 * `router.getMessages().length`. The write→read round trip is deliberately
 * lossy, and the fence in `resumeAutoContinuation` is an EXACT equality test,
 * so any in-memory message that does not survive the trip silently kills the
 * next wake:
 *
 *   - the compact boundary marker has `content: []` and is dropped by
 *     `serializeMessages` — so EVERY park in a turn that compacted armed a wake
 *     that was guaranteed to be cancelled on resume (this is not a race; it is
 *     deterministic, and it cost a 40-minute unattended GPU run);
 *   - a thinking-only assistant message becomes empty once thinking blocks are
 *     stripped for storage, and is dropped the same way;
 *   - `trimToSafeResumeBoundary` drops leading orphan tool_results at LOAD time.
 *
 * Reading back closes all three at once, and any future lossy step as well,
 * because the fence is now defined by the exact code path that later checks it.
 * Parking is rare (once per wake), so the extra read costs nothing.
 */
export async function persistedResumeMessageCount(
  sessionId: string,
  sessionRoot?: string,
): Promise<number> {
  const history = await SessionStore.loadHistory(
    sessionId,
    sessionRoot ? { rootDir: sessionRoot } : {},
  )
  return history.length
}

/** How many times arming re-checks the checkpoint while a sub-agent is still busy. */
const ARM_BUSY_RETRIES = 6
const ARM_BUSY_RETRY_MS = 500

export async function armAutoContinuation(input: {
  sessionId: string
  opts: CliOptions
  result: MetaAgentResultEvent
  historyMessageCount: number
  claimOwner?: string
}): Promise<AutoContinuationRecord> {
  const park = input.result.parkRequest
  if (input.result.subtype !== 'parked' || !park) {
    throw new Error('armAutoContinuation requires a parked result with parkRequest.')
  }
  if (input.opts.mode !== 'auto') {
    throw new Error('self_timer is supported only by plain auto mode.')
  }
  const projectDir = resolve(input.opts.workspace ?? process.cwd())
  const sessionId = input.sessionId
  if (!sessionId) throw new Error('Cannot arm Auto wake without a persisted session id.')

  // Wait for genuinely in-flight sub-agents instead of failing outright.
  //
  // This guard exists so a wake is never armed while a child is still writing.
  // But it used to be a single check that threw, and the throw travelled all the
  // way up to AutoScheduler, which retried the ALREADY-CONSUMED wake — a retry
  // that can only ever hit the history-count fence and cancel the session. So
  // the guard now re-reads the checkpoint a few times first: a busy child
  // usually finishes in seconds, and `activeSubAgentIds` is refreshed by the
  // checkpoint coordinator as it does.
  let cp = readAutoCheckpoint(projectDir, sessionId)
  for (let attempt = 0; attempt < ARM_BUSY_RETRIES && cp?.activeSubAgentIds?.length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, ARM_BUSY_RETRY_MS))
    cp = readAutoCheckpoint(projectDir, sessionId)
  }
  if (cp?.activeSubAgentIds?.length) {
    throw new Error(
      `Refusing to arm Auto wake while checkpoint still lists active sub-agents: ` +
      cp.activeSubAgentIds.join(', '),
    )
  }
  const store = new AutoContinuationStore(projectDir)
  const record = await store.schedule(
    {
      sessionId,
      fireAt: Date.now() + park.afterMs,
      reason: park.reason,
      checkpoint: park.checkpoint,
      goal: cp?.goal,
      checkpointRevision: cp?.revision,
      historyMessageCount: input.historyMessageCount,
      runtime: {
        model: input.opts.model,
        fallbackModel: input.opts.fallbackModel,
        baseUrl: input.opts.baseUrl,
        maxTurns: Number.isFinite(input.opts.maxTurns) ? input.opts.maxTurns : undefined,
        maxBudgetUsd: input.opts.maxBudgetUsd,
        sessionDir: input.opts.sessionDir,
      },
    },
    input.claimOwner ? { claimOwner: input.claimOwner } : undefined,
  )
  const checkpointWrite = await updateAutoCheckpointWithStatus(
    projectDir,
    sessionId,
    {
      stopReason: 'parked',
      pendingWake: {
        wakeId: record.wakeId,
        requestedAt: record.createdAt,
        fireAt: record.fireAt,
        reason: record.reason,
        checkpoint: record.checkpoint,
      },
    },
  )
  if (!checkpointWrite.written) {
    await store.cancel(record.wakeId, record.claim?.token)
    throw new Error('Auto history was saved, but the wake checkpoint could not be persisted; wake was cancelled.')
  }
  return record
}

