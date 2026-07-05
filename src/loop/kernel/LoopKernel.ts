/**
 * LoopKernel — the fixed nine-step round pipeline (spec §2, C7).
 *
 *   WAKE ▶ RECONCILE ▶ CAPSULE ▶ MODE ▶ SEAT ▶ GATE ▶ METER ▶ LEDGER ▶ ROUTE
 *
 * Control flow is HOST CODE — no LLM ever decides what step comes next. The
 * only intelligent moments are SEAT (worker/pivoter) and the judge half of
 * GATE; every kernel decision is an expression evaluation over the frozen
 * charter, and every round leaves one audited RoundEntry behind.
 *
 * M2: a round may SPLIT into a submit segment and a harvest segment. The
 * worker requests a wait ({label:'wait', wait:'<name>', …}); the kernel
 * registers the effect, persists pending_round.json, schedules a probe wake
 * and lets the process EXIT. Hours later a probe/event concludes the effect
 * and a harvest wake resumes the SAME round — worker lineage carried by the
 * submit-segment digest, meters/gates untouched in between.
 */
import { readFile, rm } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { evaluateBool, type EvalContext } from '../expr/Expr.js'
import type { FrozenCharter, TripwireAction } from '../charter/CharterTypes.js'
import type { LoopInstance } from '../instance/InstanceStore.js'
import { setInstanceStatus } from '../instance/InstanceStore.js'
import { buildCapsule, type Capsule } from '../capsule/CapsuleBuilder.js'
import { runJudgeSeat, runPivoterSeat, runWorkerSeat, type SeatResult, type SeatRunnerDeps } from './Seats.js'
import { WakeStore, type WakeRecord } from '../wake/WakeStore.js'
import { atomicWriteFile } from '../../infra/persist/index.js'
import type { PendingRound, RoundEntry, RoundMode } from '../types.js'
import {
  clearPendingRound,
  effectLedgerFor,
  ingestEvents,
  readPendingRound,
  reconcileWaiting,
  writePendingRound,
} from '../effects/WaitOps.js'

/** Observability events (T4.4) — consumed by CLI/daemon renderers. */
export type LoopEvent =
  | { type: 'round_started'; round: number; mode: RoundMode }
  | { type: 'seat_completed'; round: number; seat: string; ok: boolean; costUsd: number }
  | { type: 'waiting_entered'; round: number; effectKey: string; waitName: string }
  | { type: 'harvest_started'; round: number; effectKey: string }
  | { type: 'round_completed'; round: number; route: string; status: string; costUsd: number }
  | { type: 'terminated'; round: number; reason: string; escalated: boolean }

export interface RunRoundDeps extends SeatRunnerDeps {
  wakeStore: WakeStore
  observer?: (event: LoopEvent) => void
}

export interface RoundOutcome {
  round: number
  mode: RoundMode
  route: string
  status: string
  costUsd: number
}

/** Lifetime budget check — ledger is the authority (D13); deadline included (T4.1). */
function lifetimeExhausted(
  charter: FrozenCharter,
  progress: { iteration: number; totalCostUsd: number },
  now = Date.now(),
): boolean {
  const life = charter.budgets?.lifetime
  if (!life) return false
  return (
    (life.rounds !== undefined && progress.iteration >= life.rounds) ||
    (life.usd !== undefined && progress.totalCostUsd >= life.usd) ||
    (life.deadlineMs !== undefined && now >= life.deadlineMs)
  )
}

export async function runRound(
  instance: LoopInstance,
  wake: WakeRecord,
  deps: RunRoundDeps,
): Promise<RoundOutcome> {
  const waitDeps = { wakeStore: deps.wakeStore, projectDir: deps.projectDir }
  try {
    // ── 2. RECONCILE ──────────────────────────────────────────────────────────
    await deps.wakeStore.reconcileOrphans()
    await ingestEvents(instance, waitDeps)
    await reconcileWaiting(instance, waitDeps)

    const pending = await readPendingRound(instance)
    if (pending) {
      if (pending.kind === 'self_timer') {
        // Self-timer park: the firing timer wake IS the resume signal. If it fired
        // early (coalesced), keep waiting until fireAt.
        if (Date.now() >= (pending.fireAt ?? 0)) {
          await setInstanceStatus(instance, 'running')
          return await harvestSegment(instance, deps, pending)
        }
        await setInstanceStatus(instance, 'waiting')
        return {
          round: pending.round, mode: pending.mode,
          route: 'still-waiting', status: 'waiting', costUsd: 0,
        }
      }
      const effect = await effectLedgerFor(instance).get(pending.effectKey!)
      if (effect?.status === 'concluded') {
        await setInstanceStatus(instance, 'running')
        return await harvestSegment(instance, deps, pending)
      }
      // A coalesced timer fired while we wait — the probe/event owns progress.
      await setInstanceStatus(instance, 'waiting')
      return {
        round: pending.round, mode: pending.mode,
        route: 'still-waiting', status: 'waiting', costUsd: 0,
      }
    }

    await setInstanceStatus(instance, 'running')
    return await freshRound(instance, deps)
  } finally {
    await deps.wakeStore.release(wake.wakeId, 'done').catch(() => undefined)
  }
}

