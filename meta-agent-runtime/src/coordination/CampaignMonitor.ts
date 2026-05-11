/**
 * CampaignMonitor — non-blocking background phase watcher.
 *
 * Responsibilities:
 *   1. Poll CampaignStateStore until all pending task IDs are cleared.
 *   2. When complete: run ParetoAnalyzer (no LLM) → build Capsule → persist.
 *   3. Transition phase (e.g., EVALUATING_L0 → PARETO_READY_L0).
 *   4. Refresh MetaAgentContextStore so the next session sees the new status.
 *   5. Optionally enqueue a notification via the provided callback.
 *
 * Design constraints:
 *   • Zero LLM calls — deterministic, fast, runs in background.
 *   • Non-blocking: watchAsync() returns immediately; polling runs via setInterval.
 *   • Multiple campaigns can be watched concurrently (one interval per campaign).
 *   • Safe to call watchAsync() multiple times for the same campaign (idempotent).
 */

import { CampaignStateStore } from './CampaignStateStore.js'
import { buildCapsule } from './CapsuleBuilder.js'
import { FidelityLadder } from './FidelityLadder.js'
import type { FidelityLadderConfig } from './FidelityLadder.js'
import { MetaAgentContextStore } from './MetaAgentContextStore.js'
import { ParetoAnalyzer } from './ParetoAnalyzer.js'
import { WorkerCoordinator } from './WorkerCoordinator.js'
import type { EvaluationHandler } from './WorkerCoordinator.js'
import type { CampaignPhase, CampaignSummary } from './types.js'

// ── Configuration ─────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000   // 5 s between state.json reloads
const MAX_POLL_DURATION_MS = 24 * 60 * 60 * 1_000  // 24 h safety ceiling

/** Callback type for user-facing notifications (e.g., CC's enqueuePendingNotification) */
export type NotifyFn = (title: string, body: string) => void

/** Options for watchAsync — Phase 4 additions. */
export interface WatchOptions {
  notify?: NotifyFn
  /**
   * When provided, Monitor can auto-escalate to higher fidelity levels
   * using this handler.  Required for autoEscalate to work.
   */
  evaluationHandler?: EvaluationHandler
  /** Fidelity-ladder configuration (auto-escalation thresholds). */
  ladderConfig?: Partial<FidelityLadderConfig>
  /** Max parallel evaluations during auto-escalation. Default: 4. */
  maxConcurrent?: number
}

// ── Active watchers registry (prevents duplicate intervals) ──────────────────
// WatchOptions are captured in the setInterval closure — no separate map needed.

const _active = new Map<string, NodeJS.Timeout>()

// ── P1-7: Per-campaign consecutive error counter ──────────────────────────────
// Distinguishes transient disk errors (retry silently) from fatal errors (stop).

const _consecutiveErrors  = new Map<string, number>()
const MAX_TRANSIENT_ERRORS = 10   // stop after 10 consecutive transient failures

/** Returns true for OS-level errors that are safe to retry next tick. */
function _isTransientError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ETIMEDOUT' || code === 'EBUSY' || code === 'EAGAIN'
}

// ── Public API ────────────────────────────────────────────────────────────────

export class CampaignMonitor {
  /**
   * Start watching a campaign in the background. Returns immediately.
   * Idempotent — calling again for the same campaignId is a no-op.
   *
   * Phase 4: pass `evaluationHandler` + `ladderConfig` to enable auto-escalation.
   */
  static watchAsync(
    campaignId: string,
    notifyOrOpts?: NotifyFn | WatchOptions,
  ): void {
    if (_active.has(campaignId)) return  // already watching

    // Normalise old single-arg API (notify fn) and new options object
    const opts: WatchOptions =
      typeof notifyOrOpts === 'function'
        ? { notify: notifyOrOpts }
        : (notifyOrOpts ?? {})

    const startedAt = Date.now()

    const interval = setInterval(async () => {
      try {
        await CampaignMonitor._tick(campaignId, opts)
        // Reset consecutive error count on a successful tick
        _consecutiveErrors.delete(campaignId)
      } catch (err) {
        // P1-7: Tiered error handling — transient errors are retried; fatal
        // errors stop the watcher immediately to avoid infinite bad-state loops.
        const consecutive = (_consecutiveErrors.get(campaignId) ?? 0) + 1
        _consecutiveErrors.set(campaignId, consecutive)

        if (_isTransientError(err) && consecutive < MAX_TRANSIENT_ERRORS) {
          console.warn(
            `[CampaignMonitor:${campaignId}] Transient error ` +
            `(${consecutive}/${MAX_TRANSIENT_ERRORS}, will retry next tick):`, err,
          )
        } else {
          console.error(
            `[CampaignMonitor:${campaignId}] ` +
            (_isTransientError(err)
              ? `Too many consecutive transient errors (${consecutive}) — stopping watcher:`
              : `Fatal error — stopping watcher:`),
            err,
          )
          CampaignMonitor._stop(campaignId)
        }
      }

      // Safety: stop watching after 24 h.
      // Mark the campaign FAILED so it doesn't linger as a zombie on disk —
      // a campaign that has been watched for 24 h without reaching a terminal
      // state is stuck (workers died, process restarted, etc.).
      if (Date.now() - startedAt > MAX_POLL_DURATION_MS) {
        try {
          const s = await CampaignStateStore.load(campaignId)
          if (s.phase !== 'DONE' && s.phase !== 'FAILED') {
            await s.markFailed(
              'Watch timeout: campaign did not complete within 24 h of monitoring',
            )
            await CampaignMonitor._refreshContext()
          }
        } catch {
          // best-effort — stop watching regardless
        }
        CampaignMonitor._stop(campaignId)
      }
    }, POLL_INTERVAL_MS)

    // Allow the Node.js process to exit even if this interval is running
    interval.unref?.()
    _active.set(campaignId, interval)
  }

