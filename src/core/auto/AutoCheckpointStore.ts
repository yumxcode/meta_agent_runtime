/**
 * AutoCheckpointStore — durable progress snapshot for auto (unattended) sessions.
 *
 * An auto run can hit its budget/turn cap, the stall circuit, or a crash with no
 * human watching. A checkpoint at
 * `<workspace>/.meta-agent/auto/checkpoints/<sessionId>.json` lets a later
 * `--resume` recover the goal, what's done, what's pending, and which sub-agents
 * were in flight — instead of starting from zero.
 *
 * This module is pure I/O over one JSON file: write is atomic (tmp + rename),
 * read is tolerant (returns null on missing/corrupt). It is independent of the
 * session/loop, so it is trivially testable and carries no coupling to modes.
 * The older workspace-singleton path is read only as a legacy fallback when its
 * embedded sessionId matches the requested session.
 */
import { existsSync, readFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { atomicWriteJson } from '../../infra/persist/index.js'

export const AUTO_CHECKPOINT_SCHEMA_VERSION = '1.1'
const MAX_GOAL_CHARS = 8_000
const MAX_NOTE_CHARS = 4_000
const MAX_ITEM_CHARS = 500
const MAX_COMPLETED_STEPS = 200
const MAX_PENDING_TODOS = 100
const MAX_ACTIVE_SUBAGENTS = 100
const MAX_ARTIFACTS = 200

export interface AutoCheckpoint {
  schemaVersion: string
  sessionId: string
  /** Epoch ms of the last update. */
  updatedAt: number
  /** Monotonic durable-write revision. */
  revision?: number
  /** Most recent execution boundary that produced this revision. */
  lastBoundary?: string
  /** The original task — the first real user request, captured once. */
  goal?: string
  /** Short free-form progress note / latest summary. */
  note?: string
  /**
   * Auto-generated one-line digest of recent file edits, produced when the agent
   * mutates files for a long stretch without writing a todo/progress update.
   * Gives the drift gate a real anchor when the explicit state fields are empty.
   */
  autoEditSummary?: string
  /** Steps already completed (durable, append-only across turns). */
  completedSteps?: string[]
  /** Outstanding to-dos at checkpoint time. */
  pendingTodos?: string[]
  /** Sub-agent task IDs that were active/queued at checkpoint time. */
  activeSubAgentIds?: string[]
  /** Key artifact paths produced so far (relative or absolute). */
  artifacts?: string[]
  /** Best-effort turn count and cost for observability. */
  turnCount?: number
  estimatedCostUsd?: number
  /** Why the run stopped, when known (e.g. 'max_budget_usd', 'max_turns'). */
  stopReason?: string
  // ── Run-health counters (monotonic, deterministic) ────────────────────────
  // Lifecycle signals the drift gate uses to judge run TRAJECTORY, not just the
  // current state: repeated corrections with no progress = stalling; a recent
  // verify rejection = the agent thought it was done but wasn't; a compaction =
  // possible loss of goal context. All incremented in the coordinator, no LLM.
  /** How many times the verify gate rejected a "done" claim. */
  verifyRejections?: number
  /** How many times the drift gate injected a course correction. */
  driftCorrections?: number
  /** How many compactions occurred (counted once per compaction). */
  compactions?: number
  /** turnCount at the most recent verify rejection (recency for drift). */
  lastVerifyRejectTurn?: number
  /** turnCount at the most recent drift correction (recency for drift). */
  lastDriftCorrectionTurn?: number
}

function checkpointFilename(sessionId: string): string {
  return encodeURIComponent(sessionId)
}

/** Absolute path of a session-scoped auto checkpoint file. */
export function autoCheckpointPath(workspaceRoot: string, sessionId: string): string {
  return join(
    resolve(workspaceRoot),
    '.meta-agent',
    'auto',
    'checkpoints',
    `${checkpointFilename(sessionId)}.json`,
  )
}

/** Legacy workspace-singleton checkpoint path used by older runtime versions. */
export function legacyAutoCheckpointPath(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), '.meta-agent', 'auto', 'checkpoint.json')
}

/**
 * Atomically write the checkpoint. Best-effort: never throws (returns false on
 * failure) so a checkpoint write can never crash the run it is protecting.
 */