// ── fresh round (submit segment when the worker requests a wait) ──────────────

async function freshRound(instance: LoopInstance, deps: RunRoundDeps): Promise<RoundOutcome> {
  const { charter, ledger, paths } = instance
  const startedAt = Date.now()
  const seatSummaries: Record<string, string> = {}
  let costUsd = 0

  const progress = await ledger.readProgress()
  const round = progress.iteration + 1
  const budgetExhausted = lifetimeExhausted(charter, progress)
  deps.observer?.({ type: 'round_started', round, mode: 'normal' })

  // ── 4. MODE (pre-round tripwire read; D10: seats cannot veto) ───────────────
  const preCtx = buildCtx(progress.meters, {}, budgetExhausted)
  const preAction = firstTripwire(charter, preCtx)
  const mode: RoundMode = preAction?.mode ?? 'normal'

  if (preAction?.escalate || preAction?.stop || budgetExhausted) {
    const reason = preAction?.escalate ?? (budgetExhausted ? 'budget' : 'finalize')
    return terminate(instance, deps, {
      round, mode, reason,
      escalated: Boolean(preAction?.escalate) || budgetExhausted,
      startedAt, costUsd, seatSummaries, correctiveRetries: 0,
      observables: {}, meters: progress.meters,
    })
  }

  // ── 3+5a. CAPSULE (+ pivoter when this is a pivot round) ────────────────────
  let pivotDirective: string | undefined
  if (mode === 'pivot' && charter.seats.pivoter) {
    const capsuleForPivot = await buildCapsule({ paths, ledger, goal: charter.goal, round, mode })
    const pivot = await runPivoterSeat(deps, charter, paths, capsuleForPivot)
    costUsd += pivot.costUsd
    seatSummaries['pivoter'] = truncate(pivot.summary)
    pivotDirective = typeof pivot.data['directive'] === 'string' ? pivot.data['directive'] : undefined
  }
  const capsule = await buildCapsule({ paths, ledger, goal: charter.goal, round, mode, pivotDirective })

  // ── 5b+6. SEAT + GATE ───────────────────────────────────────────────────────
  const seatLoop = await runSeatLoop(instance, deps, capsule, seatSummaries)
  costUsd += seatLoop.costUsd

  if (seatLoop.kind === 'wait') {
    return submitSegment(instance, deps, {
      round, mode, startedAt, costUsd, seatSummaries,
      correctiveRetries: seatLoop.correctiveRetries,
      waitRequest: seatLoop.waitRequest!,
      submitSummary: seatLoop.worker?.summary ?? '',
    })
  }

  return completeRound(instance, deps, {
    round, mode, startedAt, costUsd, seatSummaries,
    correctiveRetries: seatLoop.correctiveRetries,
    worker: seatLoop.worker, judge: seatLoop.judge,
    budgetExhausted, baseProgress: progress,
  })
}

// ── seat loop: worker + per-cause corrective retries + gates ──────────────────

/**
 * What kind of wait the worker requested. Only two exist: a self-timer park
 * (the worker wakes itself), or an event wait (an external system concludes it
 * by dropping an events/ file). There is NO code probe — status polling and any
 * remedial action (account rotation, plateau judgement) live in the worker.
 */
type WaitRequest =
  | { mode: 'event'; effectKey: string; payload?: Record<string, unknown> }
  | { mode: 'self_timer'; afterMs: number; reason: string }

interface SeatLoopOutcome {
  kind: 'complete' | 'wait'
  worker: SeatResult | null
  judge: SeatResult | null
  correctiveRetries: number
  costUsd: number
  waitRequest?: WaitRequest
}

