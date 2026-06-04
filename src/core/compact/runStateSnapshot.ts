/**
 * RunStateSnapshot — persisted recovery state for circuit-breaker exits.
 *
 * Written to disk immediately before MetaAgentSession yields an
 * `error_max_budget` or `error_max_turns` result event.  Allows callers
 * (parent workflows, resumed sessions, retry logic) to understand what
 * was accomplished, what remains, and what should happen next — without
 * having to re-parse the conversation history.
 *
 * Storage:
 *   - When a TaskContract is active:  ~/.meta-agent/tasks/<contractId>/run-state.json
 *   - Standalone (no contract):       ~/.meta-agent/run-state-<sessionId>.json
 *
 * Design invariants:
 *   - Written fire-and-forget; never throws from the caller's perspective.
 *   - Deleted (or superseded) by a successful terminal result so stale
 *     snapshots from prior circuit-breaker hits don't surface on resume.
 *   - Reading returns null on any error so callers can degrade gracefully.
 */

import { readFile, unlink } from 'fs/promises'
import { atomicWriteJson } from '../persist/index.js'
import { join } from 'path'
import { homedir } from 'os'
import { META_AGENT_HOME } from '../metaAgentHome.js'
import type { RuntimeContext } from '../../runtime/RuntimeContext.js'

// ─────────────────────────────────────────────────────────────────────────────
// Type
// ─────────────────────────────────────────────────────────────────────────────

export type RunStateStopReason =
  | 'max_budget'
  | 'max_turns'
  | 'timeout'
  | 'cancelled'

/**
 * Structured recovery state written on circuit-breaker exits.
 *
 * Fields are best-effort — populated from whatever data is available at
 * stop time.  Callers must never rely on completeness; treat as orientation
 * cues for safe resumption.
 */
