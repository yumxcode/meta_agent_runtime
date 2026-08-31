/**
 * DriftAgent — the auto-mode drift/reflection gate implementation.
 *
 * `makeAutoDriftGate` returns a DriftGateFn (kernel contract) that, at a
 * structural boundary, spawns an independent agent to:
 *   1. judge whether the run has wandered off the ORIGINAL goal, comparing the
 *      pure goal against the durable checkpoint (NOT the executor's narrative),
 *      and
 *   2. persist any well-grounded lesson via `experience_write`.
 *
 * Why goal + checkpoint (not full context): the checkpoint is a compressed,
 * durable state record (done / pending / artifacts). Judging drift from it keeps
 * the agent independent of the executor's framing and cheap. This is why the
 * checkpoint writer had to be fixed first — drift is only as good as the record.
 *
 * Experience-write discipline: the strict "only record a lesson with a clear
 * error source" rule is a SOFT constraint carried by the rubric (per design),
 * reinforced by the tool requiring an `error_source` argument. The drift agent
 * abstracts grounded failures into reusable principles; it must not invent
 * lessons from thin air.
 *
 * Fail-open: any internal failure resolves to `{ drifted: false, corrective: [] }`.
 */
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import { TERMINAL_STATUSES } from '../../../subagent/types.js'
import type { DriftGateFn, DriftVerdict } from '../../../kernel/loop/DriftGate.js'
import { buildVerdictOutputProtocol, parseFromVerdictChannels } from '../../../subagent/verdictChannel.js'
import { readAutoCheckpoint } from '../AutoCheckpointStore.js'
import { createAutoExperienceStore, renderRecentExperiences } from './AutoExperienceStore.js'
import { timeout } from '../../timeouts.js'
import type { TurnDiffTracker } from '../../../infra/fs/TurnDiffTracker.js'
import { renderTurnDiffSection } from '../turnDiffSection.js'
import { DEFAULT_DRIFT_BUDGET_USD, DEFAULT_JUDGE_MAX_TURNS } from '../../../infra/budgets.js'

export interface AutoDriftGateDeps {
  /** Spawns the isolated drift sub-agent. */
  dispatcher: ISubAgentDispatcher
  /** Workspace / jail root. */
  projectDir: string
  /** Lazily reads the pure frozen goal (SessionRouter._autoGoal). */
  getGoal: () => string | null
  /** Lazily reads the current session id, used to load the session checkpoint. */
  getSessionId?: () => string | undefined
  /**
   * Tool-level change tracker, when the session runs one.
   *
   * Drift previously received no delta at all — its rubric told it to go run
   * `git diff` itself, spending turns and budget on something the verify judge
   * is handed pre-computed. A stat block costs a few hundred tokens and removes
   * that whole detour. See core/auto/turnDiffSection.ts.
   */
  getTurnDiff?: () => TurnDiffTracker | undefined
}

/** Read-only investigation tools + the direct experience writer. */
const DRIFT_TOOLS = ['read_file', 'grep', 'glob', 'bash', 'experience_write']
export const DRIFT_AGENT_DEFAULT_MAX_BUDGET_USD = DEFAULT_DRIFT_BUDGET_USD
export const DRIFT_AGENT_DEFAULT_MAX_TURNS = DEFAULT_JUDGE_MAX_TURNS

/** Per-invocation override so long-running hosts can change the cap live. */
export function resolveDriftMaxBudgetUsd(): number {
  const raw = process.env['META_AGENT_DRIFT_MAX_BUDGET_USD']
  if (raw === undefined) return DRIFT_AGENT_DEFAULT_MAX_BUDGET_USD
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value) || value < 0.01) return DRIFT_AGENT_DEFAULT_MAX_BUDGET_USD
  return Math.min(value, 1_000_000)
}