export async function writeAutoCheckpoint(
  workspaceRoot: string,
  checkpoint: AutoCheckpoint,
): Promise<boolean> {
  try {
    const path = autoCheckpointPath(workspaceRoot, checkpoint.sessionId)
    await atomicWriteJson(path, checkpoint)
    return true
  } catch {
    return false
  }
}

/**
 * Build a recovery preamble injected into the model's context on `--resume` of
 * an auto session. Unlike the CLI banner (which is shown only to the human), this
 * goes to the model so the resumed run actually knows where it left off: the
 * original goal, what was already done, what's still pending, and which
 * sub-agents were in flight. Returns null when there is nothing useful to inject.
 */
export function buildAutoResumePreamble(cp: AutoCheckpoint | null): string | null {
  if (!cp) return null
  const lines: string[] = []
  if (cp.goal) lines.push(`原始目标：${cp.goal}`)
  if (cp.completedSteps?.length) {
    lines.push(`已完成：\n${cp.completedSteps.map(s => `  - ${s}`).join('\n')}`)
  }
  if (cp.pendingTodos?.length) {
    lines.push(`未完成待办：\n${cp.pendingTodos.map(s => `  - ${s}`).join('\n')}`)
  }
  if (cp.artifacts?.length) {
    lines.push(`已产出文件（需要时直接读取，不要重做）：\n${cp.artifacts.map(s => `  - ${s}`).join('\n')}`)
  }
  if (cp.activeSubAgentIds?.length) {
    lines.push(`上次在途的子代理：${cp.activeSubAgentIds.join(', ')}`)
  }
  if (cp.stopReason) lines.push(`上次停止原因：${cp.stopReason}`)
  if (lines.length === 0) return null
  return (
    '[系统·会话恢复] 这是一次被恢复的自动(auto)会话。以下是上次中断时的进度快照，' +
    '请在此基础上继续，不要从零重来：\n\n' +
    lines.join('\n') +
    '\n\n请先用一句话确认你的下一步，然后继续推进未完成的部分。'
  )
}

function isAutoCheckpoint(value: unknown): value is AutoCheckpoint {
  if (!value || typeof value !== 'object') return false
  const cp = value as Partial<AutoCheckpoint>
  return typeof cp.sessionId === 'string' && typeof cp.updatedAt === 'number'
}

/** Read this session's checkpoint, or null when missing / unreadable / wrong shape. */
export function readAutoCheckpoint(workspaceRoot: string, sessionId: string): AutoCheckpoint | null {
  try {
    const path = autoCheckpointPath(workspaceRoot, sessionId)
    if (!existsSync(path)) {
      const legacyPath = legacyAutoCheckpointPath(workspaceRoot)
      if (!existsSync(legacyPath)) return null
      const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8')) as unknown
      // Backward-compatible migration read: only accept the old workspace-level
      // checkpoint when it belongs to the requested session.
      return isAutoCheckpoint(legacy) && legacy.sessionId === sessionId
        ? legacy
        : null
    }
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return isAutoCheckpoint(parsed) && parsed.sessionId === sessionId
      ? parsed
      : null
  } catch {
    return null
  }
}

async function readAutoCheckpointAsync(workspaceRoot: string, sessionId: string): Promise<AutoCheckpoint | null> {
  try {
    const path = autoCheckpointPath(workspaceRoot, sessionId)
    if (!existsSync(path)) {
      const legacy = JSON.parse(
        await readFile(legacyAutoCheckpointPath(workspaceRoot), 'utf-8'),
      ) as unknown
      return isAutoCheckpoint(legacy) && legacy.sessionId === sessionId
        ? legacy
        : null
    }
    const parsed = JSON.parse(
      await readFile(path, 'utf-8'),
    ) as unknown
    return isAutoCheckpoint(parsed) && parsed.sessionId === sessionId
      ? parsed
      : null
  } catch {
    return null
  }
}

/**
 * Merge an update into the existing checkpoint (or create a fresh one), bumping
 * updatedAt and unioning the append-only lists. Returns the written checkpoint.
 */
export async function updateAutoCheckpoint(
  workspaceRoot: string,
  sessionId: string,
  patch: Partial<Omit<AutoCheckpoint, 'schemaVersion' | 'sessionId' | 'updatedAt'>>,
): Promise<AutoCheckpoint> {
  return (await updateAutoCheckpointWithStatus(workspaceRoot, sessionId, patch)).checkpoint
}