async function runSeatLoop(
  instance: LoopInstance,
  deps: RunRoundDeps,
  capsule: Capsule,
  seatSummaries: Record<string, string>,
  initialPreface?: string,
): Promise<SeatLoopOutcome> {
  const { charter, paths } = instance
  let judge: SeatResult | null = null
  let worker: SeatResult | null = null
  let corrective: string | undefined = initialPreface
  let correctiveRetries = 0
  let costUsd = 0
  const retried = { diversity: false, schema: false, judge: false }

  for (;;) {
    worker = await runWorkerSeat(deps, charter, paths, capsule, corrective)
    costUsd += worker.costUsd
    seatSummaries['worker'] = truncate(worker.summary)
    deps.observer?.({ type: 'seat_completed', round: capsule.round, seat: 'worker', ok: worker.ok, costUsd: worker.costUsd })

    // Self-timer park (worker called the timer tool) — takes priority: the
    // worker explicitly parked itself, no external effect involved.
    if (worker.timer) {
      return {
        kind: 'wait', worker, judge: null, correctiveRetries, costUsd,
        waitRequest: { mode: 'self_timer', afterMs: worker.timer.afterMs, reason: worker.timer.reason },
      }
    }
    // Event wait: the worker submitted external work and waits for an event
    // (an events/ file with this effectKey) to conclude it. No probe.
    if (worker.data['label'] === 'wait') {
      return {
        kind: 'wait', worker, judge: null, correctiveRetries, costUsd,
        waitRequest: {
          mode: 'event',
          effectKey: typeof worker.data['effectKey'] === 'string' && worker.data['effectKey']
            ? worker.data['effectKey']
            : `eff-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
          payload: isRecord(worker.data['payload']) ? worker.data['payload'] : undefined,
        },
      }
    }
    if (!worker.ok) break

    // Deterministic point: direction diversity (exact-match, code).
    const dup = await duplicatedDirection(instance)
    if (dup && !retried.diversity) {
      retried.diversity = true
      corrective = `【纠偏重试】你选择的方向 '${dup}' 与 directions_tried 完全重复。请换一个未出现在已试清单中的方向。`
      correctiveRetries++
      continue
    }

    const schemaErrs = await runSchemaGates(instance)
    if (schemaErrs.length > 0 && !retried.schema) {
      retried.schema = true
      corrective = `【纠偏重试】state 校验失败：${schemaErrs.join('; ')}`
      correctiveRetries++
      continue
    }
    if (charter.seats.judge) {
      judge = await runJudgeSeat(deps, charter, paths, judgeEvidence(charter))
      costUsd += judge.costUsd
      seatSummaries['judge'] = truncate(judge.summary)
      deps.observer?.({ type: 'seat_completed', round: capsule.round, seat: 'judge', ok: judge.ok, costUsd: judge.costUsd })
      const failMessages = judge.data['verdict'] === 'fail'
        ? (Array.isArray(judge.data['messages']) ? (judge.data['messages'] as unknown[]).map(String) : [])
        : []
      if (failMessages.length > 0 && !retried.judge) {
        retried.judge = true
        corrective = `【纠偏重试】评审未通过：\n- ${failMessages.join('\n- ')}`
        correctiveRetries++
        continue
      }
    }
    break
  }
  return { kind: 'complete', worker, judge, correctiveRetries, costUsd }
}

// ── submit segment ─────────────────────────────────────────────────────────────

interface SubmitInput {
  round: number
  mode: RoundMode
  startedAt: number
  costUsd: number
  seatSummaries: Record<string, string>
  correctiveRetries: number
  waitRequest: WaitRequest
  submitSummary: string
}

async function submitSegment(
  instance: LoopInstance,
  deps: RunRoundDeps,
  input: SubmitInput,
): Promise<RoundOutcome> {
  const base = {
    round: input.round,
    mode: input.mode,
    startedAt: input.startedAt,
    costUsdSoFar: input.costUsd,
    seatSummaries: input.seatSummaries,
    correctiveRetries: input.correctiveRetries,
    submitSummary: truncate(input.submitSummary, 2_000),
    createdAt: Date.now(),
  }

  // Self-timer park: no effect ledger — just persist the round and schedule a
  // plain timer wake that resumes it at fireAt.
  if (input.waitRequest.mode === 'self_timer') {
    const fireAt = Date.now() + input.waitRequest.afterMs
    await writePendingRound(instance, {
      ...base, kind: 'self_timer', reason: input.waitRequest.reason, fireAt,
    } satisfies PendingRound)
    await deps.wakeStore.schedule({ loopId: instance.record.instanceId, kind: 'timer', fireAt })
    await setInstanceStatus(instance, 'waiting', `self-timer: ${input.waitRequest.reason}`)
    deps.observer?.({
      type: 'waiting_entered', round: input.round,
      effectKey: `self_timer:${input.waitRequest.reason}`, waitName: 'self_timer',
    })
    return {
      round: input.round, mode: input.mode,
      route: 'waiting:self_timer', status: 'waiting', costUsd: input.costUsd,
    }
  }

  // Event wait: register the effect (idempotent, harvest-once) and park. No
  // probe is scheduled — an external system concludes it by dropping an
  // events/<effectKey>.json file (ingested by RECONCILE → harvest wake).
  const effects = effectLedgerFor(instance)
  await effects.submit({
    effectKey: input.waitRequest.effectKey,
    kind: 'event',
    waitName: 'event',
    payload: input.waitRequest.payload,
  })
  await writePendingRound(instance, {
    ...base, kind: 'effect',
    effectKey: input.waitRequest.effectKey,
    waitName: 'event',
  } satisfies PendingRound)
  await setInstanceStatus(instance, 'waiting', `waiting on event ${input.waitRequest.effectKey}`)
  deps.observer?.({
    type: 'waiting_entered', round: input.round,
    effectKey: input.waitRequest.effectKey, waitName: 'event',
  })
  return {
    round: input.round, mode: input.mode,
    route: 'waiting:event', status: 'waiting', costUsd: input.costUsd,
  }
}

// ── harvest segment ────────────────────────────────────────────────────────────

async function harvestSegment(
  instance: LoopInstance,
  deps: RunRoundDeps,
  pending: PendingRound,
): Promise<RoundOutcome> {
  const { charter, ledger, paths } = instance
  const effects = effectLedgerFor(instance)
  const isSelfTimer = pending.kind === 'self_timer'
  const effectKey = isSelfTimer ? null : pending.effectKey!
  const progress = await ledger.readProgress()
  const budgetExhausted = lifetimeExhausted(charter, progress)
  deps.observer?.({
    type: 'harvest_started', round: pending.round,
    effectKey: effectKey ?? `self_timer:${pending.reason ?? ''}`,
  })

  const capsule = await buildCapsule({
    paths, ledger, goal: charter.goal, round: pending.round, mode: pending.mode,
  })
  // Lineage digest (D5): the harvest/continue worker knows WHAT it parked on and
  // WHY, via the submit summary — not via a shared transcript.
  let preface: string
  if (isSelfTimer) {
    preface = [
      `【继续】已到你设定的时间（原因：${pending.reason ?? '?'}）。`,
      `【提交段摘要】${pending.submitSummary || '(无摘要)'}`,
      '请自行检查外部任务状态，决定：继续等待（再调 timer）还是收割（整理 findings/direction 草稿后 return_result data={"label":"ok"}）。',
    ].join('\n')
  } else {
    const effect = (await effects.get(effectKey!))!
    preface = [
      '【收割段】你（或你的前身）在本轮提交段启动了外部任务，现已结束。',
      `【提交段摘要】${pending.submitSummary || '(无摘要)'}`,
      `【外部任务结果】verdict=${effect.outcome?.verdict ?? 'unknown'} via=${effect.outcome?.via ?? '?'}`,
      `【结果数据】${truncate(JSON.stringify(effect.outcome?.data ?? null), 3_000)}`,
      '请基于结果完成本轮剩余工作（整理 findings 草稿等），遵守产出契约。',
    ].join('\n')
  }

  const seatSummaries: Record<string, string> = { ...pending.seatSummaries }
  const seatLoop = await runSeatLoop(instance, deps, capsule, seatSummaries, preface)
  const costUsd = pending.costUsdSoFar + seatLoop.costUsd

  if (seatLoop.kind === 'wait') {
    // Chained wait / self-timer re-park: same round parks again.
    if (effectKey) await effects.markHarvested(effectKey)
    return submitSegment(instance, deps, {
      round: pending.round, mode: pending.mode, startedAt: pending.startedAt,
      costUsd, seatSummaries,
      correctiveRetries: pending.correctiveRetries + seatLoop.correctiveRetries,
      waitRequest: seatLoop.waitRequest!,
      submitSummary: seatLoop.worker?.summary ?? '',
    })
  }

  const outcome = await completeRound(instance, deps, {
    round: pending.round, mode: pending.mode, startedAt: pending.startedAt,
    costUsd, seatSummaries,
    correctiveRetries: pending.correctiveRetries + seatLoop.correctiveRetries,
    worker: seatLoop.worker, judge: seatLoop.judge,
    budgetExhausted, baseProgress: progress,
  })
  // Order matters for crash recovery: round ledger writes happened inside
  // completeRound → clear pending → settle the effect. reconcileWaiting heals
  // every interleaving of a crash between these three.
  await clearPendingRound(instance)
  if (effectKey) await effects.markHarvested(effectKey)
  return outcome
}

// ── complete: METER ▸ LEDGER ▸ ROUTE ──────────────────────────────────────────

interface CompleteInput {
  round: number
  mode: RoundMode
  startedAt: number
  costUsd: number
  seatSummaries: Record<string, string>
  correctiveRetries: number
  worker: SeatResult | null
  judge: SeatResult | null
  budgetExhausted: boolean
  baseProgress: Awaited<ReturnType<LoopInstance['ledger']['readProgress']>>
}

async function completeRound(
  instance: LoopInstance,
  deps: RunRoundDeps,
  input: CompleteInput,
): Promise<RoundOutcome> {
  const { charter, ledger } = instance
  const { baseProgress: progress } = input

  // ── 7. METER ──────────────────────────────────────────────────────────────
  const observables = collectObservables(charter, input.judge)
  const meters = { ...progress.meters }
  const meterCtx = buildCtx(meters, observables, input.budgetExhausted)
  for (const meter of charter.meters) {
    const asts = charter.frozen.meterAsts[meter.name] ?? {}
    if (meter.inc === 'every_round') {
      meters[meter.name] = (meters[meter.name] ?? 0) + 1
    } else if (asts.incWhen && safeEval(asts.incWhen, meterCtx, !input.worker?.ok)) {
      meters[meter.name] = (meters[meter.name] ?? 0) + 1
    } else if (asts.resetWhen && safeEval(asts.resetWhen, meterCtx, false)) {
      meters[meter.name] = 0
    }
  }

  // ── 8. LEDGER: admit drafts, then account the round ───────────────────────
  const admitted = await admitDrafts(instance, input.judge)
  const metric = typeof input.judge?.data['metric'] === 'number' ? (input.judge.data['metric'] as number) : null
  const bestMetric = metric !== null && (progress.bestMetric === null || metric > progress.bestMetric)
    ? metric
    : progress.bestMetric

  // ── 9. ROUTE (post-METER tripwire read) ───────────────────────────────────
  // Built-in acceptance (symmetric with the built-in lifetime budget): if the
  // judge reports the goal satisfied, the KERNEL ends the loop — no charter
  // tripwire required. The judgment is the judge's; the decision is the kernel's.
  const accepted = input.judge?.data['goal_satisfied'] === true
  const postCtx = buildCtx(meters, observables, input.budgetExhausted)
  const postAction = accepted ? null : firstTripwire(charter, postCtx)
  const route = accepted ? 'finalize:goal_satisfied' : describeAction(postAction)
  const status = accepted ? 'completed' : statusFor(postAction, meters)

  await ledger.appendRound({
    round: input.round, mode: input.mode, observables, meters, route,
    correctiveRetries: input.correctiveRetries, costUsd: input.costUsd,
    seatSummaries: input.seatSummaries,
    startedAt: input.startedAt, finishedAt: Date.now(),
  } satisfies RoundEntry)
  await ledger.writeProgress({
    iteration: input.round,
    meters,
    status,
    bestMetric,
    totalFindings: progress.totalFindings + admitted,
    totalCostUsd: progress.totalCostUsd + input.costUsd,
    updatedAt: Date.now(),
  })

  if (accepted) {
    return terminate(instance, deps, {
      round: input.round, mode: input.mode,
      reason: 'goal_satisfied', escalated: false,
      startedAt: input.startedAt, costUsd: input.costUsd,
      seatSummaries: input.seatSummaries, correctiveRetries: input.correctiveRetries,
      observables, meters, alreadyAccounted: true,
    })
  }

  if (postAction?.escalate || postAction?.stop) {
    return terminate(instance, deps, {
      round: input.round, mode: input.mode,
      reason: postAction.escalate ?? 'finalize',
      escalated: Boolean(postAction.escalate),
      startedAt: input.startedAt, costUsd: input.costUsd,
      seatSummaries: input.seatSummaries, correctiveRetries: input.correctiveRetries,
      observables, meters, alreadyAccounted: true,
    })
  }

  await deps.wakeStore.schedule({
    loopId: instance.record.instanceId,
    kind: 'timer',
    fireAt: Date.now() + (charter.roundIntervalMs ?? 0),
  })
  await setInstanceStatus(instance, 'idle')
  deps.observer?.({ type: 'round_completed', round: input.round, route, status, costUsd: input.costUsd })
  return { round: input.round, mode: input.mode, route, status, costUsd: input.costUsd }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function buildCtx(
  meters: Record<string, number>,
  observables: Record<string, number | boolean | string>,
  budgetExhausted: boolean,
): EvalContext {
  return { ...observables, ...meters, 'budget.lifetime.exhausted': budgetExhausted }
}

/** First matching tripwire in declaration order (charter authors rank them). */
function firstTripwire(charter: FrozenCharter, ctx: EvalContext): TripwireAction | null {
  for (const [i, ast] of charter.frozen.tripwireAsts.entries()) {
    if (safeEval(ast, ctx, false)) return charter.tripwires[i]!.then
  }
  return null
}

/**
 * Tripwires/meters may reference judge observables that are missing when the
 * worker failed outright. `fallback` decides how a missing-context evaluation
 * counts: meter incWhen falls back to TRUE on a failed round (a failed round
 * IS stale), everything else to false.
 */
function safeEval(ast: Parameters<typeof evaluateBool>[0], ctx: EvalContext, fallback: boolean): boolean {
  try {
    return evaluateBool(ast, ctx)
  } catch {
    return fallback
  }
}

function collectObservables(
  charter: FrozenCharter,
  judge: SeatResult | null,
): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {}
  for (const spec of charter.observables) {
    if (spec.source.from === 'judge') {
      const v = judge?.data[spec.source.key]
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[spec.name] = v
    }
  }
  return out
}

/** Admit findings drafts into the ledger; returns number admitted. Drafts are
 * consumed either way (a rejected draft must not haunt the next round). */
async function admitDrafts(instance: LoopInstance, judge: SeatResult | null): Promise<number> {
  const { paths, ledger } = instance
  const draftPath = join(paths.draftsDir, 'findings_draft.json')
  let admitted = 0
  try {
    const raw = await readFile(draftPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    const entries = Array.isArray(parsed) ? parsed : [parsed]
    const pass = !judge || judge.data['verdict'] !== 'fail'
    if (pass) {
      for (const entry of entries) {
        await ledger.appendJsonl(paths.findingsJsonl, entry)
        admitted++
      }
    }
  } catch {
    // no draft — a legitimate zero-findings round
  }
  await rm(draftPath, { force: true }).catch(() => undefined)

  const dirPath = join(paths.draftsDir, 'direction.json')
  try {
    const raw = JSON.parse(await readFile(dirPath, 'utf-8')) as { key?: unknown }
    if (typeof raw.key === 'string' && raw.key) {
      const file = await ledger.readJson<{ directions: unknown[] }>(paths.directionsJson)
      const directions = file?.directions ?? []
      if (!directions.some(d => typeof d === 'object' && d !== null && (d as { key?: unknown }).key === raw.key)) {
        await ledger.replaceJson(paths.directionsJson, { directions: [...directions, raw] })
      }
    }
  } catch { /* no direction draft */ }
  await rm(dirPath, { force: true }).catch(() => undefined)
  return admitted
}

async function duplicatedDirection(instance: LoopInstance): Promise<string | null> {
  const { paths, ledger } = instance
  try {
    const draft = JSON.parse(await readFile(join(paths.draftsDir, 'direction.json'), 'utf-8')) as { key?: unknown }
    if (typeof draft.key !== 'string' || !draft.key) return null
    const file = await ledger.readJson<{ directions: unknown[] }>(paths.directionsJson)
    const dup = (file?.directions ?? []).some(
      d => typeof d === 'object' && d !== null && (d as { key?: unknown }).key === draft.key,
    )
    return dup ? draft.key : null
  } catch {
    return null
  }
}

async function runSchemaGates(instance: LoopInstance): Promise<string[]> {
  const errs: string[] = []
  for (const gate of Object.values(instance.charter.gates ?? {})) {
    if (gate.kind !== 'schema') continue
    for (const rel of gate.files) {
      const abs = join(instance.paths.root, rel)
      try {
        JSON.parse(await readFile(abs, 'utf-8'))
      } catch (err) {
        errs.push(`${rel}: ${(err as Error).message}`)
      }
    }
  }
  return errs
}

function judgeEvidence(charter: FrozenCharter): string[] {
  for (const gate of Object.values(charter.gates ?? {})) {
    if (gate.kind === 'judge') return gate.evidence
  }
  return []
}

function describeAction(action: TripwireAction | null): string {
  if (!action) return 'continue'
  if (action.escalate) return `escalate:${action.escalate}`
  if (action.mode) return action.stop ? `${action.mode}+stop` : `mode:${action.mode}`
  return action.stop ? 'stop' : 'continue'
}

function statusFor(action: TripwireAction | null, meters: Record<string, number>): string {
  if (action?.escalate) return 'attention_required'
  if (action?.mode === 'finalize') return 'completed'
  if (action?.mode === 'pivot') return 'pivot_required'
  return (meters['stale_count'] ?? 0) > 0 ? 'stale' : 'healthy'
}

interface TerminateInput {
  round: number
  mode: RoundMode
  reason: string
  escalated: boolean
  startedAt: number
  costUsd: number
  seatSummaries: Record<string, string>
  correctiveRetries: number
  observables: Record<string, number | boolean | string>
  meters: Record<string, number>
  alreadyAccounted?: boolean
}

/** Stop path: render the report from the LEDGER (code template), park the
 * instance, cancel pending wakes. Fail-stop, never fail-silent (D10). */
async function terminate(
  instance: LoopInstance,
  deps: RunRoundDeps,
  input: TerminateInput,
): Promise<RoundOutcome> {
  const { ledger, paths } = instance
  const terminalStatus = input.escalated ? 'attention_required' : 'completed'
  if (!input.alreadyAccounted) {
    await ledger.appendRound({
      round: input.round, mode: input.mode,
      observables: input.observables, meters: input.meters,
      route: input.escalated ? `escalate:${input.reason}` : 'finalize+stop',
      correctiveRetries: input.correctiveRetries, costUsd: input.costUsd,
      seatSummaries: input.seatSummaries,
      startedAt: input.startedAt, finishedAt: Date.now(),
    })
  }
  const report = await renderReport(instance, input.reason)
  const reportName = input.escalated ? 'attention_report.md' : 'final_report.md'
  await atomicWriteFile(join(paths.reportsDir, reportName), report)
  await deps.wakeStore.cancelForLoop(instance.record.instanceId)
  await setInstanceStatus(
    instance,
    input.escalated ? 'paused_attention' : 'done',
    `${input.reason} at round ${input.round}`,
  )
  deps.observer?.({ type: 'terminated', round: input.round, reason: input.reason, escalated: input.escalated })
  return {
    round: input.round, mode: input.mode,
    route: input.escalated ? `escalate:${input.reason}` : 'finalize+stop',
    status: terminalStatus, costUsd: input.costUsd,
  }
}

async function renderReport(instance: LoopInstance, reason: string): Promise<string> {
  const view = await instance.ledger.readView(50)
  const lines = [
    `# Loop Report — ${instance.record.instanceId}`,
    '',
    `- reason: ${reason}`,
    `- rounds: ${view.progress.iteration}`,
    `- status: ${view.progress.status}`,
    `- best_metric: ${view.progress.bestMetric ?? 'null'}`,
    `- total findings: ${view.findingsCount}`,
    `- total cost: $${view.progress.totalCostUsd.toFixed(2)}`,
    '',
    '## Rounds',
    ...view.lastRounds.map(r =>
      `- #${r.round} [${r.mode}] route=${r.route} retries=${r.correctiveRetries} cost=$${r.costUsd.toFixed(2)}`),
    '',
    '## Directions tried',
    ...view.directions.map(d => `- ${JSON.stringify(d)}`),
    '',
    '## Findings',
    ...view.lastFindings.map(f => `- ${JSON.stringify(f)}`),
    '',
    `Generated at ${new Date().toISOString()} from the ledger (code template).`,
  ]
  return lines.join('\n') + '\n'
}

function truncate(s: string, n = 300): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
