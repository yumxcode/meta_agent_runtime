/**
 * Pre-compact state snapshot for the KernelBridge path.
 *
 * Problem:
 *   KernelBridge builds `## Compact Instructions` at the START of each
 *   submit() call, before any tool calls happen.  When CC auto-compacts
 *   mid-turn (after several tool calls), the instructions already written
 *   into the system prompt are stale — they're missing every provenance
 *   record produced during that turn.
 *
 * Solution:
 *   After every tool call (via the `wrapMetaAgentTool` hook) we fire a
 *   fire-and-forget save of the current session state to a JSON file at
 *   ~/.claude/meta-agent/compact-state-<sessionId>.json.
 *   When `_buildEnrichedSuffix()` rebuilds compact instructions it loads
 *   the snapshot and merges any provenance IDs that don't yet appear in
 *   the live tracker.  The snapshot is deleted on interrupt().
 *
 * Used by:
 *   KernelBridge — wrapMetaAgentTool (post-call hook) + _buildEnrichedSuffix
 *   MetaAgentSession — pre-compact save before runCompact()
 *   buildCompactInstructions — snapshot parameter for merge
 */

import { readFile, writeFile, unlink, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { homedir } from 'os'
import type { RuntimeContext } from '../../runtime/RuntimeContext.js'
import { MetaAgentContextStore } from '../../coordination/MetaAgentContextStore.js'
import { CampaignStateStore } from '../../coordination/CampaignStateStore.js'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single provenance record snapshot (minimal — only what compact needs). */
export type CompactStateSnapshotRecord = {
  id: string
  toolName: string
  fidelityLevel: number
  /** V&V pass/warn/fail */
  vv: '✓' | '⚠' | '✗'
  /** Short key=val summary of the 3 most significant inputs */
  inputSummary: string
}

/** Minimal campaign state snapshot (phase + identity + drift-guard fields). */
export type CompactStateSnapshotCampaign = {
  campaignId: string
  projectName: string | undefined
  phase: string
  /**
   * Pre-rendered contextBlock from the campaign capsule.
   * Reproduced verbatim in compact instructions so the compact model has the
   * full campaign state even when no live context store is available.
   */
  contextBlock?: string
  /**
   * Human-readable objective strings, e.g. "maximize efficiency (W/kg)".
   * Preserved across compaction so the model never forgets what it is optimising.
   */
  objectives?: string[]
  /**
   * Human-readable constraint strings, e.g. "mass ≤ 5.0 kg (inequality)".
   * Preserved across compaction to prevent drift from constraint-violating proposals.
   */
  constraints?: string[]
}

/** Full snapshot written to disk after each tool call. */
export type CompactStateSnapshot = {
  sessionId: string
  /** Unix timestamp (ms) when this snapshot was written. */
  capturedAt: number
  provenanceRecords: CompactStateSnapshotRecord[]
  activeCampaigns: CompactStateSnapshotCampaign[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const SNAPSHOT_DIR = join(homedir(), '.claude', 'meta-agent')

export function getSnapshotPath(sessionId: string): string {
  return join(SNAPSHOT_DIR, `compact-state-${sessionId}.json`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Write serializer — per-session promise chain (Fix #2)
//
// Concurrent fire-and-forget saves from parallel tool calls (Promise.all) would
// overlap on the same file path.  Node's writeFile is not atomic: two in-flight
// writes can interleave and corrupt the JSON.  We serialise with a per-session
// chain so writes are always sequential.  Only the latest snapshot matters, so
// any queued (not-yet-started) write can be replaced by the newest call.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-session write chain: sessionId → Promise<void> tail.
 * Entries are created on first save and deleted on cleanupStateSnapshot().
 */
const _writeChains = new Map<string, Promise<void>>()

/**
 * True once a snapshot dir failure has been logged, to avoid log spam.
 * Reset per process (acceptable — the error won't go away mid-process anyway).
 */
let _dirFailureLogged = false

// ─────────────────────────────────────────────────────────────────────────────
// Save
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capture current session state and enqueue a serialised disk write.
 *
 * Fix #2 (concurrent writes): instead of firing an independent Promise per
 * tool call, we chain each write behind the previous one for this sessionId.
 * Only the last write in the chain actually matters, so we don't try to
 * coalesce — the overhead of a redundant write is negligible compared to the
 * correctness benefit of never interleaving writes to the same file.
 *
 * Fix #7 (silent mkdir failure): the first write failure is logged once so
 * operators can detect a misconfigured home directory.
 *
 * Fire-and-forget safe: this function never throws.  Callers should use
 * `void saveStateSnapshot(...).catch(() => {})`.
 */
export function saveStateSnapshot(
  sessionId: string,
  rtx: RuntimeContext | undefined,
  sessionStartMs: number,
): Promise<void> {
  // Build the actual write as a closure — evaluated lazily when its turn comes.
  const doWrite = async (): Promise<void> => {
    try {
      const snapshot: CompactStateSnapshot = {
        sessionId,
        capturedAt: Date.now(),
        provenanceRecords: [],
        activeCampaigns: [],
      }

      // Collect provenance records
      if (rtx?.provenanceTracker) {
        try {
          const records = await rtx.provenanceTracker.list({ since: sessionStartMs })
          for (const r of records) {
            const hasFailure = r.validationResults.some(v => !v.passed)
            const hasWarning = r.validationResults.some(v => v.passed && v.severity === 'warning')
            const vv: '✓' | '⚠' | '✗' = hasFailure ? '✗' : hasWarning ? '⚠' : '✓'
            const inputSummary = Object.entries(r.input ?? {})
              .slice(0, 3)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(', ')
            snapshot.provenanceRecords.push({
              id: r.id,
              toolName: r.toolName,
              fidelityLevel: r.fidelityLevel,
              vv,
              inputSummary,
            })
          }
        } catch { /* provenanceTracker unavailable — skip */ }
      }

      // Collect active campaigns
      // Strategy: read CampaignSummary list from MetaAgentContextStore for phase/contextBlock,
      // then attempt a CampaignStateStore.load() per campaign for objectives/constraints.
      // Failures at any level are swallowed — the snapshot is advisory.
      try {
        const ctx = await MetaAgentContextStore.read()
        if (ctx?.activeCampaigns) {
          // Parallel-load per-campaign design space (objectives + constraints).
          // Each individual load failure is caught inside the map so one broken
          // campaign never blocks others.
          const enriched = await Promise.all(
            ctx.activeCampaigns.map(async c => {
              const base: CompactStateSnapshotCampaign = {
                campaignId: c.campaignId,
                projectName: c.projectName,
                phase: c.phase,
                contextBlock: c.contextBlock,
              }
              try {
                const store = await CampaignStateStore.load(c.campaignId)
                const { objectives, constraints } = store.designSpace
                base.objectives = objectives.map(o =>
                  `${o.direction} ${o.name}${o.unit ? ` (${o.unit})` : ''}`,
                )
                base.constraints = constraints.map(ct =>
                  `${ct.name}: ${ct.expression} (${ct.type})`,
                )
              } catch { /* state file missing or corrupt — skip enrichment */ }
              return base
            }),
          )
          snapshot.activeCampaigns.push(...enriched)
        }
      } catch { /* context store unavailable — skip */ }

      const path = getSnapshotPath(sessionId)
      try {
        await mkdir(dirname(path), { recursive: true })
      } catch (err) {
        // Fix #7: log the first failure so it's discoverable, then stay silent.
        if (!_dirFailureLogged) {
          _dirFailureLogged = true
          console.error('[meta-agent] snapshot dir unavailable — provenance backfill disabled:', err)
        }
        return
      }
      await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf-8')
    } catch {
      // Never propagate — snapshot is advisory
    }
  }

  // Serialise behind the previous write for this session (Fix #2).
  const prev = _writeChains.get(sessionId) ?? Promise.resolve()
  const next = prev.then(doWrite)
  _writeChains.set(sessionId, next)
  return next
}

// ─────────────────────────────────────────────────────────────────────────────
// Load
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load a previously saved snapshot.  Returns null if no snapshot exists or
 * if the file is corrupt / unreadable.
 */
export async function loadStateSnapshot(
  sessionId: string,
): Promise<CompactStateSnapshot | null> {
  try {
    const path = getSnapshotPath(sessionId)
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)['sessionId'] !== 'string'
    ) {
      return null
    }
    return parsed as CompactStateSnapshot
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete the snapshot file for a session and remove its write chain.
 * Called on interrupt() so stale state from a cancelled turn isn't picked up
 * by a subsequent submit().
 */
export async function cleanupStateSnapshot(sessionId: string): Promise<void> {
  // Remove chain entry so a future session with the same ID (unlikely but
  // possible) starts fresh rather than queuing behind old writes.
  _writeChains.delete(sessionId)
  try {
    await unlink(getSnapshotPath(sessionId))
  } catch {
    // File may not exist — silently ignore
  }
}