export interface RunStateSnapshot {
  schemaVersion: '1.0'
  sessionId: string
  /** Linked TaskContract ID, if any was active when the session stopped. */
  taskContractId?: string
  /** ISO 8601 timestamp when the snapshot was written. */
  savedAt: string
  stopReason: RunStateStopReason
  /** Turns completed before the circuit breaker fired. */
  turnsUsed: number
  /** Approximate cost at stop time (USD). */
  costUsd: number
  /**
   * Provenance IDs produced during this session, newest-first.
   * Enables resume logic to call `get_provenance()` on prior work.
   */
  latestProvenanceIds: string[]
  /**
   * Provenance IDs whose V&V produced warnings or failures.
   * Must be reviewed and resolved before safe continuation.
   */
  unresolvedWarnings: string[]
  /**
   * Heuristic: numbered step markers found in accumulated output text.
   * 0 when no step-marker patterns were detected.
   */
  stepsDetected: number
  /**
   * Last 500 characters of accumulated output text at stop time.
   * Gives context for what the session was working on.
   */
  lastTextSlice: string
  /** Human-readable suggestion for resuming safely. */
  recommendedNextAction: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const META_AGENT_DIR = join(META_AGENT_HOME)

function _standaloneSnapshotPath(sessionId: string): string {
  return join(META_AGENT_DIR, `run-state-${sessionId}.json`)
}

function _contractSnapshotPath(contractId: string): string {
  return join(META_AGENT_DIR, 'tasks', contractId, 'run-state.json')
}

export function getRunStateSnapshotPath(
  sessionId: string,
  taskContractId?: string,
): string {
  return taskContractId
    ? _contractSnapshotPath(taskContractId)
    : _standaloneSnapshotPath(sessionId)
}

// ─────────────────────────────────────────────────────────────────────────────
// Step-marker heuristic (shared with SubAgentRunner)
// ─────────────────────────────────────────────────────────────────────────────

const _STEP_RE = /(?:^|\s)(?:##+ )?(?:\*{0,2})step\s+(\d+)(?:\*{0,2})?(?:[:\s—]|$)/gim

function _countSteps(text: string): number {
  const nums = new Set<string>()
  for (const m of text.matchAll(_STEP_RE)) {
    if (m[1]) nums.add(m[1])
  }
  return nums.size
}

// ─────────────────────────────────────────────────────────────────────────────
// Save
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build and persist a `RunStateSnapshot` before a circuit-breaker exit.
 *
 * Fire-and-forget safe — awaiting is optional; errors are swallowed.
 * Callers should `void saveRunStateSnapshot(...).catch(() => {})`.
 */
export async function saveRunStateSnapshot(opts: {
  sessionId: string
  taskContractId?: string
  stopReason: RunStateStopReason
  turnsUsed: number
  costUsd: number
  accumulatedText: string
  sessionStartMs: number
  rtx?: RuntimeContext
}): Promise<void> {
  try {
    const {
      sessionId, taskContractId, stopReason, turnsUsed, costUsd,
      accumulatedText, sessionStartMs, rtx,
    } = opts

    // ── Provenance data ──────────────────────────────────────────────────────
    const latestProvenanceIds: string[] = []
    const unresolvedWarnings: string[] = []

    if (rtx?.provenanceTracker) {
      try {
        const records = await rtx.provenanceTracker.list({ since: sessionStartMs })
        for (const r of [...records].reverse()) {
          latestProvenanceIds.push(r.id)
          const hasIssue = r.validationResults.some(
            v => !v.passed || v.severity === 'warning',
          )
          if (hasIssue) unresolvedWarnings.push(r.id)
        }
      } catch { /* provenanceTracker unavailable */ }
    }

    // ── Recommended action ───────────────────────────────────────────────────
    const recommendedNextAction = _buildRecommendedAction(
      stopReason, turnsUsed, unresolvedWarnings, costUsd,
    )

    const snapshot: RunStateSnapshot = {
      schemaVersion: '1.0',
      sessionId,
      taskContractId,
      savedAt: new Date().toISOString(),
      stopReason,
      turnsUsed,
      costUsd,
      latestProvenanceIds,
      unresolvedWarnings,
      stepsDetected: _countSteps(accumulatedText),
      lastTextSlice: accumulatedText.slice(-500),
      recommendedNextAction,
    }

    const path = getRunStateSnapshotPath(sessionId, taskContractId)
    await atomicWriteJson(path, snapshot)
  } catch {
    // Never propagate — snapshot is advisory
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type predicate that validates all required fields of a `RunStateSnapshot`.
 *
 * Guards against truncated writes (disk-full, crash mid-write) that would
 * produce a valid JSON object with the correct schemaVersion but missing
 * critical fields like `stopReason` or `turnsUsed`.
 */
function _isValidSnapshot(parsed: unknown): parsed is RunStateSnapshot {
  if (typeof parsed !== 'object' || parsed === null) return false
  const p = parsed as Record<string, unknown>
  return (
    p['schemaVersion'] === '1.0' &&
    typeof p['sessionId'] === 'string' && p['sessionId'].length > 0 &&
    typeof p['savedAt'] === 'string' &&
    typeof p['stopReason'] === 'string' &&
    typeof p['turnsUsed'] === 'number' &&
    typeof p['costUsd'] === 'number' &&
    Array.isArray(p['latestProvenanceIds']) &&
    Array.isArray(p['unresolvedWarnings']) &&
    typeof p['stepsDetected'] === 'number' &&
    typeof p['lastTextSlice'] === 'string' &&
    typeof p['recommendedNextAction'] === 'string'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Load
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the most recent run-state snapshot for a session.
 *
 * Checks contract path first (if `taskContractId` provided), then standalone.
 * Returns null if no snapshot exists, is corrupt, or its sessionId does not
 * match the expected session.
 *
 * The sessionId check prevents stale snapshots from a prior session (which
 * shared the same TaskContract via resume) from being mistaken for the current
 * session's circuit-breaker state.
 *
 * @param sessionId       The current session ID to match against.
 * @param taskContractId  Optional contract ID — used to locate contract-scoped
 *                        snapshots (checked before the standalone path).
 */
export async function loadRunStateSnapshot(
  sessionId: string,
  taskContractId?: string,
): Promise<RunStateSnapshot | null> {
  const paths = taskContractId
    ? [_contractSnapshotPath(taskContractId), _standaloneSnapshotPath(sessionId)]
    : [_standaloneSnapshotPath(sessionId)]

  for (const path of paths) {
    try {
      const raw = await readFile(path, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (!_isValidSnapshot(parsed)) continue
      const snap = parsed as RunStateSnapshot
      // Reject snapshots written by a different session (e.g., a prior resume
      // that used the same contract but a different session ID).
      if (snap.sessionId !== sessionId) continue
      return snap
    } catch { /* file missing or corrupt — try next */ }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete any run-state snapshot for a session.
 * Called on successful terminal result so stale snapshots don't mislead
 * resumed sessions about prior circuit-breaker hits.
 */
export async function cleanupRunStateSnapshot(
  sessionId: string,
  taskContractId?: string,
): Promise<void> {
  const paths = taskContractId
    ? [_contractSnapshotPath(taskContractId), _standaloneSnapshotPath(sessionId)]
    : [_standaloneSnapshotPath(sessionId)]

  await Promise.allSettled(paths.map(p => unlink(p)))
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _buildRecommendedAction(
  reason: RunStateStopReason,
  turnsUsed: number,
  unresolvedWarnings: string[],
  costUsd: number,
): string {
  const warnSuffix = unresolvedWarnings.length > 0
    ? ` Review unresolved V&V warnings (${unresolvedWarnings.length}) before continuing.`
    : ''

  switch (reason) {
    case 'max_budget':
      return (
        `Session stopped after ${turnsUsed} turns ($${costUsd.toFixed(4)}) due to budget limit. ` +
        `Increase maxBudgetUsd or resume with a higher allowance.${warnSuffix}`
      )
    case 'max_turns':
      return (
        `Session stopped after ${turnsUsed} turns (turn limit reached). ` +
        `Call submit() again to continue; the task history is preserved.${warnSuffix}`
      )
    case 'timeout':
      return (
        `Session timed out after ${turnsUsed} turns. ` +
        `Resume with a new submit() call.${warnSuffix}`
      )
    case 'cancelled':
      return (
        `Session was cancelled after ${turnsUsed} turns. ` +
        `Inspect the snapshot and restart if needed.${warnSuffix}`
      )
  }
}
