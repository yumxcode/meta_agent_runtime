/**
 * IntentScheduler — decides WHEN the LLM-backed query-intent analysis runs.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * QueryAnalyzer used to fire a flash side-call on EVERY user input, on the
 * turn's critical path, behind a 5s race. Three things were wrong with that:
 *
 *   1. Cost scaled with conversation length (~876 tok/turn) for a result whose
 *      only consumer is the experience working set.
 *   2. It sat in front of the turn. On a provider slower than 5s the result was
 *      computed, discarded, and paid for — invisibly, on most turns.
 *   3. The information it produces has two different lifetimes, and treating
 *      them alike is what made per-turn analysis look necessary.
 *
 * ── Two lifetimes, two sources ──────────────────────────────────────────────
 *   PROJECT-level  domains / hasHardware / hasSimulation
 *       A locomotion project is still a locomotion project 30 turns later.
 *       Worth an LLM call; worth persisting; NOT worth recomputing per turn.
 *   TURN-level     searchKeywords / intent
 *       "this turn asks about IMU bias" → next turn asks about the MPC solver.
 *       A 10-turn-old LLM keyword set is worse here than fresh heuristics,
 *       because keywords drive candidate RECALL from the experience store.
 *
 * So a refresh takes the whole LLM intent; between refreshes the project-level
 * fields are carried forward and the turn-level fields come from the (free,
 * local) heuristic. Nothing goes stale that shouldn't, nothing is recomputed
 * that needn't be.
 *
 * ── When to refresh ─────────────────────────────────────────────────────────
 * A fixed "every N turns" tick alone samples at points unrelated to the events
 * that matter: switch topic on turn 3 and a 1-in-10 tick leaves the candidate
 * pool pinned to the old domain until turn 11 — precisely the turns where the
 * right experiences matter most. So detection is event-driven, with the tick
 * kept only as a backstop:
 *
 *   first turn        → refresh, BLOCKING (the user is not mid-stream yet, and
 *                       RoboticsSession already blocks here for mode
 *                       classification, so this adds no new round trip)
 *   explicit switch   → refresh (user literally said "new task" / 换个任务)
 *   domain shift      → refresh (heuristic domains disjoint from current)
 *   hardware crossing → refresh (sim → real robot is a different risk regime)
 *   periodic tick     → refresh (backstop for drift the heuristic cannot name)
 *   otherwise         → no LLM call at all
 *
 * Every non-first refresh is BACKGROUND: the result lands for the NEXT turn.
 * That is the correct semantics anyway — the working set is prepared for what
 * comes next, and it keeps flash latency off the critical path permanently.
 *
 * ── What a refresh may and may not trigger ──────────────────────────────────
 * A changed intent refreshes the experience WORKING SET (re-query candidates,
 * re-pick which to inject). It must NEVER trigger knowledge WRITES
 * (experience_write / physical anchor / postSessionExtract). New knowledge
 * comes from experiment results, not from the user changing subject; wiring
 * writes to a topic switch would push unsupported entries into the pending
 * review queue — the one store this system insists a human must gate.
 */

import { heuristicIntent, type QueryIntent } from './QueryAnalyzer.js'
import type { RoboticsDomain } from '../robotics/types.js'

/** Why a refresh was scheduled (or wasn't). Surfaced for diagnostics/tests. */
export type IntentRefreshReason =
  | 'first_turn'
  | 'explicit_switch'
  | 'domain_shift'
  | 'hardware_crossing'
  | 'periodic'
  | 'debounced'
  | 'steady'

export interface IntentDecision {
  refresh: boolean
  /** True only for the first turn: the caller should await the LLM result. */
  blocking: boolean
  reason: IntentRefreshReason
}

/** Matches an explicit, user-stated task switch. Deliberately narrow. */
const EXPLICIT_SWITCH_RE =
  /\b(new task|switch task|different task|another task|unrelated|change topic)\b|换个|另一个|另外一个|新任务|重新开始|换成/

export interface IntentSchedulerOptions {
  /**
   * Backstop: refresh after this many turns with no event. 0 disables the tick
   * entirely (pure event-driven).
   */
  periodicTurns?: number
  /**
   * Minimum turns between two refreshes. Stops a burst of short messages that
   * each look like a domain shift from firing a call apiece.
   */
  minTurnsBetweenRefresh?: number
}

