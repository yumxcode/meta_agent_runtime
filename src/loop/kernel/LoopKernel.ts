/**
 * LoopKernel — the fixed nine-step round pipeline (spec §2, C7).
 *
 *   WAKE ▶ RECONCILE ▶ MODE ▶ CAPSULE ▶ SEAT ▶ GATE ▶ METER ▶ LEDGER ▶ ROUTE
 *
 * Control flow is HOST CODE — no LLM ever decides what step comes next. The
 * only intelligent moments are SEAT (worker/pivoter/finalizer) and the judge
 * half of GATE; every kernel decision is an expression evaluation over the
 * frozen charter, and every round leaves one audited RoundEntry behind.
 *
 * v3 invariants (mode/route/status redesign):
 *   • Tripwires are evaluated EXACTLY ONCE per round, at ROUTE, on the freshest
 *     meters. The result either executes now (finalize/escalate) or persists as
 *     the next round's explicit directive (pivot → progress.nextRoundMode).
 *   • MODE never reads tripwires: it consumes the one-shot pivot directive and
 *     runs the built-in budget guard. The kernel owns WHETHER the loop may
 *     continue (budget, acceptance); the charter owns WHEN to pivot/finalize/
 *     escalate.
 *   • Every status value is a total function of the RouteDecision — there is no
 *     label the kernel ignores, and 'completed' is written ONLY on termination.
 *
 * M2: a round may SPLIT into a submit segment and a harvest segment. The
 * worker requests a wait ({label:'wait', wait:'<name>', …}); the kernel
 * registers the effect, persists pending_round.json, schedules a probe wake
 * and lets the process EXIT. Hours later a probe/event concludes the effect
 * and a harvest wake resumes the SAME round — worker lineage carried by the
 * submit-segment digest, meters/gates untouched in between.
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { resolveExistingInside } from '../security/PathSafety.js'
import { collectRefs, evaluateBool, type EvalContext } from '../expr/Expr.js'
import { PRODUCER_OK_OBSERVABLE } from '../charter/CharterTypes.js'
import type {
  FrozenCharter,
  ObjectiveFailurePolicy,
  ObservationFailurePolicy,
  ShapeSpec,
  TripwireAction,
} from '../charter/CharterTypes.js'
import type { LoopInstance } from '../instance/InstanceStore.js'
import { setInstanceStatus } from '../instance/InstanceStore.js'
import { archiveInbox, buildCapsule, readInbox, type Capsule } from '../capsule/CapsuleBuilder.js'
import { runFinalizerSeat, runJudgeSeat, runPivoterSeat, runWorkerSeat, type SeatResult, type SeatRunnerDeps } from './Seats.js'
import { WakeStore, type WakeRecord } from '../wake/WakeStore.js'
import { atomicWriteFile } from '../../infra/persist/index.js'
import { runConditionalCounterProjection } from '../projection/ConditionalCounterReducer.js'
import { gateBinding } from '../charter/ExecutionPlan.js'
import { scenarioRuntimeFor } from '../scenarios/ScenarioRuntime.js'
import {
  normalizeRoundMode,
  renderRoute,
  type PendingRound,
  type ObservationResult,
  type ProgressStatus,
  type RoundEntry,
  type RoundMode,
  type RouteDecision,
} from '../types.js'
import {
  clearPendingRound,
  effectLedgerFor,
  ingestEvents,
  readPendingRound,
  reconcileWaiting,
  writePendingRound,
} from '../effects/WaitOps.js'
import {
  defaultEffectAdapterRegistry,
  EVENT_EFFECT_ADAPTER_ID,
  type EffectAdapterRegistry,
} from '../effects/EffectAdapter.js'
import { advanceEffect, submitEffect } from '../effects/EffectRuntime.js'
import type { EffectRetryPolicy } from '../effects/EffectLedger.js'

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
  effectAdapters?: EffectAdapterRegistry
  observer?: (event: LoopEvent) => void
}

export class RoundAbortedError extends Error {
  constructor(public readonly costUsd: number) {
    super('loop round aborted after its active seat reached a terminal state')
    this.name = 'RoundAbortedError'
  }
}

export class RoundExecutionUncertainError extends Error {
  constructor(public readonly taskId: string, public readonly costUsd: number) {
    super(`loop seat ${taskId} did not confirm terminal cancellation; refusing replay`)
    this.name = 'RoundExecutionUncertainError'
  }
}

function assertReplaySafeSeat(seat: SeatResult, attemptCostUsd: number): void {
  if (seat.termination === 'cancellation_unconfirmed') {
    throw new RoundExecutionUncertainError(seat.taskId, attemptCostUsd)
  }
  if (seat.termination === 'aborted') throw new RoundAbortedError(attemptCostUsd)
}

function remainingSeatUsd(
  charter: FrozenCharter,
  lifetimeCostUsd: number,
  spentThisRoundUsd: number,
): number | undefined {
  const limits: number[] = []
  const roundCap = charter.budgets?.perRound?.usd
  if (roundCap !== undefined) limits.push(roundCap - spentThisRoundUsd)
  const lifeCap = charter.budgets?.lifetime?.usd
  if (lifeCap !== undefined) limits.push(lifeCap - lifetimeCostUsd - spentThisRoundUsd)
  return limits.length > 0 ? Math.max(0, Math.min(...limits)) : undefined
}

function budgetBlockedSeat(summary: string): SeatResult {
  return {
    ok: false,
    summary,
    data: {},
    structured: true,
    costUsd: 0,
    turnsUsed: 0,
    termination: 'terminal',
    taskId: 'budget-blocked',
  }
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

/**
 * Guarded kernel status transition. `expectFrom` re-validates against DISK
 * under the file lock, closing the pause-vs-claimed-wake race: a human pause
 * committed after the runner's HALTED check must not be silently overwritten
 * by a blind 'running' write (the round would run while the audit says
 * paused). Returns false when refused — the caller treats the wake as stale.
 */
async function tryStatus(
  instance: LoopInstance,
  status: 'running' | 'waiting',
  reason?: string,
): Promise<boolean> {
  try {
    await setInstanceStatus(instance, status, reason, {
      expectFrom: ['idle', 'waiting', 'running'],
    })
    return true
  } catch {
    return false
  }
}

/** Outcome for a wake refused by a concurrent pause/terminal transition. */
function staleOutcome(round: number, mode: RoundMode, status: string): RoundOutcome {
  return { round, mode, route: 'stale-wake', status, costUsd: 0 }
}