export interface AutoCheckpointUpdateResult {
  checkpoint: AutoCheckpoint
  written: boolean
}

/**
 * Status-returning variant for callers whose control flow depends on durable
 * persistence. A failed write returns the proposed checkpoint with
 * `written: false`; callers must not advance their durable revision.
 */
export async function updateAutoCheckpointWithStatus(
  workspaceRoot: string,
  sessionId: string,
  patch: Partial<Omit<AutoCheckpoint, 'schemaVersion' | 'sessionId' | 'updatedAt'>>,
): Promise<AutoCheckpointUpdateResult> {
  const priorOnDisk = await readAutoCheckpointAsync(workspaceRoot, sessionId)
  // Checkpoints are session-scoped. Keep the sessionId check as
  // defense-in-depth for legacy fallback/corrupt manual edits.
  const prior = priorOnDisk?.sessionId === sessionId ? priorOnDisk : null
  const bounded = (items: string[] | undefined, max: number): string[] | undefined => {
    if (!items) return undefined
    return items
      .map(item => item.slice(0, MAX_ITEM_CHARS))
      .filter(Boolean)
      .slice(-max)
  }
  const union = (a: string[] | undefined, b: string[] | undefined, max: number): string[] | undefined => {
    if (!a && !b) return undefined
    return bounded([...new Set([...(a ?? []), ...(b ?? [])])], max)
  }
  const maxDefined = (a?: number, b?: number): number | undefined => {
    if (a === undefined) return b
    if (b === undefined) return a
    return Math.max(a, b)
  }
  const next: AutoCheckpoint = {
    schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
    sessionId,
    updatedAt: Date.now(),
    revision: (prior?.revision ?? 0) + 1,
    lastBoundary: patch.lastBoundary ?? prior?.lastBoundary,
    goal: (patch.goal ?? prior?.goal)?.slice(0, MAX_GOAL_CHARS),
    note: (patch.note ?? prior?.note)?.slice(0, MAX_NOTE_CHARS),
    // Latest-wins: a fresh edit digest replaces the old one; otherwise it persists
    // so the drift gate always sees the most recent recap of file edits.
    autoEditSummary: (patch.autoEditSummary ?? prior?.autoEditSummary)?.slice(0, MAX_NOTE_CHARS),
    completedSteps: union(prior?.completedSteps, patch.completedSteps, MAX_COMPLETED_STEPS),
    // pendingTodos / activeSubAgentIds reflect the latest state, not a union.
    pendingTodos: bounded(
      patch.pendingTodos !== undefined ? patch.pendingTodos : prior?.pendingTodos,
      MAX_PENDING_TODOS,
    ),
    activeSubAgentIds:
      bounded(
        patch.activeSubAgentIds !== undefined ? patch.activeSubAgentIds : prior?.activeSubAgentIds,
        MAX_ACTIVE_SUBAGENTS,
      ),
    artifacts: union(prior?.artifacts, patch.artifacts, MAX_ARTIFACTS),
    // turnCount is monotonic: a resumed run restarts its in-memory counter from
    // 1, so take the max to avoid regressing the accumulated total on resume.
    turnCount: maxDefined(prior?.turnCount, patch.turnCount),
    estimatedCostUsd: patch.estimatedCostUsd ?? prior?.estimatedCostUsd,
    stopReason: patch.stopReason ?? prior?.stopReason,
    // Run-health counters use latest-wins, not max: the coordinator always writes
    // its absolute current value (so they climb monotonically during a task), and
    // a re-anchor deliberately resets them to 0 for the new goal — which max would
    // wrongly block. A write that omits them keeps the prior value.
    verifyRejections: patch.verifyRejections ?? prior?.verifyRejections,
    driftCorrections: patch.driftCorrections ?? prior?.driftCorrections,
    compactions: patch.compactions ?? prior?.compactions,
    lastVerifyRejectTurn: patch.lastVerifyRejectTurn ?? prior?.lastVerifyRejectTurn,
    lastDriftCorrectionTurn: patch.lastDriftCorrectionTurn ?? prior?.lastDriftCorrectionTurn,
  }
  return {
    checkpoint: next,
    written: await writeAutoCheckpoint(workspaceRoot, next),
  }
}