  /** Stop watching a specific campaign. */
  static stop(campaignId: string): void {
    CampaignMonitor._stop(campaignId)
  }

  /** Stop all active watchers. */
  static stopAll(): void {
    for (const id of _active.keys()) {
      CampaignMonitor._stop(id)
    }
  }

  /** Returns true if a watcher is currently active for this campaign. */
  static isWatching(campaignId: string): boolean {
    return _active.has(campaignId)
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private static _stop(campaignId: string): void {
    const interval = _active.get(campaignId)
    if (interval) {
      clearInterval(interval)
      _active.delete(campaignId)
    }
    _consecutiveErrors.delete(campaignId)   // P1-7: clean up error counter
    // Release all per-campaign runtime state (eval cache + mutation lock)
    CampaignStateStore.cleanup(campaignId)
  }

  /**
   * One poll tick: reload state, check completion, act if done.
   */
  private static async _tick(
    campaignId: string,
    opts: WatchOptions,
  ): Promise<void> {
    let store: CampaignStateStore
    try {
      store = await CampaignStateStore.load(campaignId)
    } catch {
      // Campaign directory gone — stop watching
      CampaignMonitor._stop(campaignId)
      return
    }

    // Terminal phases — nothing left to watch
    if (store.phase === 'DONE' || store.phase === 'FAILED') {
      CampaignMonitor._stop(campaignId)
      await CampaignMonitor._refreshContext()
      return
    }

    // Reload to pick up Worker writes
    await store.reload()

    // PARETO_READY phases are user-checkpoint phases.
    // If autoEscalate is enabled and an evaluationHandler is provided,
    // the monitor can automatically escalate without waiting for user input.
    const ladder = new FidelityLadder(opts.ladderConfig ?? {})
    if (
      ladder.autoEscalate &&
      opts.evaluationHandler &&
      (store.phase === 'PARETO_READY_L0' || store.phase === 'PARETO_READY_L1')
    ) {
      await CampaignMonitor._autoEscalate(store, opts, ladder)
      return
    }

    // Phase not complete yet
    if (!store.isCurrentPhaseComplete()) return

    // All tasks done → transition
    await CampaignMonitor._onPhaseComplete(store, opts)
  }

  /**
   * Auto-escalation path: when autoEscalate=true and we're at a PARETO_READY
   * checkpoint, select top-K candidates from the current Pareto front and
   * dispatch them to the next fidelity level via WorkerCoordinator.
   *
   * Flow:
   *   PARETO_READY_L0 → select candidates → ESCALATING_L1 → runParallel(L1)
   *   PARETO_READY_L1 → select candidates → ESCALATING_L2 → runParallel(L2)
   */
  private static async _autoEscalate(
    store: CampaignStateStore,
    opts: WatchOptions,
    ladder: FidelityLadder,
  ): Promise<void> {
    // Stop watcher while we do async work (prevent re-entry)
    CampaignMonitor._stop(store.campaignId)

    try {
      // Get current best-fidelity evaluations and run Pareto analysis
      const evaluations = await store.getBestFidelityEvaluations(true)
      if (evaluations.length === 0) {
        // No evaluations yet — restart watcher and wait
        CampaignMonitor.watchAsync(store.campaignId, opts)
        return
      }

      const analyzer = new ParetoAnalyzer(store.designSpace.objectives)
      const front = analyzer.analyze(evaluations)

      // Plan the escalation: select candidates + determine next phase + fidelity
      const plan = ladder.planEscalation(
        store.phase,
        front,
        store.designSpace.objectives,
      )

      if (!plan || plan.candidates.length === 0) {
        // No escalation path from current phase (e.g., PARETO_READY_L2)
        // Fall through to normal completion handling
        await CampaignMonitor._onPhaseComplete(store, opts)
        return
      }

      const { candidates, targetFidelity, nextPhase } = plan

      // Transition to the ESCALATING phase before dispatching work
      await store.transitionPhase(nextPhase)

      // Dispatch escalation evaluations in parallel via WorkerCoordinator
      const coordinator = new WorkerCoordinator(store, {
        workerId: `escalate_${nextPhase.toLowerCase()}`,
        maxConcurrent: opts.maxConcurrent ?? 4,
      })
      await coordinator.runParallel(candidates, targetFidelity, opts.evaluationHandler!)

      // Refresh context so sessions see the new phase
      await CampaignMonitor._refreshContext()

      // Notify user about escalation
      if (opts.notify) {
        opts.notify(
          `Campaign: ${store.projectName}`,
          `Auto-escalating ${candidates.length} candidates to fidelity L${targetFidelity}`,
        )
      }

      // Restart watcher to poll completion of the new ESCALATING phase
      CampaignMonitor.watchAsync(store.campaignId, opts)
    } catch (err) {
      try {
        await store.transitionPhase('FAILED')
        await store.failTask('__monitor_escalate__', String(err))
      } catch {
        // last-ditch — ignore secondary failure
      }
      if (opts.notify) {
        opts.notify(
          `Campaign failed: ${store.projectName}`,
          `Auto-escalation error: ${String(err).slice(0, 120)}`,
        )
      }
      await CampaignMonitor._refreshContext()
    }
  }

  /**
   * Called when all pending tasks for the current phase have finished.
   * Runs Pareto analysis, builds capsule, transitions phase, refreshes context.
   */
  private static async _onPhaseComplete(
    store: CampaignStateStore,
    opts: WatchOptions,
  ): Promise<void> {
    // Stop interval for this campaign before doing async work
    // (prevents re-entry if work takes > POLL_INTERVAL_MS)
    CampaignMonitor._stop(store.campaignId)

    const { notify } = opts

    try {
      // 1. Collect best-fidelity evaluations for each design point
      const evaluations = await store.getBestFidelityEvaluations(true)

      // 2. Run Pareto analysis (pure algorithm, no LLM)
      const analyzer = new ParetoAnalyzer(store.designSpace.objectives)
      const front = evaluations.length > 0 ? analyzer.analyze(evaluations) : null

      // 3. Build context capsule (deterministic, no LLM)
      const capsule = buildCapsule(store, front)

      // 4. Persist capsule
      await store.saveCapsule(capsule)

      // 5. Transition to next phase
      const nextPhase = CampaignMonitor._nextPhase(store.phase)
      if (nextPhase) {
        await store.transitionPhase(nextPhase)
      }

      // 6. Refresh the global active-context.metaagent
      await CampaignMonitor._refreshContext()

      // 7. Notify user (e.g., via CC's notification system)
      if (notify) {
        notify(
          `Campaign: ${store.projectName}`,
          capsule.contextBlock.split('\n').slice(0, 3).join(' '),
        )
      }

      // 8. If the new phase is also a machine-driven phase (shouldn't happen
      //    given current state machine, but guard anyway), re-watch.
      const newPhase = (await CampaignStateStore.load(store.campaignId)).phase
      if (newPhase !== 'DONE' && newPhase !== 'FAILED') {
        CampaignMonitor.watchAsync(store.campaignId, opts)
      }
    } catch (err) {
      // On unexpected error, mark campaign failed and notify
      try {
        await store.transitionPhase('FAILED')
        // Force-write a failure reason to state
        await store.failTask('__monitor__', String(err))
      } catch {
        // last-ditch — ignore secondary failure
      }
      if (notify) {
        notify(
          `Campaign failed: ${store.projectName}`,
          `Error during phase transition: ${String(err).slice(0, 120)}`,
        )
      }
      await CampaignMonitor._refreshContext()
    }
  }

  /**
   * Re-read all active campaigns and rewrite active-context.metaagent.
   */
  private static async _refreshContext(): Promise<void> {
    const active = await CampaignStateStore.listActive()
    const summaries: CampaignSummary[] = []

    for (const store of active) {
      const capsule = await store.getCapsule()
      if (capsule) {
        summaries.push({
          campaignId: store.campaignId,
          projectName: store.projectName,
          phase: store.phase,
          contextBlock: capsule.contextBlock,
        })
      } else {
        // No capsule yet (early phases) — generate a minimal status line
        summaries.push({
          campaignId: store.campaignId,
          projectName: store.projectName,
          phase: store.phase,
          contextBlock: `### ⏳ Campaign: ${store.projectName} [${store.phase}]\nInitializing...`,
        })
      }
    }

    await MetaAgentContextStore.refresh(summaries)
  }

  /**
   * Determine the next phase after current phase completes.
   * Returns null for terminal and user-checkpoint phases
   * (user-checkpoint phases wait for user input — Monitor doesn't advance them).
   */
  private static _nextPhase(current: CampaignPhase): CampaignPhase | null {
    // Machine-to-ready transitions
    const autoTransitions: Partial<Record<CampaignPhase, CampaignPhase>> = {
      SAMPLING:      'EVALUATING_L0',
      EVALUATING_L0: 'PARETO_READY_L0',
      ESCALATING_L1: 'PARETO_READY_L1',
      ESCALATING_L2: 'PARETO_READY_L2',
      REPORTING:     'DONE',
    }
    return autoTransitions[current] ?? null
  }
}