/**
 * The drift judge's circuit-breaker limits, mirroring `resolveJudgeLimits()`.
 *
 * `maxDurationMs` used to be absent from the spawn config entirely, so the
 * sub-agent silently inherited DEFAULT_SUB_AGENT_MAX_DURATION_MS (30 min) while
 * the gate polled for a hard-coded 20. Three things went wrong at once in that
 * 10-minute window, and none of them was visible:
 *
 *   1. A judge that was merely SLOW — still running, about to produce a
 *      perfectly good verdict — was recorded as "unavailable" and its verdict
 *      thrown away.
 *   2. Each such event incremented `consecutiveDriftGateFailures`; three in a
 *      row stop the whole auto run with `auto_drift_unavailable`.
 *   3. The abandoned judge kept running and kept spending: internal tasks
 *      bypass the local worker cap but NOT the shared auto-session cost ledger
 *      (SubAgentBridge, "They still use the shared auto-session ledger"), so it
 *      billed the run for output nobody would ever read.
 *
 * The invariant that prevents all three — and the reason this is resolved once
 * and used twice — is that the POLLING ceiling must outlast the judge's OWN
 * wall-clock cap, so the gate always observes a terminal state instead of
 * guessing at a live one. VerifyJudge states the same rule; drift simply never
 * had a number to state it against.
 */
export function resolveDriftLimits(): {
  maxTurns: number
  maxBudgetUsd: number
  maxDurationMs: number
} {
  const rawTurns = process.env['META_AGENT_DRIFT_MAX_TURNS']
  const parsedTurns = rawTurns === undefined ? NaN : Number.parseInt(rawTurns, 10)
  return {
    maxTurns: Number.isFinite(parsedTurns)
      ? Math.min(10_000, Math.max(1, parsedTurns))
      : DRIFT_AGENT_DEFAULT_MAX_TURNS,
    maxBudgetUsd: resolveDriftMaxBudgetUsd(),
    // Routed through the shared resolver so `timeouts.driftMaxDurationMs` in
    // the config file works too, not just the env var — same as verify.
    maxDurationMs: timeout('driftMaxDurationMs'),
  }
}

const DRIFT_RUBRIC = `\
你是一个独立的"航向审查 + 经验沉淀 Agent"，在一次长时间无人值守任务的中途被触发。你看不到执行 Agent 的推理过程，只拿到【原始目标】、【进度快照(checkpoint)】和【既有经验】。

你的两个职责：

A. 判断是否偏离目标
- 对照原始目标与进度快照，判断当前推进方向是否仍然正确。
- 若任务里附带了【本次运行的文件改动】清单，那是执行 Agent 实际动过的文件与增删行数（由写入工具直接记录，无需你再跑 git）。它是判断方向最直接的证据：改动集中在与目标无关的子系统、或反复重写同一批文件而行数进展停滞，都是偏离信号。需要看具体内容时用 read_file 读那几个文件即可。
- 快照里的 editDigest（若有）是最近一段文件改动的自动摘要——当执行 Agent 长时间只改代码、没写 todo/progress 时，它是补充线索。
- 可用只读工具（read_file/grep/glob/bash）到工作区核对实际状态，但**不要修改任何文件**。
- "偏离"指：在做与目标无关的事、纠缠于次要细节、朝错误方案越走越远、或快照显示的已完成项与目标南辕北辙。正常的中途状态不算偏离。
- 结合 runHealth 判断运行轨迹（不只是当前状态）：driftCorrections 已多次（尤其紧邻 lastDriftCorrectionTurn 后进展仍无变化）说明前几次纠偏无效、可能在打转，应判为 major 并给出更强或换向的纠偏；lastVerifyRejectTurn 临近 currentTurn 说明刚被 verify 驳回，应重点核对是否在补齐被驳回的缺口，而非又开新支线；compactions 较多说明上下文被多次压缩、易丢失目标，应更严格地核对目标对齐。
- 持续产生代码修改、提交、progress_note 或其他 artifacts，只能说明任务仍在行动，不能单独证明当前技术方向有效。还要判断近期行动是否让任务在目标层面有效收敛，还是只在既有的局部假设和修改方向中反复迭代。如果存在后一种可能，应考虑暂时停止继续局部修改，扩大阅读和分析范围，重新从任务目标、约束条件、验证结果、关键调用链、相关模块及上下游关系出发，整体梳理仓库的逻辑和关键细节，再决定下一步方向和行动。是否需要进行这种整体梳理，由你结合 checkpoint、历史轨迹和仓库证据自行判断；不要仅因为持续存在修改、提交或 progress_note，就判断当前方向没有发生漂移。

B. 沉淀经验（严格）
- 只有当你掌握**确凿证据**时，才调用 experience_write 写入一条经验。
- 调用时**必须在 error_source 注明来源**：严重偏离目标的具体表现、verify 拒绝项、或明确的执行失败/退出码。
- 没有确凿来源就**不要写**——宁可不写，也不要凭猜测污染经验库。优先沉淀"失败教训"。

${buildVerdictOutputProtocol(`{
  "drifted": true 或 false,
  "severity": "minor" 或 "major",
  "corrective": ["若偏离，给出具体纠偏步骤", "..."],
  "note": "简述判断依据"
}`)}
drifted=false 时 corrective 必须为空数组。experience 通过 \`experience_write\` 工具写入，不要放进这个 JSON。`

