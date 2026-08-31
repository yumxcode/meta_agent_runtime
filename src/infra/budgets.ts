/**
 * budgets — the default USD ceilings, as one ordered ladder.
 *
 * ## Why these live together
 *
 * The ceilings are not independent knobs. `AutoCostLedger.tryReserveTask()`
 * reserves a child's **declared cap** against the session ledger *before* the
 * child starts, so a sub-agent can only be admitted while
 *
 *     committedCost + childCap <= sessionBudget
 *
 * holds. That makes the ratios load-bearing: set the per-child cap equal to the
 * session budget and the first reservation fails for the whole run, because the
 * main loop has already committed something. Auto mode admits up to
 * AUTO_MAX_CONCURRENT_SUB_AGENTS (3) children at once, so the session budget has
 * to cover three simultaneous reservations *plus* the main loop's own spend.
 *
 * Scattering these as literals across six modules is what let that invariant go
 * unchecked. They are one table here, and `budgets.test.ts` asserts the ladder.
 *
 * ## Sizing (2026-08-28)
 *
 * Raised from the previous ladder ($20 session / $0.5 child / $1 verify /
 * $0.5 drift), which was sized for pay-per-token billing. Under a token plan the
 * ceiling is a runaway-loop guard, not a cost control, and the old numbers were
 * halting real work: a single auto session legitimately spent $23.73 and then
 * could not resume at all, and $0.50 gates were being cut off mid-investigation.
 *
 * The ceiling that matters for safety is WALL-CLOCK and TURN limits, which are
 * unchanged. A runaway loop hits maxTurns long before it hits $300.
 *
 * ## Note on the session ceiling
 *
 * The session budget is CUMULATIVE ACROSS RESUME — `AgenticBackendFactory`
 * seeds the ledger from the checkpoint's `estimatedCostUsd`. A long-lived auto
 * session therefore consumes its ceiling permanently, and each resume starts
 * with less headroom. That is deliberate (it is what stops an unattended loop
 * from running forever across restarts), but it means the session number needs
 * enough room for a multi-day task, not just one sitting.
 */

// ── Session ──────────────────────────────────────────────────────────────────

/**
 * Whole-session ceiling for unattended auto / simple_auto runs, including every
 * sub-agent and gate it spawns. Cumulative across resume.
 *
 * Sized to cover three concurrent sub-agent reservations (3 × $50) plus the
 * main loop's own spend with real headroom.
 */
export const DEFAULT_AUTO_SESSION_BUDGET_USD = 300

/**
 * Wall-clock allowance for ONE unattended auto run — i.e. one `submitMessage`,
 * not one session. Whichever of this and {@link DEFAULT_AUTO_MAX_TOOL_BATCHES}
 * is reached first ends the run, checkpointed and resumable.
 *
 * It measures the wall clock, so everything the run does counts: model
 * streaming, tool execution (a simulation or test suite can dominate here),
 * sub-agents, and the verify/drift gates.
 *
 * Raised from 2h to 5h. Two hours was too short for the workloads this mode is
 * actually pointed at — engineering and robotics loops where a single tool call
 * is a build or a simulation sweep — and hitting it cost a round trip through
 * the operator every time. The ceiling exists to bound an UNATTENDED run, not to
 * pace a supervised one, and the session USD budget is the real backstop: it is
 * cumulative across resume, so raising a per-run ceiling that resets anyway
 * never widens total spend, it only removes a checkpoint the user had to babysit.
 *
 * Override per run with `META_AGENT_AUTO_MAX_RUNTIME_MIN` (minutes, 1..1440).
 */
export const DEFAULT_AUTO_MAX_RUNTIME_MS = 5 * 60 * 60 * 1000

/**
 * Completed-tool-batch allowance for one unattended auto run.
 *
 * Kept proportional to the wall clock above: raising only the clock would have
 * moved the wall rather than removed it, stopping the same runs at the same
 * point under a different name. Sized off the observed rate (~100 batches in the
 * old 2h window) with headroom.
 *
 * Override with `META_AGENT_AUTO_MAX_TOOL_BATCHES`.
 */