export async function runRound(
  instance: LoopInstance,
  wake: WakeRecord,
  deps: RunRoundDeps,
): Promise<RoundOutcome> {
  const effectAdapters = deps.effectAdapters ?? defaultEffectAdapterRegistry()
  const waitDeps = { wakeStore: deps.wakeStore, projectDir: deps.projectDir, effectAdapters }
  // Keep the wake claim fresh for the WHOLE round: seats legally run far longer
  // than the claim TTL (wallclockMin can be hours vs a 10-min TTL), and an
  // expired claim would let a concurrent `loop tick` re-pend + re-claim this
  // wake and run a duplicate round (double spend, interleaved ledger writes).
  // (The runner heartbeats the same wake around runClaimedWake; this interval
  // additionally covers direct runRound callers such as tests/CLI one-shots.)
  const heartbeat = setInterval(() => {
    void deps.wakeStore.heartbeat(wake.wakeId).catch(() => undefined)
  }, 60_000)
  heartbeat.unref?.()
  try {
    if (deps.signal.aborted) throw new RoundAbortedError(0)
    // ── 2. RECONCILE ──────────────────────────────────────────────────────────
    await deps.wakeStore.reconcileOrphans()
    await ingestEvents(instance, waitDeps)
    await reconcileWaiting(instance, waitDeps)
    await scenarioRuntimeFor(instance.charter).reconcileArtifacts(instance)

    const pending = await readPendingRound(instance)
    if (
      (wake.kind === 'event' || wake.kind === 'effect_poll') &&
      (!pending || pending.kind !== 'effect' || pending.effectKey !== wake.effectKey)
    ) {
      const progress = await instance.ledger.readProgress()
      return {
        round: pending?.round ?? progress.iteration,
        mode: pending ? normalizeRoundMode(pending.mode) : 'normal',
        route: 'stale-wake',
        status: instance.record.status,
        costUsd: 0,
      }
    }
    if (pending) {
      if (wake.kind === 'effect_poll' && pending.kind === 'effect') {
        const advanced = await advanceEffect(
          instance, deps.wakeStore, pending.effectKey!, effectAdapters, 'inspect',
        )
        if (advanced?.status === 'failed') {
          await setInstanceStatus(
            instance, 'failed',
            `effect ${pending.effectKey} failed: ${advanced.lastError ?? 'operator reconciliation required'}`,
          )
          await deps.wakeStore.cancelForLoop(instance.record.instanceId)
          return {
            round: pending.round, mode: normalizeRoundMode(pending.mode),
            route: 'effect-failed', status: 'failed', costUsd: 0,
          }
        }
        if (advanced?.status !== 'concluded') {
          await tryStatus(instance, 'waiting')
          return {
            round: pending.round, mode: normalizeRoundMode(pending.mode),
            route: 'still-waiting', status: 'waiting', costUsd: 0,
          }
        }
      }
      if (pending.kind !== 'self_timer' && pending.timedOutAt) {
        const progress = await instance.ledger.readProgress()
        if (progress.iteration >= pending.round) {
          await clearPendingRound(instance)
          await effectLedgerFor(instance).markFailed(pending.effectKey!, 'event wait timed out')
          return {
            round: pending.round, mode: normalizeRoundMode(pending.mode),
            route: 'already-accounted', status: progress.status, costUsd: 0,
          }
        }
        if (!await tryStatus(instance, 'running')) {
          return staleOutcome(pending.round, normalizeRoundMode(pending.mode), instance.record.status)
        }
        const outcome = await terminate(instance, deps, {
          round: pending.round,
          mode: normalizeRoundMode(pending.mode),
          route: {
            kind: 'escalate', cause: 'effect_timeout',
            reason: `external event '${pending.effectKey}' did not arrive before its deadline`,
          },
          startedAt: pending.startedAt,
          costUsd: pending.costUsdSoFar + (wake.abortedCostUsd ?? 0),
          seatSummaries: pending.seatSummaries,
          correctiveRetries: pending.correctiveRetries,
          observables: {},
          meters: progress.meters,
        })
        await clearPendingRound(instance)
        await effectLedgerFor(instance).markFailed(pending.effectKey!, 'event wait timed out')
        return outcome
      }
      if (pending.kind === 'self_timer') {
        // Self-timer park: the firing timer wake IS the resume signal. If it fired
        // early (coalesced), keep waiting until fireAt.
        if (Date.now() >= (pending.fireAt ?? 0)) {
          if (!await tryStatus(instance, 'running')) {
            return staleOutcome(pending.round, pending.mode, instance.record.status)
          }
          return await harvestSegment(instance, deps, pending, wake.abortedCostUsd ?? 0)
        }
        // Fired early (a coalesced/foreign timer): this wake is consumed on
        // release, so re-arm the REAL resume wake at fireAt — otherwise the
        // park would strand until a manual resume (schedule() coalesces, so
        // this is idempotent).
        await deps.wakeStore.schedule({
          loopId: instance.record.instanceId, kind: 'timer', fireAt: pending.fireAt ?? Date.now(),
        })
        await tryStatus(instance, 'waiting')
        return {
          round: pending.round, mode: pending.mode,
          route: 'still-waiting', status: 'waiting', costUsd: 0,
        }
      }
      const effect = await effectLedgerFor(instance).get(pending.effectKey!)
      if (effect?.status === 'concluded') {
        if (effect.outcome?.verdict === 'effect_rule_escalate') {
          const progress = await instance.ledger.readProgress()
          const data = isRecord(effect.outcome.data) ? effect.outcome.data : {}
          const reason = typeof data['reason'] === 'string'
            ? data['reason']
            : `Effect Rule escalated '${pending.effectKey}'`
          if (!await tryStatus(instance, 'running')) {
            return staleOutcome(pending.round, normalizeRoundMode(pending.mode), instance.record.status)
          }
          const outcome = await terminate(instance, deps, {
            round: pending.round,
            mode: normalizeRoundMode(pending.mode),
            route: { kind: 'escalate', cause: 'effect_rule', reason },
            startedAt: pending.startedAt,
            costUsd: pending.costUsdSoFar + (wake.abortedCostUsd ?? 0),
            seatSummaries: pending.seatSummaries,
            correctiveRetries: pending.correctiveRetries,
            observables: {},
            meters: progress.meters,
          })
          await clearPendingRound(instance)
          await effectLedgerFor(instance).markHarvested(pending.effectKey!)
          return outcome
        }
        if (!await tryStatus(instance, 'running')) {
          return staleOutcome(pending.round, normalizeRoundMode(pending.mode), instance.record.status)
        }
        return await harvestSegment(instance, deps, pending, wake.abortedCostUsd ?? 0)
      }
      // A coalesced timer fired while we wait — the probe/event owns progress.
      await tryStatus(instance, 'waiting')
      return {
        round: pending.round, mode: normalizeRoundMode(pending.mode),
        route: 'still-waiting', status: 'waiting', costUsd: 0,
      }
    }

    if (!await tryStatus(instance, 'running')) {
      const progress = await instance.ledger.readProgress()
      return staleOutcome(progress.iteration + 1, 'normal', instance.record.status)
    }
    return await freshRound(instance, deps, wake.abortedCostUsd ?? 0)
  } finally {
    clearInterval(heartbeat)
  }
}

// ── fresh round (submit segment when the worker requests a wait) ──────────────

async function freshRound(instance: LoopInstance, deps: RunRoundDeps, carriedCostUsd = 0): Promise<RoundOutcome> {
  const { charter, ledger, paths } = instance
  const startedAt = Date.now()
  const seatSummaries: Record<string, string> = {}
  let costUsd = carriedCostUsd
  let attemptCostUsd = 0

  const progress = await ledger.readProgress()
  const round = progress.iteration + 1

  // ── 3. MODE — no tripwire read here (v3: single evaluation point is ROUTE).
  // Consume the one-shot pivot directive persisted by the previous ROUTE.
  const mode: RoundMode = progress.nextRoundMode === 'pivot' && charter.seats.pivoter ? 'pivot' : 'normal'
  deps.observer?.({ type: 'round_started', round, mode })

  // Built-in budget guard: when the lifetime budget is exhausted BEFORE any
  // seat runs (e.g. a deadline passed while idle), the loop must not spend.
  // The charter may still claim this boundary via an escalate/finalize tripwire
  // on budget.lifetime.exhausted; otherwise the kernel finalizes.
  if (lifetimeExhausted(charter, { ...progress, totalCostUsd: progress.totalCostUsd + carriedCostUsd })) {
    const route = terminalRouteForExhaustion(charter, buildCtx(progress.meters, {}, true))
    return terminate(instance, deps, {
      round, mode, route,
      startedAt, costUsd, seatSummaries, correctiveRetries: 0,
      observables: {}, meters: progress.meters,
    })
  }

  // ── 4+5a. CAPSULE (+ pivoter when this is a pivot round) ────────────────────
  // Inbox consumption is TRANSACTIONAL with the round: read (non-destructive)
  // here, archive to processed/ only after the round durably commits
  // (completeRound / submitSegment). An aborted or replayed round therefore
  // re-reads the same human feedback instead of silently losing it.
  const inbox = await readInbox(paths)
  const inboxMessages = inbox.messages
  let pivotDirective: string | undefined
  if (mode === 'pivot' && charter.seats.pivoter) {
    const capsuleForPivot = await buildCapsule({ paths, ledger, goal: charter.goal, round, mode, inboxMessages })
    const pivotLimit = remainingSeatUsd(charter, progress.totalCostUsd, costUsd)
    const pivot = pivotLimit !== undefined && pivotLimit <= 0
      ? budgetBlockedSeat('pivoter skipped: round/lifetime USD budget exhausted')
      : await runPivoterSeat(deps, charter, paths, capsuleForPivot, { usd: pivotLimit })
    costUsd += pivot.costUsd
    attemptCostUsd += pivot.costUsd
    assertReplaySafeSeat(pivot, attemptCostUsd)
    seatSummaries['pivoter'] = truncate(pivot.summary)
    pivotDirective = typeof pivot.data['directive'] === 'string' ? pivot.data['directive'] : undefined
  }
  const capsule = await buildCapsule({ paths, ledger, goal: charter.goal, round, mode, pivotDirective, inboxMessages })

  // ── 5b+6. SEAT + GATE ───────────────────────────────────────────────────────
  let seatLoop: SeatLoopOutcome
  try {
    seatLoop = await runSeatLoop(instance, deps, capsule, seatSummaries, undefined, costUsd)
  } catch (err) {
    if (err instanceof RoundAbortedError) throw new RoundAbortedError(attemptCostUsd + err.costUsd)
    if (err instanceof RoundExecutionUncertainError) {
      throw new RoundExecutionUncertainError(err.taskId, attemptCostUsd + err.costUsd)
    }
    throw err
  }
  costUsd += seatLoop.costUsd

  if (seatLoop.kind === 'wait') {
    return submitSegment(instance, deps, {
      round, mode, startedAt, costUsd, seatSummaries,
      correctiveRetries: seatLoop.correctiveRetries,
      waitRequest: seatLoop.waitRequest!,
      submitSummary: seatLoop.worker?.summary ?? '',
      inboxFiles: inbox.files,
    })
  }

  return completeRound(instance, deps, {
    round, mode, startedAt, costUsd, seatSummaries,
    correctiveRetries: seatLoop.correctiveRetries,
    worker: seatLoop.worker, judge: seatLoop.judge,
    baseProgress: progress,
    inboxFiles: inbox.files,
  })
}