function buildDriftTask(
  goal: string,
  checkpointJson: string,
  experienceBlock: string | null,
  turnDiffSection: string | null,
): string {
  const lines = [
    '【原始目标】',
    goal,
    '',
    '【进度快照 checkpoint】',
    checkpointJson,
  ]
  if (turnDiffSection) {
    lines.push('', turnDiffSection)
  }
  lines.push(
    '',
    '【既有经验】',
    experienceBlock ?? '（暂无）',
    '',
    '现在开始审查：先判断是否偏离目标，再决定是否有确凿经验值得写入，最后只输出 JSON 裁决。',
  )
  return lines.join('\n')
}

/** Extract the last JSON drift verdict from the agent's summary text. */
export function parseDriftVerdict(text: string): DriftVerdict | null {
  if (!text) return null
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1] ?? '')
  const candidates = fences.length ? [...fences] : []
  const lastBrace = text.lastIndexOf('{')
  if (lastBrace !== -1) candidates.push(text.slice(lastBrace))

  for (let i = candidates.length - 1; i >= 0; i--) {
    const raw = candidates[i]?.trim()
    if (!raw) continue
    try {
      const obj = JSON.parse(raw) as Partial<DriftVerdict>
      if (typeof obj.drifted !== 'boolean') continue
      return {
        drifted: obj.drifted,
        severity: obj.severity === 'major' ? 'major' : obj.severity === 'minor' ? 'minor' : undefined,
        corrective: Array.isArray(obj.corrective) ? obj.corrective.map(String) : [],
        note: typeof obj.note === 'string' ? obj.note : undefined,
      }
    } catch {
      // try next candidate
    }
  }
  return null
}

/**
 * Spawn the drift agent and block until terminal; return its parsed verdict.
 *
 * `undefined` = no usable terminal result (timeout / failure / cancel).
 * `null`      = completed, but neither the `return_result` data payload nor the
 *               chat-text channel carried a parsable verdict.
 */
async function runDriftAgent(
  dispatcher: ISubAgentDispatcher,
  taskDescription: string,
  signal: AbortSignal,
): Promise<DriftVerdict | null | undefined> {
  const limits = resolveDriftLimits()
  const rec = await dispatcher.spawnSubAgent({
    config: {
      taskDescription,
      systemPrompt: DRIFT_RUBRIC,
      allowedTools: DRIFT_TOOLS,
      maxTurns: limits.maxTurns,
      maxBudgetUsd: limits.maxBudgetUsd,
      // Declared explicitly, never inherited. The polling ceiling below is
      // derived from this exact number; letting the sub-agent default to
      // something the gate does not know about is what created the window in
      // which a live judge looked dead.
      maxDurationMs: limits.maxDurationMs,
      requireHumanApproval: false,
      useEventDriven: false,
      pollIntervalMs: 500,
      checkpointEveryNTurns: 0,
      // Reserved side lane (see VerifyJudge): never starved by research/worker
      // sub-agents that share the bridge, nor blocked by the shared budget cap.
      internal: true,
      workspaceMode: 'shared_readonly',
    },
    abortSignal: signal,
  })

  // Poll to terminal. The ceiling outlasts the judge's own wall-clock cap by a
  // minute, so reaching it means the sub-agent's timer failed to fire — a real
  // fault — rather than merely that the judge was slower than we guessed.
  const POLL_MS = 500
  const MAX_WAIT_MS = limits.maxDurationMs + 60_000
  const deadline = Date.now() + MAX_WAIT_MS
  let latest = rec
  try {
    while (!TERMINAL_STATUSES.has(latest.status)) {
      if (signal.aborted || Date.now() > deadline) break
      await sleep(POLL_MS, signal)
      const polled = await dispatcher.getStatus(rec.taskId)
      if (!polled) break
      latest = polled
    }
    if (latest.status !== 'completed') return undefined
    return parseFromVerdictChannels(latest, parseDriftVerdict)
  } finally {
    // Same reasoning as the verify judge: the comment above already says that
    // reaching this deadline means the sub-agent's own timer failed, so waiting
    // longer is pointless — but so is walking away from a runner nothing else
    // will stop. Abandoning it leaks the seat and its budget, and the gate's
    // retry then adds a second one beside it.
    if (!TERMINAL_STATUSES.has(latest.status)) {
      await dispatcher
        .cancelTask(rec.taskId, 'drift agent exceeded the gate deadline')
        .catch(() => undefined)
    }
  }
}