export const DEFAULT_AUTO_MAX_TOOL_BATCHES = 750

/**
 * Ceiling for the sub-agent POOL managed by one SubAgentBridge, when no session
 * ledger owns the budget. Sits below the session ceiling so the main loop keeps
 * a reserve even if children exhaust the pool.
 */
export const DEFAULT_SUB_AGENT_POOL_BUDGET_USD = 200

// ── One child ────────────────────────────────────────────────────────────────

/**
 * Default ceiling for a single sub-agent task.
 *
 * MUST stay well below {@link DEFAULT_AUTO_SESSION_BUDGET_USD}: the full amount
 * is reserved up front, so `session / child` is effectively the concurrency
 * ceiling for children that do not declare their own cap.
 */
export const DEFAULT_SUB_AGENT_BUDGET_USD = 50

/** Research sub-agents fan out over many sources; same class as a sub-agent. */
export const DEFAULT_RESEARCH_BUDGET_USD = 50

/** One node/segment of a graph-loop run. */
export const DEFAULT_GRAPH_SEGMENT_BUDGET_USD = 50

/** One distillation stage. */
export const DEFAULT_DISTILL_STAGE_BUDGET_USD = 50

// ── Gates and reviewers ──────────────────────────────────────────────────────

/**
 * One auto completion-verify judge run.
 *
 * The old $1 was a false economy: a judge that runs out of budget mid-
 * investigation returns no parsable verdict, which the gate reports as
 * "verify unavailable" and auto mode treats as a run-halting failure — so the
 * saving bought a stopped run plus a wasted judge.
 */
export const DEFAULT_VERIFY_BUDGET_USD = 50

/** One auto drift judge run. */
export const DEFAULT_DRIFT_BUDGET_USD = 50

/** One task-review run. */
export const DEFAULT_REVIEW_BUDGET_USD = 50

// ── Turn ceilings ────────────────────────────────────────────────────────────
//
// These belong beside the USD ceilings because the two are only useful in
// proportion. Raising the money without raising the turns does not buy the run
// anything: whichever limit binds first is the one that stops the work, and
// after the 2026-08-28 raise it was overwhelmingly the turns. Measured against
// a real session (~$0.24/turn), a sub-agent capped at 10 turns could reach at
// most ~5% of its $50 ceiling before being force-stopped.
//
// Wall-clock is the limit that actually guards against a runaway loop, and it
// is unchanged (DEFAULT_SUB_AGENT_MAX_DURATION_MS, 30 min, on an independent
// timer). A loop that spins does not get longer to spin because of these
// numbers — it gets stopped by the clock either way. What these buy is room for
// legitimately long work to finish.

/** Default turn ceiling for one sub-agent task. */
export const DEFAULT_SUB_AGENT_MAX_TURNS = 50

/** Turn ceiling for one auto verify / drift judge run. */
export const DEFAULT_JUDGE_MAX_TURNS = 100

/** Turn ceiling for one research run — reads many sources in full. */
export const DEFAULT_RESEARCH_MAX_TURNS = 150

/**
 * Cost of one model turn, in USD, used only to sanity-check the ratios above.
 *
 * Derived from an observed auto session ($23.73 across ~100 turns) and rounded
 * DOWN, so the utilisation figures the ladder test asserts are conservative:
 * a cheaper real turn means a tier reaches even less of its ceiling, which is
 * the direction that matters here.
 */
export const OBSERVED_USD_PER_TURN = 0.2

// ── Invariant ────────────────────────────────────────────────────────────────

/**
 * How many sub-agents auto mode admits at once. Mirrored from
 * `SubAgentBridge.AUTO_MAX_CONCURRENT_SUB_AGENTS` so the ladder test can state
 * the reservation arithmetic without importing the bridge (which would pull the
 * whole session stack into a constants module).
 *
 * Keep the two in sync; `budgets.test.ts` documents why.
 */
export const AUTO_CONCURRENT_SUB_AGENTS = 3