/**
 * Terminal route when the lifetime budget is exhausted: the first matching
 * tripwire may claim the boundary (escalate → hand to a human; finalize →
 * graceful stop with its reason); a pivot match cannot be honored (no rounds
 * remain), so the kernel's built-in finalize(budget) applies.
 */
function terminalRouteForExhaustion(charter: FrozenCharter, ctx: EvalContext): RouteDecision {
  const hit = firstTripwire(charter, ctx)
  if (hit?.kind === 'fail_stop') {
    return { kind: 'escalate', cause: 'rule_error', reason: hit.reason }
  }
  if (hit?.kind === 'hit' && hit.action.act === 'escalate') {
    return { kind: 'escalate', cause: 'tripwire', tripwireIndex: hit.index, reason: hit.action.reason }
  }
  if (hit?.kind === 'hit' && hit.action.act === 'finalize') {
    return { kind: 'finalize', cause: 'tripwire', tripwireIndex: hit.index, reason: hit.action.reason ?? 'finalize' }
  }
  return { kind: 'finalize', cause: 'budget', reason: 'budget' }
}

// ── seat loop: worker + per-cause corrective retries + gates ──────────────────

/**
 * What kind of wait the worker requested. Only two exist: a self-timer park
 * (the worker wakes itself), or an event wait (an external system concludes it
 * by dropping an events/ file). There is NO code probe — status polling and any
 * remedial action (account rotation, plateau judgement) live in the worker.
 */
type WaitRequest =
  | {
      mode: 'event'; effectKey: string; payload?: Record<string, unknown>; maxWaitMs: number;
      adapterId: string; effectBindingId?: string; authRequired: boolean; retryPolicy: EffectRetryPolicy
    }
  | { mode: 'self_timer'; afterMs: number; reason: string }

const DEFAULT_EVENT_MAX_WAIT_MS = 7 * 24 * 60 * 60_000
const MIN_EVENT_MAX_WAIT_MS = 60_000
const MAX_EVENT_MAX_WAIT_MS = 30 * 24 * 60 * 60_000
const DEFAULT_SELF_TIMER_MAX_PARKS = 48
const DEFAULT_SELF_TIMER_MAX_ELAPSED_MS = 24 * 60 * 60_000
const DEFAULT_EFFECT_RETRY: EffectRetryPolicy = {
  maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000, callTimeoutMs: 30_000,
}

function eventMaxWaitMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) &&
    value >= MIN_EVENT_MAX_WAIT_MS && value <= MAX_EVENT_MAX_WAIT_MS
    ? Math.floor(value)
    : DEFAULT_EVENT_MAX_WAIT_MS
}