/** Abortable poll delay — an interrupted run should not wait out a full tick. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Build the drift gate for an auto session. Skips are handled by KernelLoop policy. */
export function makeAutoDriftGate(deps: AutoDriftGateDeps): DriftGateFn {
  const store = createAutoExperienceStore(deps.projectDir)
  return async ({ signal }) => {
    // A SKIP (the agent could not run): unlike a genuine parsed "drifted:false"
    // verdict (agent ran, judged the run on course), this is handled by the
    // loop's gate-failure policy, so a healthy on-course run stays quiet.
    const skip = (note: string): DriftVerdict =>
      ({ drifted: false, corrective: [], skipped: true, note })

    const goal = deps.getGoal()
    if (!goal || !goal.trim()) return skip('goal missing')

    try {
      const sessionId = deps.getSessionId?.()
      if (!sessionId) return skip('session id missing')
      const cp = readAutoCheckpoint(deps.projectDir, sessionId)
      if (!cp) return skip('checkpoint missing')
      // Only feed the fields drift needs — keep it compact and goal-focused.
      const checkpointJson = JSON.stringify(
        {
          completedSteps: cp.completedSteps ?? [],
          pendingTodos: cp.pendingTodos ?? [],
          artifacts: cp.artifacts ?? [],
          turnCount: cp.turnCount,
          note: cp.note,
          // Auto-generated recap of recent file edits — present when the agent
          // edited for a long stretch without an explicit todo/progress update.
          editDigest: cp.autoEditSummary,
          // Run-health: trajectory signals. Repeated corrections without progress
          // = stalling; a recent verify rejection = claimed-done-but-wasn't; a
          // compaction = possible loss of goal context.
          runHealth: {
            verifyRejections: cp.verifyRejections ?? 0,
            driftCorrections: cp.driftCorrections ?? 0,
            compactions: cp.compactions ?? 0,
            lastVerifyRejectTurn: cp.lastVerifyRejectTurn,
            lastDriftCorrectionTurn: cp.lastDriftCorrectionTurn,
            currentTurn: cp.turnCount,
          },
        },
        null,
        2,
      )

      const experienceBlock = await renderRecentExperiences(store)
      // Stat only: drift judges DIRECTION, and a file list plus line counts is
      // enough to see "it has been editing the wrong subsystem for 20 turns".
      // A patch would multiply the cost of a gate that fires every N turns
      // without changing that judgement.
      const tracker = deps.getTurnDiff?.()
      const turnDiffSection = tracker
        ? await renderTurnDiffSection(tracker, { workspaceRoot: deps.projectDir })
        : null
      const task = buildDriftTask(goal, checkpointJson, experienceBlock, turnDiffSection)
      const verdict = await runDriftAgent(deps.dispatcher, task, signal)
      if (verdict === undefined) return skip('drift agent returned no usable result')
      if (verdict === null) return skip('drift agent returned an unparsable verdict')
      return verdict
    } catch (err) {
      return skip(err instanceof Error ? err.message : String(err))
    }
  }
}