const DEFAULT_PERIODIC_TURNS = 10
const DEFAULT_MIN_TURNS_BETWEEN = 2

/** Project-level slice of an intent — the part worth persisting across sessions. */
export interface ProjectIntent {
  domains: RoboticsDomain[]
  hasHardware: boolean
  hasSimulation: boolean
}

export function projectIntentOf(intent: QueryIntent): ProjectIntent {
  return {
    domains: intent.domains,
    hasHardware: intent.hasHardware,
    hasSimulation: intent.hasSimulation,
  }
}

/** True when the project-level slice actually changed (drives working-set reload). */
export function projectIntentChanged(a: ProjectIntent | null, b: ProjectIntent): boolean {
  if (!a) return true
  if (a.hasHardware !== b.hasHardware || a.hasSimulation !== b.hasSimulation) return true
  const left = [...a.domains].sort().join(',')
  const right = [...b.domains].sort().join(',')
  return left !== right
}

/**
 * Pure decision function. Kept separate from the tracker below so the policy is
 * testable as a table of (turn, prompt, current state) → decision, with no
 * flash client, no clock, and no session.
 */
export function decideIntentRefresh(input: {
  /** 1-based index of the turn being started. */
  turnIndex: number
  /** Turn index of the last refresh, or 0 if none has happened. */
  lastRefreshTurn: number
  /** The project-level intent currently in force, or null when there is none. */
  current: ProjectIntent | null
  /** This turn's raw prompt. */
  prompt: string
  options?: IntentSchedulerOptions
}): IntentDecision {
  const periodicTurns = input.options?.periodicTurns ?? DEFAULT_PERIODIC_TURNS
  const minGap = Math.max(1, input.options?.minTurnsBetweenRefresh ?? DEFAULT_MIN_TURNS_BETWEEN)

  // No intent in force yet — this is the one blocking refresh per session.
  if (!input.current) return { refresh: true, blocking: true, reason: 'first_turn' }

  const sinceLast = input.turnIndex - input.lastRefreshTurn
  const heuristic = heuristicIntent(input.prompt)

  // An explicit switch beats the debounce: if the user says "new task" they
  // mean it, and making them wait two turns for the context to catch up is
  // exactly the frustration this whole mechanism exists to avoid.
  if (EXPLICIT_SWITCH_RE.test(input.prompt.toLowerCase())) {
    return { refresh: true, blocking: false, reason: 'explicit_switch' }
  }

  // `lastRefreshTurn === 0` means "no refresh has happened in this process",
  // which is the normal state of a RESUMED session (it was seeded from disk).
  // Counting the debounce from turn 0 there would silence the very first turn
  // after a resume — exactly when the user is most likely to have moved on to
  // something new since they last closed the session.
  const everRefreshed = input.lastRefreshTurn > 0
  if (everRefreshed && sinceLast < minGap) {
    return { refresh: false, blocking: false, reason: 'debounced' }
  }

  // Domain shift. Only fires when the heuristic NAMED a domain — `general`
  // means "no signal", not "no domain", and must not be read as a shift.
  const named = heuristic.domains.filter(d => d !== 'general')
  const currentNamed = input.current.domains.filter(d => d !== 'general')
  if (named.length > 0 && currentNamed.length > 0) {
    const overlap = named.some(d => currentNamed.includes(d))
    if (!overlap) return { refresh: true, blocking: false, reason: 'domain_shift' }
  }

  // Crossing into real hardware is a different risk regime — the experiences
  // that matter change even when the domain does not.
  if (heuristic.hasHardware && !input.current.hasHardware) {
    return { refresh: true, blocking: false, reason: 'hardware_crossing' }
  }

  if (periodicTurns > 0 && sinceLast >= periodicTurns) {
    return { refresh: true, blocking: false, reason: 'periodic' }
  }

  return { refresh: false, blocking: false, reason: 'steady' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracker
// ─────────────────────────────────────────────────────────────────────────────

/** What `intentForTurn` produced, plus why. */
export interface TurnIntent {
  intent: QueryIntent
  reason: IntentRefreshReason
  /** True when the project-level slice changed on this turn. */
  projectIntentChanged: boolean
}

/** The minimal slice of QueryAnalyzer the tracker needs (keeps tests tiny). */
export interface IntentAnalyzer {
  analyze(query: string): Promise<QueryIntent>
}

export class SessionIntentTracker {
  private turnIndex = 0
  private lastRefreshTurn = 0
  private project: ProjectIntent | null = null
  /** In-flight background refresh, so dispose()/tests can await it. */
  private pending: Promise<void> | null = null
  /**
   * Set when a BACKGROUND refresh moved the project-level intent, cleared when
   * the next turn reports it.
   *
   * Without this latch the whole mechanism is inert after turn one: a
   * background refresh lands between turns, silently updates `project`, and no
   * `intentForTurn` call ever returns `projectIntentChanged: true` — so the
   * candidate pool is never reloaded and the new intent is never persisted.
   * Every refresh except the first is a background one, so that would have been
   * all of them.
   */
  private projectChangedSinceLastTurn = false

  constructor(
    private readonly analyzer: IntentAnalyzer,
    private readonly options: IntentSchedulerOptions = {},
  ) {}

  /**
   * Seed from persisted project state on resume — no LLM call.
   *
   * This is what makes a resumed session cost ZERO intent calls: the project's
   * domains were established when it was first created and were persisted, so
   * the scheduler starts in the 'steady' state rather than 'first_turn'.
   */
  seed(project: ProjectIntent): void {
    this.project = project
  }

  /** Current project-level intent, for persisting into RoboticsProjectState. */
  get projectIntent(): ProjectIntent | null {
    return this.project
  }

  /** @testonly — await any background refresh. */
  async settle(): Promise<void> {
    while (this.pending) {
      const p = this.pending
      await p
      if (this.pending === p) this.pending = null
    }
  }

  /**
   * The intent to use for THIS turn.
   *
   * Awaits the LLM only on the very first turn of a fresh project. Every other
   * turn returns immediately; a scheduled refresh runs in the background and
   * lands for the next turn.
   */
  async intentForTurn(prompt: string): Promise<TurnIntent> {
    this.turnIndex++
    // Consume any change a background refresh produced since the last turn.
    const carriedChange = this.projectChangedSinceLastTurn
    this.projectChangedSinceLastTurn = false
    const decision = decideIntentRefresh({
      turnIndex: this.turnIndex,
      lastRefreshTurn: this.lastRefreshTurn,
      current: this.project,
      prompt,
      options: this.options,
    })

    if (decision.refresh && decision.blocking) {
      this.lastRefreshTurn = this.turnIndex
      // analyze() self-bounds its wait, so even here the turn cannot hang.
      const llm = await this.analyzer.analyze(prompt).catch(() => null)
      const resolved = llm ?? heuristicIntent(prompt)
      const next = projectIntentOf(resolved)
      const changed = projectIntentChanged(this.project, next)
      this.project = next
      return { intent: resolved, reason: decision.reason, projectIntentChanged: changed }
    }

    if (decision.refresh) {
      this.lastRefreshTurn = this.turnIndex
      this.scheduleBackgroundRefresh(prompt)
    }

    return {
      intent: this.merge(prompt),
      reason: decision.reason,
      // A refresh scheduled on THIS turn has not landed yet. What is reported
      // here is the change a PREVIOUS turn's background refresh produced —
      // which is exactly when the working set should be rebuilt, since that is
      // the first turn whose merged intent reflects it.
      projectIntentChanged: carriedChange,
    }
  }

  /**
   * Project-level fields from the last LLM answer, turn-level fields from this
   * turn's heuristic. See the lifetime discussion at the top of the file.
   */
  private merge(prompt: string): QueryIntent {
    const local = heuristicIntent(prompt)
    if (!this.project) return local
    return {
      domains: this.project.domains,
      hasHardware: this.project.hasHardware || local.hasHardware,
      hasSimulation: this.project.hasSimulation || local.hasSimulation,
      searchKeywords: local.searchKeywords,
      intent: local.intent,
    }
  }

  private scheduleBackgroundRefresh(prompt: string): void {
    if (this.pending) return          // one in flight is enough
    const run = this.analyzer
      .analyze(prompt)
      .then(llm => {
        if (!llm) return
        const next = projectIntentOf(llm)
        if (projectIntentChanged(this.project, next)) {
          this.projectChangedSinceLastTurn = true
        }
        this.project = next
      })
      .catch(() => undefined)
      .finally(() => { if (this.pending === run) this.pending = null })
    this.pending = run
  }
}