function effectRetryPolicy(value: unknown): EffectRetryPolicy {
  if (!isRecord(value)) return DEFAULT_EFFECT_RETRY
  const integer = (field: string, fallback: number, min: number, max: number): number => {
    const candidate = value[field]
    return typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= min && candidate <= max
      ? candidate : fallback
  }
  return {
    maxAttempts: integer('maxAttempts', 3, 1, 5),
    baseDelayMs: integer('baseDelayMs', 1_000, 10, 60_000),
    maxDelayMs: integer('maxDelayMs', 60_000, 10, 24 * 60 * 60_000),
    callTimeoutMs: integer('callTimeoutMs', 30_000, 10, 10 * 60_000),
  }
}

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
  spentBeforeUsd = 0,
): Promise<SeatLoopOutcome> {
  const { charter, paths } = instance
  let judge: SeatResult | null = null
  let worker: SeatResult | null = null
  let corrective: string | undefined = initialPreface
  let correctiveRetries = 0
  let costUsd = 0
  const retried = { schema: false, judge: false, judgeCrash: false, wait: false }
  const retriedProducerGates = new Set<string>()
  const executionPlan = charter.frozen.executionPlan
  const producerRetryEnabled = (id: string): boolean =>
    gateBinding(executionPlan, id)?.retryProducer === 1
  const executionRetryEnabled = (id: 'judge'): boolean =>
    gateBinding(executionPlan, id)?.executionRetry === 1

  for (;;) {
    const progress = await instance.ledger.readProgress()
    const workerLimit = remainingSeatUsd(charter, progress.totalCostUsd, spentBeforeUsd + costUsd)
    if (workerLimit !== undefined && workerLimit <= 0) {
      worker = budgetBlockedSeat('worker skipped: round/lifetime USD budget exhausted')
      seatSummaries['worker'] = worker.summary
      break
    }
    worker = await runWorkerSeat(deps, charter, paths, capsule, corrective, { usd: workerLimit })
    costUsd += worker.costUsd
    seatSummaries['worker'] = truncate(worker.summary)
    deps.observer?.({ type: 'seat_completed', round: capsule.round, seat: 'worker', ok: worker.ok, costUsd: worker.costUsd })
    assertReplaySafeSeat(worker, costUsd)

    // Self-timer park (worker called the timer tool) — takes priority: the
    // worker explicitly parked itself, no external effect involved.
    if (worker.timer) {
      return {
        kind: 'wait', worker, judge: null, correctiveRetries, costUsd,
        waitRequest: { mode: 'self_timer', afterMs: worker.timer.afterMs, reason: worker.timer.reason },
      }
    }
    // Event wait: the worker submitted external work and waits for an event
    // (an events/ file with this effectKey) to conclude it. No probe. Honored
    // ONLY from the structured return_result payload — the free-text JSON
    // fallback could turn a quoted example in prose into an accidental park.
    if (worker.structured && worker.data['label'] === 'wait') {
      const effectKey = typeof worker.data['effectKey'] === 'string' && worker.data['effectKey']
        ? (worker.data['effectKey'] as string)
        : null
      const prepareEventWait = scenarioRuntimeFor(instance.charter).prepareEventWait
      if (effectKey || prepareEventWait) {
        let wait: {
          effectKey: string; payload?: Record<string, unknown>; maxWaitMs: number;
          adapterId?: string; effectBindingId?: string;
          authRequired?: boolean; retryPolicy?: EffectRetryPolicy
        }
        try {
          wait = await prepareEventWait?.(instance, {
            round: capsule.round,
            ...(effectKey ? { effectKey } : {}),
            payload: isRecord(worker.data['payload']) ? worker.data['payload'] : undefined,
            maxWaitMs: eventMaxWaitMs(worker.data['maxWaitMs']),
          }) ?? {
            effectKey: effectKey!,
            payload: isRecord(worker.data['payload']) ? worker.data['payload'] : undefined,
            maxWaitMs: eventMaxWaitMs(worker.data['maxWaitMs']),
            adapterId: typeof worker.data['adapterId'] === 'string'
              ? worker.data['adapterId'] as string : EVENT_EFFECT_ADAPTER_ID,
            effectBindingId: typeof worker.data['effectBinding'] === 'string'
              ? worker.data['effectBinding'] as string : undefined,
            authRequired: worker.data['authRequired'] === true,
            retryPolicy: effectRetryPolicy(worker.data['retryPolicy']),
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!retried.wait && producerRetryEnabled('wait_contract')) {
            retried.wait = true
            corrective = `【纠偏重试】Scenario 拒绝了本次等待：${message}。请修正草稿或等待请求后重新提交。`
            correctiveRetries++
            continue
          }
          worker = { ...worker, ok: false, summary: `Scenario wait preparation failed: ${message}; ${worker.summary}` }
          seatSummaries['worker'] = truncate(worker.summary)
          break
        }
        const requestedBindingId = wait.effectBindingId ?? (
          typeof worker.data['effectBinding'] === 'string' ? worker.data['effectBinding'] as string : undefined
        )
        if (requestedBindingId) {
          const binding = charter.effects[requestedBindingId]
          if (!binding) {
            const message = `EffectBinding '${requestedBindingId}' is not frozen in this Charter`
            if (!retried.wait && producerRetryEnabled('wait_contract')) {
              retried.wait = true
              corrective = `【纠偏重试】${message}。请使用已声明的 effectBinding。`
              correctiveRetries++
              continue
            }
            worker = { ...worker, ok: false, summary: `${message}; ${worker.summary}` }
            seatSummaries['worker'] = truncate(worker.summary)
            break
          }
          wait = { ...wait, adapterId: binding.adapter, effectBindingId: requestedBindingId }
        } else if ((wait.adapterId ?? EVENT_EFFECT_ADAPTER_ID) !== EVENT_EFFECT_ADAPTER_ID) {
          const matching = Object.entries(charter.effects)
            .filter(([, binding]) => binding.adapter === wait.adapterId)
          if (matching.length === 1) wait = { ...wait, effectBindingId: matching[0]![0] }
          else {
            const message = matching.length === 0
              ? `adapter '${wait.adapterId}' is not authorized by a frozen EffectBinding`
              : `adapter '${wait.adapterId}' has multiple bindings; effectBinding is required`
            if (!retried.wait && producerRetryEnabled('wait_contract')) {
              retried.wait = true
              corrective = `【纠偏重试】${message}。`
              correctiveRetries++
              continue
            }
            worker = { ...worker, ok: false, summary: `${message}; ${worker.summary}` }
            seatSummaries['worker'] = truncate(worker.summary)
            break
          }
        }
        try {
          (deps.effectAdapters ?? defaultEffectAdapterRegistry()).resolve(
            wait.adapterId ?? EVENT_EFFECT_ADAPTER_ID,
          )
        } catch (error) {
          // A frozen binding naming an unavailable host adapter is deployment
          // misconfiguration, not worker output the model can repair.
          if (wait.effectBindingId) throw error
          const message = error instanceof Error ? error.message : String(error)
          if (!retried.wait && producerRetryEnabled('wait_contract')) {
            retried.wait = true
            corrective = `【纠偏重试】等待请求引用了不可用的 EffectAdapter：${message}。请改用已注册的 adapterId。`
            correctiveRetries++
            continue
          }
          worker = { ...worker, ok: false, summary: `EffectAdapter validation failed: ${message}; ${worker.summary}` }
          seatSummaries['worker'] = truncate(worker.summary)
          break
        }
        return {
          kind: 'wait', worker, judge: null, correctiveRetries, costUsd,
          waitRequest: {
            mode: 'event',
            ...wait,
            adapterId: wait.adapterId ?? EVENT_EFFECT_ADAPTER_ID,
            effectBindingId: wait.effectBindingId,
            authRequired: wait.authRequired ?? false,
            retryPolicy: wait.retryPolicy ?? effectRetryPolicy(worker.data['retryPolicy']),
          },
        }
      }
      // A wait without an effectKey is unconcludable — the external system
      // cannot guess a kernel-generated key, so the loop would park forever.
      // One corrective retry, then the round hard-fails.
      if (!retried.wait && producerRetryEnabled('wait_contract')) {
        retried.wait = true
        corrective = '【纠偏重试】你声明了 label:"wait" 但没有提供 effectKey。外部系统只能通过 events/<effectKey>.json 了结这次等待，缺少 key 的等待永远不会结束。请重新 return_result：要么带上 {"label":"wait","effectKey":"<外部系统已知的任务标识>"}，要么改用 timer 工具自计时。'
        correctiveRetries++
        continue
      }
      worker = { ...worker, ok: false, summary: `seat requested an event wait without effectKey (rejected): ${worker.summary}` }
      seatSummaries['worker'] = truncate(worker.summary)
    }
    if (!worker.ok) break

    let producerGateFailed = false
    for (const binding of executionPlan.gates.filter(gate => gate.handler === 'scenario')) {
      const gateId = binding.id
      const gate = await scenarioRuntimeFor(instance.charter).runProducerGate(instance, gateId)
      if (gate.verdict !== 'pass' && !retriedProducerGates.has(gateId) && producerRetryEnabled(gateId)) {
        retriedProducerGates.add(gateId)
        corrective = `【纠偏重试】Artifact Gate '${gateId}' 未通过：${gate.messages.join('; ') || '请修正 proposal'}`
        correctiveRetries++
        producerGateFailed = true
        break
      }
      if (gate.verdict !== 'pass') {
        worker = {
          ...worker,
          ok: false,
          summary: `Artifact Gate '${gateId}' failed after corrective retry: ` +
            `${gate.messages.join('; ') || gate.verdict}; ${worker.summary}`,
        }
        seatSummaries['worker'] = truncate(worker.summary)
        break
      }
    }
    if (producerGateFailed) continue
    if (!worker.ok) break

    const schemaErrs = await runSchemaGates(
      instance,
      gateBinding(executionPlan, 'schema')?.gateIds ?? [],
    )
    if (schemaErrs.length > 0 && !retried.schema && producerRetryEnabled('schema')) {
      retried.schema = true
      corrective = `【纠偏重试】state 校验失败：${schemaErrs.join('; ')}`
      correctiveRetries++
      continue
    }
    if (schemaErrs.length > 0) {
      worker = {
        ...worker,
        ok: false,
        summary: `schema gate failed after corrective retry: ${schemaErrs.join('; ')}; ${worker.summary}`,
      }
      seatSummaries['worker'] = truncate(worker.summary)
      break
    }
    if (charter.seats.judge) {
      const judgeLimit = remainingSeatUsd(charter, progress.totalCostUsd, spentBeforeUsd + costUsd)
      if (judgeLimit !== undefined && judgeLimit <= 0) {
        judge = budgetBlockedSeat('judge skipped: round/lifetime USD budget exhausted; drafts rejected')
        seatSummaries['judge'] = judge.summary
        worker = { ...worker, ok: false, summary: `${worker.summary}; ${judge.summary}` }
        break
      }
      const evidence = judgeEvidence(
        charter,
        gateBinding(executionPlan, 'judge')?.gateIds ?? [],
      )
      judge = await runJudgeSeat(deps, charter, paths, evidence, { usd: judgeLimit })
      costUsd += judge.costUsd
      seatSummaries['judge'] = truncate(judge.summary)
      deps.observer?.({ type: 'seat_completed', round: capsule.round, seat: 'judge', ok: judge.ok, costUsd: judge.costUsd })
      assertReplaySafeSeat(judge, costUsd)
      if ((!judge.ok || !judge.structured) && !retried.judgeCrash && executionRetryEnabled('judge')) {
        // A crashed judge (API error / timeout, no verdict) — or one that only
        // produced free text instead of a structured return_result — must not
        // silently pass its gate: one in-round rerun; if it fails again,
        // Artifact commit fails closed instead of admitting unreviewed
        // proposals (unstructured output is never trusted as a verdict).
        retried.judgeCrash = true
        const retryLimit = remainingSeatUsd(charter, progress.totalCostUsd, spentBeforeUsd + costUsd)
        if (retryLimit !== undefined && retryLimit <= 0) {
          judge = budgetBlockedSeat('judge retry skipped: round/lifetime USD budget exhausted; drafts rejected')
          seatSummaries['judge'] = judge.summary
          worker = { ...worker, ok: false, summary: `${worker.summary}; ${judge.summary}` }
          break
        }
        judge = await runJudgeSeat(deps, charter, paths, evidence, { usd: retryLimit })
        costUsd += judge.costUsd
        seatSummaries['judge'] = truncate(judge.summary)
        deps.observer?.({ type: 'seat_completed', round: capsule.round, seat: 'judge', ok: judge.ok, costUsd: judge.costUsd })
        assertReplaySafeSeat(judge, costUsd)
      }
      // Only a structured verdict is a verdict (free-text scrapes are noise).
      const judgeFailed = judge.structured && judge.data['verdict'] === 'fail'
      const failMessages = judgeFailed
        ? (Array.isArray(judge.data['messages']) ? (judge.data['messages'] as unknown[]).map(String) : [])
        : []
      if (judgeFailed && !retried.judge && producerRetryEnabled('judge')) {
        retried.judge = true
        corrective = failMessages.length > 0
          ? `【纠偏重试】评审未通过：\n- ${failMessages.join('\n- ')}`
          : '【纠偏重试】评审未通过（judge 未给出具体纠偏项）。请自查证据链、产出格式和目标达成条件后重做。'
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
  /** Existing self-timer chain state when a harvest segment parks again. */
  priorSelfTimer?: PendingRound
  /** Inbox files this segment consumed — archived once the park is durable. */
  inboxFiles?: string[]
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
    const policy = selfTimerPolicy(instance.charter)
    const parkCount = (input.priorSelfTimer?.parkCount ?? 0) + 1
    // The deadline bounds the SELF-TIMER CHAIN's wallclock, anchored at the
    // first park — not at round start. Anchoring at startedAt would make a
    // round that legitimately spent days in an event wait hit the limit the
    // instant it first parks.
    const waitDeadlineAt = input.priorSelfTimer?.waitDeadlineAt ??
      Date.now() + policy.maxRoundElapsedMs
    const fireAt = Math.min(Date.now() + input.waitRequest.afterMs, waitDeadlineAt)
    await writePendingRound(instance, {
      ...base, kind: 'self_timer', reason: input.waitRequest.reason, fireAt,
      parkCount, waitDeadlineAt,
    } satisfies PendingRound)
    if (input.inboxFiles?.length) await archiveInbox(instance.paths, input.inboxFiles)
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

  const pending = {
    ...base, kind: 'effect' as const,
    effectKey: input.waitRequest.effectKey,
    waitName: 'event',
    expiresAt: Date.now() + input.waitRequest.maxWaitMs,
  } satisfies PendingRound
  // Persist the resumable round before crossing the adapter boundary. A crash
  // after the remote side effect but before ack can then reconcile by effectKey.
  await writePendingRound(instance, pending)
  if (input.inboxFiles?.length) await archiveInbox(instance.paths, input.inboxFiles)
  await submitEffect(instance, deps.wakeStore, {
    effectKey: input.waitRequest.effectKey,
    adapterId: input.waitRequest.adapterId,
    effectBindingId: input.waitRequest.effectBindingId,
    payload: input.waitRequest.payload,
    deadlineAt: Date.now() + input.waitRequest.maxWaitMs,
    retryPolicy: input.waitRequest.retryPolicy,
    authRequired: input.waitRequest.authRequired,
    admission: input.waitRequest.effectBindingId
      ? instance.charter.effects[input.waitRequest.effectBindingId]?.admission
      : undefined,
  }, deps.effectAdapters ?? defaultEffectAdapterRegistry())
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
  carriedCostUsd = 0,
): Promise<RoundOutcome> {
  const { charter, ledger, paths } = instance
  const effects = effectLedgerFor(instance)
  const isSelfTimer = pending.kind === 'self_timer'
  const effectKey = isSelfTimer ? null : pending.effectKey!
  const progress = await ledger.readProgress()
  const mode = normalizeRoundMode(pending.mode)
  const selfTimerLimit = isSelfTimer ? selfTimerLimitState(charter, pending) : null

  // Replay guard: if this round is ALREADY accounted (a crash landed between
  // completeRound's ledger writes and clearPendingRound), re-running the
  // harvest would duplicate the round entry, double the cost, and re-spend on
  // LLM seats. Settle the leftovers instead and resume normal scheduling.
  if (progress.iteration >= pending.round) {
    await clearPendingRound(instance)
    if (effectKey) await effects.markHarvested(effectKey)
    if (progress.status === 'completed' || progress.status === 'paused_attention') {
      await deps.wakeStore.cancelForLoop(instance.record.instanceId)
      await setInstanceStatus(
        instance,
        progress.status === 'completed' ? 'done' : 'paused_attention',
        'settled by harvest replay guard',
      )
    } else {
      await deps.wakeStore.schedule({
        loopId: instance.record.instanceId, kind: 'timer',
        fireAt: Date.now() + (charter.roundIntervalMs ?? 0),
      })
      await setInstanceStatus(instance, 'idle')
      // Aborted-attempt cost carried by this wake belongs to the lifetime USD
      // ledger — park it on the freshly scheduled wake so the next accounted
      // round folds it in instead of dropping it here.
      if (carriedCostUsd > 0) {
        await deps.wakeStore.transferAbortedCost(instance.record.instanceId, carriedCostUsd)
      }
    }
    return {
      round: pending.round, mode,
      route: 'already-accounted', status: progress.status, costUsd: 0,
    }
  }

  deps.observer?.({
    type: 'harvest_started', round: pending.round,
    effectKey: effectKey ?? `self_timer:${pending.reason ?? ''}`,
  })

  // Transactional inbox read (see freshRound): archive only after this
  // segment durably commits (completeRound / the next submitSegment).
  const inbox = await readInbox(paths)
  const capsule = await buildCapsule({
    paths, ledger, goal: charter.goal, round: pending.round, mode,
    inboxMessages: inbox.messages,
  })
  // Lineage digest (D5): the harvest/continue worker knows WHAT it parked on and
  // WHY, via the submit summary — not via a shared transcript.
  let preface: string
  if (isSelfTimer) {
    preface = scenarioRuntimeFor(instance.charter).harvestPreface({
      selfTimer: true,
      reason: pending.reason,
      submitSummary: pending.submitSummary,
    })
    if (selfTimerLimit?.reached) {
      preface += `\n【最终收割】self-timer 已达到确定性上限（${selfTimerLimit.reason}）。` +
        '本段必须停止/取消仍在运行的远端任务并整理现有证据；禁止再次 timer。'
    }
  } else {
    const effect = (await effects.get(effectKey!))!
    preface = scenarioRuntimeFor(instance.charter).harvestPreface({
      selfTimer: false,
      submitSummary: pending.submitSummary,
      effect: effect.outcome,
    })
  }

  const seatSummaries: Record<string, string> = { ...pending.seatSummaries }
  const seatLoop = await runSeatLoop(
    instance, deps, capsule, seatSummaries, preface, pending.costUsdSoFar + carriedCostUsd,
  )
  const costUsd = pending.costUsdSoFar + carriedCostUsd + seatLoop.costUsd

  if (seatLoop.kind === 'wait') {
    // Chained wait / self-timer re-park: same round parks again.
    if (isSelfTimer && selfTimerLimit?.reached && seatLoop.waitRequest?.mode === 'self_timer') {
      const outcome = await terminate(instance, deps, {
        round: pending.round, mode,
        route: {
          kind: 'escalate', cause: 'rule_error',
          reason: `worker attempted to re-park after self-timer limit: ${selfTimerLimit.reason}`,
        },
        startedAt: pending.startedAt,
        costUsd,
        seatSummaries,
        correctiveRetries: pending.correctiveRetries + seatLoop.correctiveRetries,
        observables: {},
        meters: progress.meters,
      })
      await clearPendingRound(instance)
      return outcome
    }
    const outcome = await submitSegment(instance, deps, {
      round: pending.round, mode, startedAt: pending.startedAt,
      costUsd, seatSummaries,
      correctiveRetries: pending.correctiveRetries + seatLoop.correctiveRetries,
      waitRequest: seatLoop.waitRequest!,
      submitSummary: seatLoop.worker?.summary ?? '',
      inboxFiles: inbox.files,
      ...(isSelfTimer && seatLoop.waitRequest?.mode === 'self_timer'
        ? { priorSelfTimer: pending }
        : {}),
    })
    // Settle the OLD effect only after the NEW pending round is durable: the
    // reverse order had a crash window where reconcile saw {old pending ×
    // harvested effect}, dropped the pending, and lost its accumulated
    // costUsdSoFar from the lifetime ledger. A dangling concluded effect is
    // harmless (settled later by reconcileWaiting's no-pending sweep).
    if (effectKey) await effects.markHarvested(effectKey)
    return outcome
  }

  const outcome = await completeRound(instance, deps, {
    round: pending.round, mode, startedAt: pending.startedAt,
    costUsd, seatSummaries,
    correctiveRetries: pending.correctiveRetries + seatLoop.correctiveRetries,
    worker: seatLoop.worker, judge: seatLoop.judge,
    baseProgress: progress,
    inboxFiles: inbox.files,
  })
  // Order matters for crash recovery: round ledger writes happened inside
  // completeRound → clear pending → settle the effect. reconcileWaiting heals
  // every interleaving of a crash between these three.
  await clearPendingRound(instance)
  if (effectKey) await effects.markHarvested(effectKey)
  return outcome
}

function selfTimerPolicy(charter: FrozenCharter): {
  maxParksPerRound: number
  maxRoundElapsedMs: number
} {
  return {
    maxParksPerRound: charter.waitPolicy?.selfTimer?.maxParksPerRound ??
      DEFAULT_SELF_TIMER_MAX_PARKS,
    maxRoundElapsedMs: (charter.waitPolicy?.selfTimer?.maxRoundElapsedMin ??
      DEFAULT_SELF_TIMER_MAX_ELAPSED_MS / 60_000) * 60_000,
  }
}

function selfTimerLimitState(
  charter: FrozenCharter,
  pending: PendingRound,
): { reached: boolean; reason: string } {
  const policy = selfTimerPolicy(charter)
  const parkCount = pending.parkCount ?? 1
  const deadlineAt = pending.waitDeadlineAt ?? pending.startedAt + policy.maxRoundElapsedMs
  if (parkCount >= policy.maxParksPerRound) {
    return { reached: true, reason: `park ${parkCount}/${policy.maxParksPerRound}` }
  }
  // (Legacy pendings without waitDeadlineAt anchor at startedAt via the ??
  // fallback above — new pendings always persist a first-park-anchored value.)
  if (Date.now() >= deadlineAt) {
    return { reached: true, reason: `round wait deadline ${new Date(deadlineAt).toISOString()}` }
  }
  return { reached: false, reason: `park ${parkCount}/${policy.maxParksPerRound}` }
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
  baseProgress: Awaited<ReturnType<LoopInstance['ledger']['readProgress']>>
  /** Inbox files this round consumed — archived after the ledger commit. */
  inboxFiles?: string[]
}

/**
 * Trust boundary for judge output: every field that drives control flow —
 * goal_satisfied (terminates the loop), verdict, metric, charter observables —
 * may ONLY come from the structured return_result payload. A free-text JSON
 * scrape (Seats.extractData fallback) can contain the contract's own example
 * block; treating it as data could accept a loop that never passed review.
 * An unstructured judge is normalized to "ran but emitted nothing": its
 * observables resolve via their onError policies, loudly.
 */
function sanitizeJudge(judge: SeatResult | null): SeatResult | null {
  if (!judge || judge.structured) return judge
  return { ...judge, data: {} }
}

async function completeRound(
  instance: LoopInstance,
  deps: RunRoundDeps,
  input: CompleteInput,
): Promise<RoundOutcome> {
  const { charter, ledger } = instance
  const { baseProgress: progress } = input
  const judge = sanitizeJudge(input.judge)

  // ── 7. METER ──────────────────────────────────────────────────────────────
  const producerOk = input.worker?.ok === true
  const { observables, observationResults, warnings } = collectObservables(
    charter,
    judge,
    producerOk,
  )
  // Budget exhaustion is recomputed WITH this round accounted (iteration+cost),
  // so ROUTE terminates now instead of wasting a wake on an empty next round.
  const totalCostUsd = progress.totalCostUsd + input.costUsd
  const budgetExhausted = lifetimeExhausted(charter, { iteration: input.round, totalCostUsd })
  const counterProjection = runConditionalCounterProjection(
    charter,
    progress.meters,
    observationResults,
    budgetExhausted,
  )
  const meters = counterProjection.meters
  warnings.push(...counterProjection.diagnostics)

  // ── 8. LEDGER: commit gated Artifact proposals, then account the round ────
  const artifactCommit = await scenarioRuntimeFor(instance.charter).commitArtifacts(instance, {
    round: input.round,
    producerOk,
    judgeRequired: !!charter.seats.judge,
    judge,
  })
  const legacyFindingDelta = artifactCommit.legacyFindingDelta
  const objective = evaluateMetricObjective(charter, judge, warnings)
  const metric = objective.value
  const metricImproved = metric !== null && (
    progress.bestMetric === null ||
    (charter.metric?.direction === 'min' ? metric < progress.bestMetric : metric > progress.bestMetric)
  )
  const bestMetric = metricImproved
    ? metric
    : progress.bestMetric

  // ── 9. ROUTE — the SINGLE tripwire evaluation point of the round ──────────
  // Priority: built-in acceptance (judge goal_satisfied → the judgment is the
  // judge's, the decision is the kernel's) ▸ first matching charter tripwire ▸
  // built-in budget backstop ▸ continue.
  const postCtx = buildCtx(meters, observables, budgetExhausted)
  const initialRoute: RouteDecision = objective.failStopReason
    ? { kind: 'escalate', cause: 'rule_error', reason: objective.failStopReason }
    : decideRoute(
        charter,
        postCtx,
        observationResults,
        warnings,
        judge,
        budgetExhausted,
      )
  const { route, status } = applyHealthPolicy(
    initialRoute,
    charter,
    postCtx,
    observationResults,
    warnings,
    meters,
  )
  const postState = {
    iteration: input.round,
    meters,
    status,
    ...(route.kind === 'pivot' ? { nextRoundMode: 'pivot' as const } : {}),
    bestMetric,
    totalFindings: progress.totalFindings + legacyFindingDelta,
    totalCostUsd,
  }

  await ledger.appendRound({
    round: input.round, mode: input.mode, observables, observationResults, meters, route,
    correctiveRetries: input.correctiveRetries, costUsd: input.costUsd,
    seatSummaries: input.seatSummaries,
    startedAt: input.startedAt, finishedAt: Date.now(),
    postState,
    ...(warnings.length > 0 ? { warnings } : {}),
  } satisfies RoundEntry)
  await ledger.writeProgress({
    ...postState,
    updatedAt: Date.now(),
  })
  // Round is durably accounted — NOW the consumed inbox files may be archived
  // (transactional consumption: a crash before this point replays the round
  // with the same feedback; after it, the replay guard settles everything).
  if (input.inboxFiles?.length) await archiveInbox(instance.paths, input.inboxFiles)

  if (route.kind === 'finalize' || route.kind === 'escalate') {
    return terminate(instance, deps, {
      round: input.round, mode: input.mode, route,
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
  const routeText = renderRoute(route)
  deps.observer?.({ type: 'round_completed', round: input.round, route: routeText, status, costUsd: input.costUsd })
  return { round: input.round, mode: input.mode, route: routeText, status, costUsd: input.costUsd }
}

/** ROUTE decision — total over the three tripwire actions + two built-ins. */
function decideRoute(
  charter: FrozenCharter,
  ctx: EvalContext,
  observationResults: Readonly<Record<string, ObservationResult>>,
  warnings: string[],
  judge: SeatResult | null,
  budgetExhausted: boolean,
): RouteDecision {
  // Defense in depth: acceptance requires a STRUCTURED judge verdict — a
  // free-text scrape must never terminate the loop (see sanitizeJudge).
  if (judge?.structured && judge.data['goal_satisfied'] === true) {
    return { kind: 'finalize', cause: 'accepted', reason: 'goal_satisfied' }
  }
  const hit = firstTripwire(charter, ctx, observationResults, warnings)
  if (hit) {
    if (hit.kind === 'fail_stop') {
      return { kind: 'escalate', cause: 'rule_error', reason: hit.reason }
    }
    const { action, index } = hit
    switch (action.act) {
      case 'pivot':
        // Validator guarantees seats.pivoter for v3 charters; a normalized
        // legacy charter without one degrades to continue (cannot pivot).
        return charter.seats.pivoter
          ? { kind: 'pivot', cause: 'tripwire', tripwireIndex: index }
          : { kind: 'continue' }
      case 'finalize':
        return { kind: 'finalize', cause: 'tripwire', tripwireIndex: index, reason: action.reason ?? 'finalize' }
      case 'escalate':
        return { kind: 'escalate', cause: 'tripwire', tripwireIndex: index, reason: action.reason }
    }
  }
  if (budgetExhausted) return { kind: 'finalize', cause: 'budget', reason: 'budget' }
  return { kind: 'continue' }
}

// ── manual stop (loop stop <id>) ──────────────────────────────────────────────

export interface ManualStopDeps {
  wakeStore: WakeStore
  observer?: (event: LoopEvent) => void
  /** Provide a live backend to run the finalizer seat; omitted → code-template report only. */
  seatDeps?: SeatRunnerDeps
}

/**
 * Graceful HUMAN termination — the `loop stop` path. Reuses terminate() so a
 * manual stop is indistinguishable in shape from a tripwire finalize: terminal
 * RoundEntry (route {kind:'finalize', cause:'manual'}), final_report.md,
 * progress 'completed', wakes cancelled, instance 'done'.
 *
 * A parked (waiting) round is abandoned, but NOT silently: its round number,
 * cost-so-far, and seat summaries are folded into the terminal entry, so the
 * ledger accounts for every dollar the abandoned segment spent. The caller is
 * responsible for clearing pending_round (Lifecycle does, before this runs).
 */
export async function stopLoopManually(
  instance: LoopInstance,
  deps: ManualStopDeps,
  reason: string,
  abandoned?: Pick<PendingRound, 'round' | 'mode' | 'costUsdSoFar' | 'seatSummaries' | 'correctiveRetries' | 'startedAt'>,
): Promise<RoundOutcome> {
  const progress = await instance.ledger.readProgress()
  const runDeps: RunRoundDeps = {
    wakeStore: deps.wakeStore,
    ...(deps.observer ? { observer: deps.observer } : {}),
    ...(deps.seatDeps ?? {
      // Stub backend — never invoked because skipFinalizer is set below.
      dispatcher: {
        spawnSubAgent: async () => { throw new Error('manual stop has no backend') },
        getStatus: async () => null,
        cancelTask: async () => true,
      },
      projectDir: instance.record.projectDir,
      signal: new AbortController().signal,
    }),
  }
  return terminate(instance, runDeps, {
    round: abandoned?.round ?? progress.iteration + 1,
    mode: normalizeRoundMode(abandoned?.mode),
    route: { kind: 'finalize', cause: 'manual', reason },
    startedAt: abandoned?.startedAt ?? Date.now(),
    costUsd: abandoned?.costUsdSoFar ?? 0,
    seatSummaries: abandoned?.seatSummaries ?? {},
    correctiveRetries: abandoned?.correctiveRetries ?? 0,
    observables: {},
    meters: progress.meters,
    skipFinalizer: !deps.seatDeps,
  })
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
function firstTripwire(
  charter: FrozenCharter,
  ctx: EvalContext,
  observationResults: Readonly<Record<string, ObservationResult>> = {},
  warnings: string[] = [],
):
  | { kind: 'hit'; action: TripwireAction; index: number }
  | { kind: 'fail_stop'; reason: string }
  | null {
  for (const [i, ast] of charter.frozen.tripwireAsts.entries()) {
    const rule = charter.tripwires[i]!
    const result = evaluateObservationRule(
      ast,
      ctx,
      observationResults,
      rule.onAbsent ?? 'false',
      rule.onError ?? 'false',
      `tripwire[${i}]`,
      warnings,
    )
    if (result.kind === 'fail_stop') return result
    if (result.kind === 'match') return { kind: 'hit', action: rule.then, index: i }
  }
  return null
}

function collectObservables(
  charter: FrozenCharter,
  judge: SeatResult | null,
  producerOk: boolean,
): {
  observables: Record<string, number | boolean | string>
  observationResults: Record<string, ObservationResult>
  warnings: string[]
} {
  const observedAt = Date.now()
  const out: Record<string, number | boolean | string> = {
    [PRODUCER_OK_OBSERVABLE]: producerOk,
  }
  const observationResults: Record<string, ObservationResult> = {
    [PRODUCER_OK_OBSERVABLE]: {
      status: 'present',
      value: producerOk,
      source: `kernel:${PRODUCER_OK_OBSERVABLE}`,
      observedAt,
      provenance: [producerOk ? 'seat.completed:worker' : 'seat.blocked_or_failed:worker'],
    },
  }
  const warnings: string[] = []
  for (const spec of charter.observables) {
    if (spec.source.from !== 'judge') continue
    const v = judge?.data[spec.source.key]
    const source = `judge:${spec.source.key}`
    if (judge === null) {
      observationResults[spec.name] = {
        status: 'absent',
        source,
        observedAt,
        reason: 'not_produced',
        provenance: ['seat.completed:worker'],
      }
    } else if (!judge.ok) {
      observationResults[spec.name] = {
        status: 'error',
        source,
        observedAt,
        errorCode: 'judge_failed',
        message: 'judge did not complete successfully',
        provenance: ['seat.completed:judge'],
      }
      warnings.push(
        `observable '${spec.name}': judge failed; dependent rules use their onError policy`,
      )
    } else if (
      v === null ||
      (typeof v === 'number' && Number.isFinite(v)) ||
      typeof v === 'boolean' ||
      typeof v === 'string'
    ) {
      observationResults[spec.name] = {
        status: 'present',
        value: v,
        source,
        observedAt,
        provenance: ['seat.completed:judge'],
      }
      if (v !== null) out[spec.name] = v
    } else {
      observationResults[spec.name] = {
        status: 'error',
        source,
        observedAt,
        errorCode: 'judge_output_invalid',
        message: `judge omitted or emitted an unsupported value for '${spec.source.key}'`,
        provenance: ['seat.completed:judge'],
      }
      // The judge DID run but never emitted this key. Every declared key is
      // injected into JUDGE_CONTRACT (core or charter-declared extra), so this
      // means the judge disobeyed its contract or crashed mid-output. Silent
      // absence turns every dependent meter/tripwire into a dead rule, so make
      // it loud in the round audit. (judge === null means the worker failed —
      // that case is expected and represented by producer_ok, not warned.)
      const emitted = Object.keys(judge.data).join(', ') || '<none>'
      warnings.push(
        `observable '${spec.name}': judge never emitted key '${spec.source.key}' ` +
        `despite it being demanded by JUDGE_CONTRACT (judge output keys: ${emitted}); ` +
        `dependent meters retained and route/health rules evaluated false this round`,
      )
    }
  }
  return { observables: out, observationResults, warnings }
}

type ObservationRuleResult =
  | { kind: 'match' }
  | { kind: 'no_match' }
  | { kind: 'fail_stop'; reason: string }

function evaluateObservationRule(
  ast: Parameters<typeof evaluateBool>[0],
  ctx: EvalContext,
  observationResults: Readonly<Record<string, ObservationResult>>,
  onAbsent: ObservationFailurePolicy,
  onError: ObservationFailurePolicy,
  label: string,
  warnings: string[],
): ObservationRuleResult {
  try {
    return evaluateBool(ast, ctx) ? { kind: 'match' } : { kind: 'no_match' }
  } catch (err) {
    // Classify only after real evaluation fails. Pre-scanning all refs would
    // incorrectly apply a policy to the unevaluated side of a short-circuit.
    const refs = collectRuleObservationFailures(ast, observationResults)
    const failed = refs.find(item => item.result.status === 'error' || (
      item.result.status === 'present' && item.result.value === null
    ))
    if (failed) {
      const detail = failed.result.status === 'error'
        ? `${failed.name}:${failed.result.errorCode}`
        : `${failed.name}:present-null`
      return applyObservationFailurePolicy(onError, label, 'error', detail, warnings)
    }
    const absent = refs.find(item => item.result.status === 'absent')
    if (absent) {
      return applyObservationFailurePolicy(
        onAbsent,
        label,
        'absent',
        `${absent.name}:${absent.result.status === 'absent' ? absent.result.reason : 'absent'}`,
        warnings,
      )
    }
    return applyObservationFailurePolicy(
      onError,
      label,
      'error',
      (err as Error).message,
      warnings,
    )
  }
}

function collectRuleObservationFailures(
  ast: Parameters<typeof evaluateBool>[0],
  observationResults: Readonly<Record<string, ObservationResult>>,
): Array<{ name: string; result: ObservationResult }> {
  return collectRefs(ast)
    .filter(name => observationResults[name] !== undefined)
    .map(name => ({ name, result: observationResults[name]! }))
}

function applyObservationFailurePolicy(
  policy: ObservationFailurePolicy,
  label: string,
  state: 'absent' | 'error',
  detail: string,
  warnings: string[],
): ObservationRuleResult {
  warnings.push(`${label} ${state} (${detail}); applied ${policy}`)
  return policy === 'fail_stop'
    ? { kind: 'fail_stop', reason: `${label} ${state}: ${detail}` }
    : { kind: 'no_match' }
}

function evaluateMetricObjective(
  charter: FrozenCharter,
  judge: SeatResult | null,
  warnings: string[],
): { value: number | null; failStopReason?: string } {
  const raw = judge?.data['metric']
  if (typeof raw === 'number' && Number.isFinite(raw)) return { value: raw }

  const state: 'absent' | 'error' | 'null' = judge === null
    ? 'absent'
    : !judge.ok || raw !== null
      ? 'error'
      : 'null'
  const policy: ObjectiveFailurePolicy = state === 'absent'
    ? (charter.metric?.onAbsent ?? 'skip_update')
    : state === 'error'
      ? (charter.metric?.onError ?? 'skip_update')
      : (charter.metric?.onNull ?? 'skip_update')
  warnings.push(`objective 'metric' ${state}; applied ${policy}`)
  return policy === 'fail_stop'
    ? { value: null, failStopReason: `objective 'metric' ${state}` }
    : { value: null }
}

async function runSchemaGates(instance: LoopInstance, gateIds: readonly string[]): Promise<string[]> {
  const errs: string[] = []
  for (const gateId of gateIds) {
    const gate = instance.charter.gates?.[gateId]
    if (!gate) {
      errs.push(`frozen schema GateBinding references missing gate '${gateId}'`)
      continue
    }
    if (gate.kind !== 'schema') continue
    for (const rel of gate.files) {
      try {
        const abs = await resolveExistingInside(instance.paths.root, rel)
        const value = JSON.parse(await readFile(abs, 'utf-8')) as unknown
        // spec-less gates exist only in legacy frozen charters. Keep their old
        // parse-only behavior; validateCharter refuses to freeze new ones.
        if (gate.spec) errs.push(...validateShape(value, gate.spec, rel))
      } catch (err) {
        errs.push(`${rel}: ${(err as Error).message}`)
      }
    }
  }
  return errs
}

function validateShape(value: unknown, spec: ShapeSpec, at: string): string[] {
  const errs: string[] = []
  switch (spec.type) {
    case 'null':
      if (value !== null) errs.push(`${at}: expected null`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') errs.push(`${at}: expected boolean`)
      break
    case 'string':
      if (typeof value !== 'string') errs.push(`${at}: expected string`)
      else {
        if (spec.minLength !== undefined && value.length < spec.minLength) errs.push(`${at}: string shorter than ${spec.minLength}`)
        if (spec.enum && !spec.enum.includes(value)) errs.push(`${at}: value is not in enum`)
      }
      break
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || (spec.type === 'integer' && !Number.isInteger(value))) {
        errs.push(`${at}: expected ${spec.type}`)
      } else {
        if (spec.minimum !== undefined && value < spec.minimum) errs.push(`${at}: value is below minimum ${spec.minimum}`)
        if (spec.maximum !== undefined && value > spec.maximum) errs.push(`${at}: value is above maximum ${spec.maximum}`)
      }
      break
    case 'array':
      if (!Array.isArray(value)) errs.push(`${at}: expected array`)
      else {
        if (spec.minItems !== undefined && value.length < spec.minItems) errs.push(`${at}: array has fewer than ${spec.minItems} items`)
        if (spec.items) value.forEach((item, i) => errs.push(...validateShape(item, spec.items!, `${at}[${i}]`)))
      }
      break
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) errs.push(`${at}: expected object`)
      else {
        const record = value as Record<string, unknown>
        for (const key of spec.required ?? []) {
          if (!(key in record)) errs.push(`${at}: missing required property '${key}'`)
        }
        for (const [key, child] of Object.entries(spec.properties ?? {})) {
          if (key in record) errs.push(...validateShape(record[key], child, `${at}.${key}`))
        }
        if (spec.additionalProperties === false) {
          const allowed = new Set(Object.keys(spec.properties ?? {}))
          for (const key of Object.keys(record)) if (!allowed.has(key)) errs.push(`${at}: unknown property '${key}'`)
        }
      }
      break
  }
  return errs
}

function judgeEvidence(charter: FrozenCharter, gateIds: readonly string[]): string[] {
  const evidence: string[] = []
  for (const gateId of gateIds) {
    const gate = charter.gates?.[gateId]
    if (gate?.kind === 'judge') evidence.push(...gate.evidence)
  }
  return [...new Set(evidence)]
}

/**
 * progress.status — a TOTAL function of the RouteDecision. No dead branches:
 * every value has exactly one producer, and 'completed' is written only when
 * the loop actually terminates.
 */
function applyHealthPolicy(
  route: RouteDecision,
  charter: FrozenCharter,
  ctx: EvalContext,
  observationResults: Readonly<Record<string, ObservationResult>>,
  warnings: string[],
  meters: Record<string, number>,
): { route: RouteDecision; status: ProgressStatus } {
  switch (route.kind) {
    case 'finalize': return { route, status: 'completed' }
    case 'escalate': return { route, status: 'paused_attention' }
    case 'pivot': return { route, status: 'pivot_scheduled' }
    case 'continue': {
      const healthAst = charter.frozen.healthAst
      if (healthAst && charter.health) {
        const result = evaluateObservationRule(
          healthAst,
          ctx,
          observationResults,
          charter.health.onAbsent ?? 'false',
          charter.health.onError ?? 'false',
          'health',
          warnings,
        )
        if (result.kind === 'fail_stop') {
          const failedRoute: RouteDecision = {
            kind: 'escalate',
            cause: 'rule_error',
            reason: result.reason,
          }
          return { route: failedRoute, status: 'paused_attention' }
        }
        return { route, status: result.kind === 'match' ? 'stale' : 'healthy' }
      }
      return {
        route,
        status: (meters['stale_count'] ?? 0) > 0 ? 'stale' : 'healthy',
      }
    }
  }
}

interface TerminateInput {
  round: number
  mode: RoundMode
  /** The route that terminated the loop (kind finalize | escalate). */
  route: RouteDecision
  startedAt: number
  costUsd: number
  seatSummaries: Record<string, string>
  correctiveRetries: number
  observables: Record<string, number | boolean | string>
  meters: Record<string, number>
  alreadyAccounted?: boolean
  /** Manual stop without a backend: render the code-template report only. */
  skipFinalizer?: boolean
}

/** Stop path: render the report from the LEDGER (code template, with an
 * optional finalizer-seat narrative on graceful finalize), park the instance,
 * cancel pending wakes. Fail-stop, never fail-silent (D10). */
async function terminate(
  instance: LoopInstance,
  deps: RunRoundDeps,
  input: TerminateInput,
): Promise<RoundOutcome> {
  const { charter, ledger, paths } = instance
  const escalated = input.route.kind === 'escalate'
  const reason = input.route.reason ?? input.route.kind
  const terminalStatus: ProgressStatus = escalated ? 'paused_attention' : 'completed'
  const progressBeforeTerminal = await ledger.readProgress()

  if (!input.alreadyAccounted) {
    const terminalPostState = {
      ...progressBeforeTerminal,
      iteration: Math.max(progressBeforeTerminal.iteration, input.round),
      meters: input.meters,
      status: terminalStatus,
      nextRoundMode: undefined,
      totalCostUsd: progressBeforeTerminal.totalCostUsd + input.costUsd,
    }
    await ledger.appendRound({
      round: input.round, mode: input.mode,
      observables: input.observables, meters: input.meters,
      route: input.route,
      correctiveRetries: input.correctiveRetries, costUsd: input.costUsd,
      seatSummaries: input.seatSummaries,
      startedAt: input.startedAt, finishedAt: Date.now(),
      postState: terminalPostState,
    })
  }

  // Finalizer seat (graceful finalize only): one isolated, tool-less pass that
  // writes the report narrative from inlined ledger evidence. Fail-open — the
  // code-template report renders regardless.
  let narrative: string | undefined
  let finalizerCost = 0
  if (!escalated && !input.skipFinalizer && charter.seats.finalizer) {
    try {
      const fin = await runFinalizerSeat(deps, charter, paths, reason)
      finalizerCost = fin.costUsd
      deps.observer?.({
        type: 'seat_completed', round: input.round, seat: 'finalizer', ok: fin.ok, costUsd: fin.costUsd,
      })
      const text = fin.data['narrative']
      if (fin.ok && typeof text === 'string' && text.trim()) narrative = text.trim()
    } catch { /* narrative stays absent */ }
  }

  // Terminal progress write — covers the not-yet-accounted path (pre-round
  // budget guard) and folds in the finalizer cost, so progress.status can
  // never contradict the instance status again.
  const progress = input.alreadyAccounted ? await ledger.readProgress() : progressBeforeTerminal
  await ledger.writeProgress({
    ...progress,
    // The not-yet-accounted path appended a terminal RoundEntry above — keep
    // iteration consistent with rounds.jsonl (the ledger is the authority).
    ...(input.alreadyAccounted ? {} : { iteration: Math.max(progress.iteration, input.round) }),
    status: terminalStatus,
    nextRoundMode: undefined,
    totalCostUsd: progress.totalCostUsd + (input.alreadyAccounted ? 0 : input.costUsd) + finalizerCost,
    updatedAt: Date.now(),
  })

  // Escalation marker: re-arm (migrate) uses it to reset the offending meters.
  if (escalated && input.route.tripwireIndex !== undefined) {
    instance.record.lastEscalation = {
      tripwireIndex: input.route.tripwireIndex, reason, at: Date.now(),
    }
  }

  const report = await scenarioRuntimeFor(instance.charter).renderReport(instance, reason, narrative)
  const reportName = escalated ? 'attention_report.md' : 'final_report.md'
  await atomicWriteFile(join(paths.reportsDir, reportName), report)
  await deps.wakeStore.cancelForLoop(instance.record.instanceId)
  await setInstanceStatus(
    instance,
    escalated ? 'paused_attention' : 'done',
    `${reason} at round ${input.round}`,
  )
  deps.observer?.({ type: 'terminated', round: input.round, reason, escalated })
  return {
    round: input.round, mode: input.mode,
    route: renderRoute(input.route),
    status: terminalStatus, costUsd: input.costUsd + finalizerCost,
  }
}

function truncate(s: string, n = 300): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
